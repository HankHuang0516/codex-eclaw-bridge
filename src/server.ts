import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { EClawClient } from "./eclaw-client.js";
import { ApprovalRouter } from "./approval-router.js";
import { sanitizeCodexModel, sanitizeCodexReasoningEffort } from "./model.js";
import { parseBridgeCommand, shouldIgnoreInbound, isBridgeCommand } from "./payload.js";
import { redactSensitiveText } from "./redact.js";
import { SessionManager } from "./session-manager.js";
import { StateStore } from "./state-store.js";
import { ManagedTunnel } from "./tunnel-manager.js";
import type { BridgeConfig, EClawCard, EClawInboundPayload } from "./types.js";

const MODEL_PICKER_ASK_ID = "codex_model_picker";
const REASONING_PICKER_ASK_ID = "codex_reasoning_picker";
const MODEL_OPTIONS = [
  { id: "gpt-5.5", label: "GPT-5.5", style: "primary" },
  { id: "gpt-5.4", label: "GPT-5.4", style: "secondary" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", style: "secondary" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", style: "secondary" },
] as const;
const REASONING_OPTIONS = [
  { id: "low", label: "低", style: "secondary" },
  { id: "medium", label: "中", style: "primary" },
  { id: "high", label: "高", style: "secondary" },
  { id: "xhigh", label: "超高", style: "secondary" },
] as const;
const MANAGED_TUNNEL_REGISTER_ATTEMPTS = 20;

export type BridgeAppDeps = {
  config: BridgeConfig;
  codex: CodexClient;
  eclaw: EClawClient;
  stateStore: StateStore;
  sessionManager: SessionManager;
  approvalRouter: ApprovalRouter;
  tunnelManager?: ManagedTunnel;
  publicWebhookMonitor?: PublicWebhookMonitor;
};

export type PublicWebhookMonitor = {
  lastCheckedAt: number;
  lastAlertAt: number;
  lastFailure?: string;
};

export type PublicWebhookHealth = {
  ok: boolean;
  url: string;
  status?: number;
  error?: string;
};

export function createPublicWebhookMonitor(): PublicWebhookMonitor {
  return { lastCheckedAt: 0, lastAlertAt: 0 };
}

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
      tunnel: deps.tunnelManager?.status(),
      publicWebhook: deps.publicWebhookMonitor
        ? {
            lastCheckedAt: deps.publicWebhookMonitor.lastCheckedAt
              ? new Date(deps.publicWebhookMonitor.lastCheckedAt).toISOString()
              : undefined,
            lastAlertAt: deps.publicWebhookMonitor.lastAlertAt
              ? new Date(deps.publicWebhookMonitor.lastAlertAt).toISOString()
              : undefined,
            lastFailure: deps.publicWebhookMonitor.lastFailure,
          }
        : undefined,
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
  const tunnelManager = config.bridgeManagedTunnelEnabled ? new ManagedTunnel(config) : undefined;
  if (tunnelManager) {
    config.eclawWebhookUrl = await tunnelManager.ensureStarted();
  }

  const sessionManager = new SessionManager(config, codex, eclaw, stateStore);
  const approvalRouter = new ApprovalRouter(config, codex, eclaw, stateStore);
  codex.on("serverRequest", (message) => {
    if (approvalRouter.canHandle(message)) {
      approvalRouter.handle(message).catch((err) => codex.fail(message.id, -32000, err.message));
    } else {
      codex.fail(message.id, -32601, `Unsupported server request: ${message.method}`);
    }
  });

  try {
    await registerAndBindWithRetry(eclaw, stateStore, config.bridgeManagedTunnelEnabled ? MANAGED_TUNNEL_REGISTER_ATTEMPTS : 1);
  } catch (err) {
    await tunnelManager?.stop().catch(() => undefined);
    await codex.stop().catch(() => undefined);
    throw err;
  }

  const deps = {
    config,
    codex,
    eclaw,
    stateStore,
    sessionManager,
    approvalRouter,
    tunnelManager,
    publicWebhookMonitor: createPublicWebhookMonitor(),
  };
  const app = createApp(deps);
  const heartbeat = startStatusHeartbeat(deps);
  const watchdog = startWatchdog(deps);
  app.listen(config.eclawWebhookPort, () => {
    console.log(`[bridge] listening on http://localhost:${config.eclawWebhookPort}`);
    console.log(`[bridge] public webhook: ${config.eclawWebhookUrl}/eclaw-webhook`);
  });

  const shutdown = async (): Promise<void> => {
    if (heartbeat) clearInterval(heartbeat);
    if (watchdog) clearInterval(watchdog);
    await eclaw.unregisterCallback().catch(() => undefined);
    await tunnelManager?.stop().catch(() => undefined);
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
  if (await runPublicWebhookWatchdog(deps)) return true;

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

export async function runPublicWebhookWatchdog(deps: BridgeAppDeps): Promise<boolean> {
  if (!deps.config.bridgePublicWebhookWatchdogEnabled || !deps.publicWebhookMonitor) return false;

  const now = Date.now();
  if (now - deps.publicWebhookMonitor.lastCheckedAt < deps.config.bridgePublicWebhookWatchdogMs) {
    return false;
  }
  deps.publicWebhookMonitor.lastCheckedAt = now;

  const health = await checkPublicWebhookHealth(deps.config);
  if (health.ok) {
    deps.publicWebhookMonitor.lastFailure = undefined;
    return false;
  }

  deps.publicWebhookMonitor.lastFailure = health.error ?? `HTTP ${health.status ?? "unknown"}`;
  if (deps.tunnelManager && deps.config.bridgeManagedTunnelEnabled) {
    const previousUrl = deps.config.eclawWebhookUrl;
    const nextUrl = await deps.tunnelManager.restart();
    deps.config.eclawWebhookUrl = nextUrl;
    await registerAndBindWithRetry(deps.eclaw, deps.stateStore, MANAGED_TUNNEL_REGISTER_ATTEMPTS);
    const state = await deps.stateStore.read();
    await deps.eclaw.sendMessage(state, [
      "Codex watchdog self-repair",
      "- Trigger: public webhook health check failed.",
      `- Previous URL: ${previousUrl}`,
      `- New URL: ${nextUrl}`,
      "- Action: restarted managed tunnel and re-registered EClaw callback.",
    ].join("\n"), { busy: true }).catch(() => undefined);
    deps.publicWebhookMonitor.lastFailure = undefined;
    return true;
  }

  const alertCooldownMs = Math.max(600_000, deps.config.bridgePublicWebhookWatchdogMs);
  if (now - deps.publicWebhookMonitor.lastAlertAt >= alertCooldownMs) {
    deps.publicWebhookMonitor.lastAlertAt = now;
    const state = await deps.stateStore.read();
    await deps.eclaw.sendMessage(state, [
      "Codex watchdog needs operator action",
      "- Trigger: public webhook health check failed.",
      `- URL: ${deps.config.eclawWebhookUrl}`,
      `- Reason: ${deps.publicWebhookMonitor.lastFailure}`,
      "- Action needed: restart the public tunnel or enable BRIDGE_MANAGED_TUNNEL_ENABLED=true.",
    ].join("\n"), { busy: true }).catch(() => undefined);
  }

  return false;
}

export async function checkPublicWebhookHealth(config: BridgeConfig): Promise<PublicWebhookHealth> {
  const url = `${config.eclawWebhookUrl}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.bridgePublicWebhookTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, url, status: res.status };
  } catch (err: any) {
    return { ok: false, url, error: sanitizeHealthError(err) };
  } finally {
    clearTimeout(timeout);
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function registerAndBindWithRetry(eclaw: EClawClient, stateStore: StateStore, attempts: number): Promise<void> {
  let lastError: any;
  const totalAttempts = Math.max(1, attempts);
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      await registerAndBind(eclaw, stateStore);
      return;
    } catch (err: any) {
      lastError = err;
      if (attempt >= totalAttempts) break;
      const waitMs = Math.min(2_000 * attempt, 10_000);
      console.warn(
        `[bridge] register/bind attempt ${attempt}/${totalAttempts} failed; retrying in ${waitMs}ms: ${sanitizeHealthError(err)}`,
      );
      await delay(waitMs);
    }
  }
  throw lastError;
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
      `- Model: ${sanitizeCodexModel(state.model) ?? sanitizeCodexModel(deps.config.codexModel) ?? "(default)"}`,
      `- Intelligence: ${reasoningLabel(currentReasoningEffort(state, deps.config))}`,
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
    const currentEffort = currentReasoningEffort(state, deps.config);
    if (!command.args) {
      await deps.eclaw.sendMessage(state, modelPickerBody(currentModel), {
        card: modelPickerCard(currentModel),
      });
      await deps.eclaw.sendMessage(state, reasoningPickerBody(currentEffort), {
        card: reasoningPickerCard(currentEffort),
      });
      return;
    }
    const model = await setCodexModel(deps, command.args);
    if (!model) {
      await deps.eclaw.sendMessage(state, "Invalid Codex model name. Use a short model id like `gpt-5.5`.");
      return;
    }
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Codex model set to ${model}. New turns will use a fresh thread.`);
    const nextState = await deps.stateStore.read();
    const nextEffort = currentReasoningEffort(nextState, deps.config);
    await deps.eclaw.sendMessage(nextState, reasoningPickerBody(nextEffort), {
      card: reasoningPickerCard(nextEffort),
    });
    return;
  }
  if (command.name === "effort" || command.name === "reasoning") {
    if (!command.args) {
      const currentEffort = currentReasoningEffort(state, deps.config);
      await deps.eclaw.sendMessage(state, reasoningPickerBody(currentEffort), {
        card: reasoningPickerCard(currentEffort),
      });
      return;
    }
    const effort = await setCodexReasoningEffort(deps, command.args);
    if (!effort) {
      await deps.eclaw.sendMessage(state, "Invalid Codex intelligence value. Use `low`, `medium`, `high`, `xhigh`, or `低` / `中` / `高` / `超高`.");
      return;
    }
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Codex intelligence set to ${reasoningLabel(effort)} (${effort}). New turns will use a fresh thread.`);
    return;
  }
}

async function handleModelPickerAction(deps: BridgeAppDeps, payload: EClawInboundPayload): Promise<boolean> {
  if (payload.event !== "card_action") return false;
  const actionId = payload.action_id ?? "";
  if (payload.ask_id === MODEL_PICKER_ASK_ID) {
    if (!actionId.startsWith("model:")) return false;

    const model = actionId.slice("model:".length).trim();
    if (!MODEL_OPTIONS.some((option) => option.id === model)) {
      await deps.eclaw.sendMessage(await deps.stateStore.read(), `Unknown Codex model option: ${model}`);
      return true;
    }
    const safeModel = await setCodexModel(deps, model);
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Codex model set to ${safeModel}. New turns will use a fresh thread.`);
    const state = await deps.stateStore.read();
    const currentEffort = currentReasoningEffort(state, deps.config);
    await deps.eclaw.sendMessage(state, reasoningPickerBody(currentEffort), {
      card: reasoningPickerCard(currentEffort),
    });
    return true;
  }

  if (payload.ask_id === REASONING_PICKER_ASK_ID) {
    if (!actionId.startsWith("effort:")) return false;
    const effort = actionId.slice("effort:".length).trim();
    if (!REASONING_OPTIONS.some((option) => option.id === effort)) {
      await deps.eclaw.sendMessage(await deps.stateStore.read(), `Unknown Codex intelligence option: ${effort}`);
      return true;
    }
    const safeEffort = await setCodexReasoningEffort(deps, effort);
    if (!safeEffort) {
      await deps.eclaw.sendMessage(await deps.stateStore.read(), `Unknown Codex intelligence option: ${effort}`);
      return true;
    }
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Codex intelligence set to ${reasoningLabel(safeEffort)} (${safeEffort}). New turns will use a fresh thread.`);
    return true;
  }

  return false;
}

async function setCodexModel(deps: BridgeAppDeps, model: string): Promise<string | undefined> {
  const safeModel = sanitizeCodexModel(model);
  if (!safeModel) return undefined;
  await deps.stateStore.write({ model: safeModel });
  await deps.sessionManager.reset();
  return safeModel;
}

async function setCodexReasoningEffort(deps: BridgeAppDeps, effort: string): Promise<string | undefined> {
  const safeEffort = sanitizeCodexReasoningEffort(effort);
  if (!safeEffort) return undefined;
  await deps.stateStore.write({ reasoningEffort: safeEffort });
  await deps.sessionManager.reset();
  return safeEffort;
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

function reasoningPickerBody(currentEffort?: string): string {
  return [
    "選擇 Codex 智慧功能等級，會套用到之後的新對話。",
    `目前智慧功能：${reasoningLabel(currentEffort)}`,
    "",
    "低較快，中較平衡，高/超高會在複雜工作上投入更多推理。",
  ].join("\n");
}

function reasoningPickerCard(currentEffort?: string): EClawCard {
  return {
    ask_id: REASONING_PICKER_ASK_ID,
    title: "Codex 智慧功能",
    body: `目前：${reasoningLabel(currentEffort)}`,
    buttons: REASONING_OPTIONS.map((option) => ({
      id: `effort:${option.id}`,
      label: option.label,
      style: option.id === currentEffort ? "primary" : option.style,
    })),
  };
}

function reasoningLabel(effort?: string): string {
  if (effort === "low") return "低";
  if (effort === "medium") return "中";
  if (effort === "high") return "高";
  if (effort === "xhigh") return "超高";
  return "(default)";
}

function currentReasoningEffort(state: { reasoningEffort?: string }, config: BridgeConfig): string | undefined {
  return sanitizeCodexReasoningEffort(state.reasoningEffort) ?? sanitizeCodexReasoningEffort(config.codexReasoningEffort);
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

function sanitizeHealthError(err: any): string {
  const raw = err?.message ? String(err.message) : String(err ?? "unknown health check error");
  return redactSensitiveText(raw)
    .replace(/\s+/g, " ")
    .slice(0, 240);
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
