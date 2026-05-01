import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { EClawClient } from "./eclaw-client.js";
import { ApprovalRouter } from "./approval-router.js";
import { parseBridgeCommand, shouldIgnoreInbound, isBridgeCommand } from "./payload.js";
import { SessionManager } from "./session-manager.js";
import { StateStore } from "./state-store.js";
import type { BridgeConfig, EClawInboundPayload } from "./types.js";

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
  app.listen(config.eclawWebhookPort, () => {
    console.log(`[bridge] listening on http://localhost:${config.eclawWebhookPort}`);
    console.log(`[bridge] public webhook: ${config.eclawWebhookUrl}/eclaw-webhook`);
  });

  const shutdown = async (): Promise<void> => {
    await eclaw.unregisterCallback().catch(() => undefined);
    await codex.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Bridge error: ${err.message}`);
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
    if (!command.args) {
      await deps.eclaw.sendMessage(state, `Current model: ${state.model ?? deps.config.codexModel ?? "(default)"}`);
      return;
    }
    await deps.stateStore.write({ model: command.args });
    await deps.eclaw.sendMessage(await deps.stateStore.read(), `Codex model set to ${command.args}.`);
  }
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
