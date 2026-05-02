import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { EClawClient } from "./eclaw-client.js";
import { ApprovalRouter } from "./approval-router.js";
import { sanitizeCodexModel } from "./model.js";
import { parseBridgeCommand, shouldIgnoreInbound, isBridgeCommand } from "./payload.js";
import { redactSensitiveText } from "./redact.js";
import { SessionManager } from "./session-manager.js";
import { StateStore } from "./state-store.js";
import type { BridgeConfig, EClawCard, EClawInboundPayload } from "./types.js";

const MODEL_PICKER_ASK_ID = "codex_model_picker";
const MODEL_OPTIONS = [
  { id: "gpt-5.5", label: "GPT-5.5", style: "primary" },
  { id: "gpt-5.4", label: "GPT-5.4", style: "secondary" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", style: "secondary" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", style: "secondary" },
] as const;

export type BridgeAppDeps = {
  config: BridgeConfig;
  codex: CodexClient;
  eclaw: EClawClient;
  stateStore: StateStore;
  sessionManager: SessionManager;
  approvalRouter: ApprovalRouter;
};

export function createApp(deps: BridgeAppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", async (_req, res) => {
    const state = await deps.stateStore.read();
    res.json({
      ok: true,
      codex: deps.codex.status(),
      session: deps.sessionManager.status(),
      approvals: deps.approvalRouter.status(),
      eclaw: {
        deviceId: state.deviceId,
        entityId: state.entityId,
        publicCode: state.publicCode,
        bound: !!state.botSecret,
      },
    });
  });

  app.get("/status", async (_req, res) => {
    const state = await deps.stateStore.read();
    res.json({
      state: redactState(state),
      codex: deps.codex.status(),
      session: deps.sessionManager.status(),
      approvals: deps.approvalRouter.status(),
    });
  });

  app.post("/ask", async (req, res) => {
    try {
      const state = await deps.stateStore.read();
      const payload = {
        event: "message",
        from: req.body?.from ?? "local-ask",
        deviceId: req.body?.deviceId ?? state.deviceId ?? "local",
        entityId: Number(req.body?.entityId ?? state.entityId ?? 0),
        text: String(req.body?.text ?? ""),
        timestamp: Date.now(),
        eclaw_context: req.body?.eclaw_context,
      } satisfies EClawInboundPayload;

      if (deps.approvalRouter.resolveFromPayload(payload)) {
        res.json({ success: true, handled: "approval" });
        return;
      }
      if (await handleModelPickerAction(deps, payload)) {
        res.json({ success: true, handled: "model_picker" });
        return;
      }

      if (isBridgeCommand(payload.text ?? "")) {
        await handleBridgeCommand(deps, payload.text ?? "");
        res.json({ success: true, handled: "command" });
        return;
      }

      const ignore = shouldIgnoreInbound(payload);
      if (ignore.ignore) {
        res.json({ success: true, ignored: true, reason: ignore.reason });
        return;
      }

      const reply = await deps.sessionManager.handleInbound(payload);
      res.json({ success: true, reply });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post("/eclaw-webhook", verifyCallbackAuth(deps.config), async (req, res, next) => {
    try {
      const payload = req.body as EClawInboundPayload;
      res.json({ success: true });
      await handleWebhookPayload(deps, payload);
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[bridge] request error:", err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  });

  return app;
}

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const stateStore = new StateStore(config.bridgeStatePath);
  const eclaw = new EClawClient(config);
  const codex = new CodexClient(config);
  await codex.start();

  const sessionManager = new SessionManager(config, codex, eclaw, stateStore);
  const approvalRouter = new ApprovalRouter(config, codex, eclaw, stateStore);
  codex.on("serverRequest", (message) => {
    if (approvalRouter.canHandle(message)) {
      approvalRouter.handle(message).catch((err) => codex.fail(message.id, -32000, err.message));
    } else {
      codex.fail(message.id, -32601, `Unsupported server request: ${message.method}`);
    }
  });

  await registerAndBind(eclaw, stateStore);

  const app = createApp({ config, codex, eclaw, stateStore, sessionManager, approvalRouter });
  const heartbeat = startStatusHeartbeat({ config, codex, eclaw, stateStore, sessionManager, approvalRouter });
  const watchdog = startWatchdog({ config, codex, eclaw, stateStore, sessionManager, approvalRouter });
  app.listen(config.eclawWebhookPort, () => {
    console.log(`[bridge] listening on http://localhost:${config.eclawWebhookPort}`);
    console.log(`[bridge] public webhook: ${config.eclawWebhookUrl}/eclaw-webhook`);
  });

  const shutdown = async (): Promise<void> => {
    if (heartbeat) clearInterval(heartbeat);
    if (watchdog) clearInterval(watchdog);
    await eclaw.unregisterCallback().catch(() => undefined);
    await codex.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function startStatusHeartbeat(deps: BridgeAppDeps): NodeJS.Timeout | undefined {
  if (!deps.config.bridgeStatusHeartbeatEnabled) return undefined;
  const timer = setInterval(() => {
    sendStatusHeartbeat(deps).catch((err) => console.error("[bridge] status heartbeat failed:", err.message));
  }, deps.config.bridgeStatusHeartbeatMs);
  timer.unref?.();
  return timer;
}

export function startWatchdog(deps: BridgeAppDeps): NodeJS.Timeout | undefined {
  if (!deps.config.bridgeWatchdogEnabled) return undefined;
  const intervalMs = Math.max(30_000, Math.min(deps.config.bridgeWatchdogStallMs / 2, 120_000));
  const timer = setInterval(() => {
    runWatchdog(deps).catch((err) => console.error("[bridge] watchdog failed:", err.message));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export async function runWatchdog(deps: BridgeAppDeps): Promise<boolean> {
  if (!deps.codex.status().connected) {
    await deps.codex.restart();
    const state = await deps.stateStore.read();
    await deps.eclaw.sendMessage(state, [
      "Codex watchdog self-repair",
      "- Trigger: app-server websocket disconnected.",
      "- Action: restarted Codex app-server.",
    ].join("\n"), { busy: true }).catch(() => undefined);
    return true;
  }

  const session = deps.sessionManager.status();
  if (!session.activeThreadId) return false;
  if (deps.approvalRouter.status().pending > 0) return false;
  if (!session.lastActivityAt) return false;

  const idleMs = Date.now() - Date.parse(session.lastActivityAt);
  if (Number.isNaN(idleMs) || idleMs < deps.config.bridgeWatchdogStallMs) return false;

  await deps.sessionManager.recoverStalledTurn(`No Codex activity for ${formatElapsed(idleMs)}.`);
  return true;
}

export async function sendStatusHeartbeat(deps: BridgeAppDeps): Promise<boolean> {
  const session = deps.sessionManager.status();
  if (!session.activeTurnId && !session.activeThreadId) return false;

  const state = await deps.stateStore.read();
  const message = buildStatusHeartbeatMessage({
    session,
    approvals: deps.approvalRouter.status(),
    codex: deps.codex.status(),
  });
  await deps.eclaw.sendMessage(state, message, { busy: true });
  return true;
}

export function buildStatusHeartbeatMessage(status: {
  session: ReturnType<SessionManager["status"]>;
  approvals: ReturnType<ApprovalRouter["status"]>;
  codex: ReturnType<CodexClient["status"]>;
}): string {
  const elapsed = formatElapsed(status.session.activeElapsedMs ?? 0);
  const prompt = status.session.activePrompt || "(unknown task)";
  const pendingApprovals = status.approvals.pending > 0
    ? `${status.approvals.pending} pending approval(s): ${status.approvals.askIds.join(", ")}`
    : "no pending approval";
  return [
    "Codex status heartbeat",
    `- Task: ${prompt}`,
    `- Elapsed: ${elapsed}`,
    `- Last event: ${status.session.lastEvent ?? "turn started"}`,
    `- Last activity: ${status.session.lastActivityAt ?? "(unknown)"}`,
    `- Approvals: ${pendingApprovals}`,
    `- Codex connected: ${status.codex.connected}`,
  ].join("\n");
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export async function registerAndBind(eclaw: EClawClient, stateStore: StateStore): Promise<void> {
  const registration = await eclaw.registerCallback();
  const binding = await eclaw.bindEntity();
  await stateStore.write({
    accountId: registration.accountId,
    deviceId: binding.deviceId ?? registration.deviceId,
    entityId: binding.entityId,
    botSecret: binding.botSecret,
    publicCode: binding.publicCode,
  });
}

export async function handleWebhookPayload(deps: BridgeAppDeps, payload: EClawInboundPayload): Promise<void> {
  if (deps.approvalRouter.resolveFromPayload(payload)) return;
  if (await handleModelPickerAction(deps, payload)) return;

  const text = payload.text ?? "";
  if (isBridgeCommand(text)) {
    await handleBridgeCommand(deps, text);
    return;
  }

  const ignore = shouldIgnoreInbound(payload);
  if (ignore.ignore) return;

  try {
    const reply = await deps.sessionManager.handleInbound(payload);
    if (reply.trim()) {
      await deps.eclaw.sendMessage(await deps.stateStore.read(), reply);
    }
  } catch (err: any) {
    await deps.eclaw.sendMessage(await deps.stateStore.read(), formatBridgeError(err));
  }
}

async function handleBridgeCommand(deps: BridgeAppDeps, text: string): Promise<void> {
  const command = parseBridgeCommand(text);
  const state = await deps.stateStore.read();
  if (command.name === "status") {
    await deps.eclaw.sendMessage(state, [
      "Codex bridge status",
      `- Codex connected: ${deps.codex.status().connected}`,
      `- Thread: ${state.threadId ?? "(none)"}`,
      `- Active turn: ${deps.sessionManager.status().activeTurnId ?? "(none)"}`,
      `- Pending approvals: ${deps.approvalRouter.status().pending}`,
      `- Last Codex error: ${deps.sessionManager.status().lastTurnError ?? "(none)"}`,
      `- Watchdog: ${deps.config.bridgeWatchdogEnabled ? `enabled, stall ${formatElapsed(deps.config.bridgeWatchdogStallMs)}` : "disabled"}`,
    ].join("\n"));
    return;
  }
  if (command.name === "reset") {
    await deps.sessionManager.reset();
    await deps.eclaw.sendMessage(await deps.stateStore.read(), "Codex bridge thread reset.");
    return;
  }
  if (command.name === "interrupt") {
    const didInterrupt = await deps.sessionManager.interrupt();
    await deps.eclaw.sendMessage(state, didInterrupt ? "Codex turn interrupted." : "No active Codex turn.");
    return;
  }
  if (command.name === "model") {
    const currentModel = sanitizeCodexModel(state.model) ?? sanitizeCodexModel(deps.config.codexModel);
    if (!command.args) {
      await deps.eclaw.sendMessage(state, modelPickerBody(currentModel), {
        card: modelPickerCard(currentModel),
      });
      return;
    }
    const model = await setCodexModel(deps, command.args);
    if (!model) {
      await deps.eclaw.sendMessage(state, "Invalid Codex model name. Use a short model id like `gpt-5.5`.");
      return;
    }
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Codex model set to ${model}. New turns will use a fresh thread.`);
  }
}

async function handleModelPickerAction(deps: BridgeAppDeps, payload: EClawInboundPayload): Promise<boolean> {
  if (payload.event !== "card_action") return false;
  if (payload.ask_id !== MODEL_PICKER_ASK_ID) return false;
  const actionId = payload.action_id ?? "";
  if (!actionId.startsWith("model:")) return false;

  const model = actionId.slice("model:".length).trim();
  if (!MODEL_OPTIONS.some((option) => option.id === model)) {
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Unknown Codex model option: ${model}`);
    return true;
  }
  const safeModel = await setCodexModel(deps, model);
  await deps.eclaw.sendMessage(await deps.stateStore.read(), `Codex model set to ${safeModel}. New turns will use a fresh thread.`);
  return true;
}

async function setCodexModel(deps: BridgeAppDeps, model: string): Promise<string | undefined> {
  const safeModel = sanitizeCodexModel(model);
  if (!safeModel) return undefined;
  await deps.stateStore.write({ model: safeModel });
  await deps.sessionManager.reset();
  return safeModel;
}

function modelPickerBody(currentModel?: string): string {
  return [
    "Choose the Codex model for future turns.",
    `Current model: ${currentModel ?? "(default)"}`,
    "",
    "You can also type `!codex model <name>` to use a custom model.",
  ].join("\n");
}

function modelPickerCard(currentModel?: string): EClawCard {
  return {
    ask_id: MODEL_PICKER_ASK_ID,
    title: "Codex model",
    body: `Current: ${currentModel ?? "(default)"}`,
    buttons: MODEL_OPTIONS.map((option) => ({
      id: `model:${option.id}`,
      label: option.label,
      style: option.style,
    })),
  };
}

function verifyCallbackAuth(config: BridgeConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.bridgeRequireCallbackAuth && !config.eclawCallbackToken && !config.eclawCallbackUsername) {
      next();
      return;
    }

    const auth = req.headers.authorization ?? "";
    if (config.eclawCallbackUsername && config.eclawCallbackPassword) {
      const expected = `Basic ${Buffer.from(`${config.eclawCallbackUsername}:${config.eclawCallbackPassword}`).toString("base64")}`;
      if (safeEqual(auth, expected)) {
        next();
        return;
      }
    }
    if (config.eclawCallbackToken) {
      const bearer = `Bearer ${config.eclawCallbackToken}`;
      const tokenHeader = String(req.headers["x-callback-token"] ?? "");
      if (safeEqual(auth, bearer) || safeEqual(tokenHeader, config.eclawCallbackToken)) {
        next();
        return;
      }
    }
    res.status(401).json({ success: false, message: "Invalid callback auth." });
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function formatBridgeError(err: any): string {
  const raw = err?.message ? String(err.message) : "unknown bridge error";
  const message = redactSensitiveText(raw)
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return [
    "Codex bridge error",
    `- Status: watchdog could not recover this turn automatically.`,
    `- Reason: ${message}`,
    "- Next: send `!codex status`, `!codex reset`, or retry the task.",
  ].join("\n");
}

function redactState(state: Record<string, unknown>): Record<string, unknown> {
  return {
    ...state,
    botSecret: state.botSecret ? "[redacted]" : undefined,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((err) => {
    console.error("[bridge] fatal:", err);
    process.exit(1);
  });
}
