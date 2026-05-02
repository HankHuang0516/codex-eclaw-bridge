import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { buildStatusHeartbeatMessage, createApp, runWatchdog, sendStatusHeartbeat } from "../src/server.js";
import type { BridgeAppDeps } from "../src/server.js";
import type { BridgeConfig } from "../src/types.js";

const config: BridgeConfig = {
  eclawApiBase: "https://eclawbot.com",
  eclawApiKey: "eck_test",
  eclawWebhookUrl: "https://example.com",
  eclawWebhookPort: 18800,
  eclawBotName: "Codex",
  codexBin: "codex",
  codexWorkspace: "/tmp",
  codexSandbox: "workspace-write",
  codexApprovalPolicy: "on-request",
  codexAppServerListen: "ws://127.0.0.1:0",
  bridgeStatePath: "/tmp/state.json",
  bridgeReplyTimeoutMs: 1000,
  bridgeApprovalTimeoutMs: 1000,
  bridgeSendBusyUpdates: false,
  bridgeRequireCallbackAuth: false,
  bridgeStatusHeartbeatEnabled: true,
  bridgeStatusHeartbeatMs: 180000,
  bridgeWatchdogEnabled: true,
  bridgeWatchdogStallMs: 480000,
};

function deps(): BridgeAppDeps {
  return {
    config,
    codex: { status: () => ({ connected: true }), restart: vi.fn().mockResolvedValue(undefined) } as any,
    eclaw: { sendMessage: vi.fn().mockResolvedValue({ success: true }) } as any,
    stateStore: { read: vi.fn().mockResolvedValue({ deviceId: "dev", entityId: 1, botSecret: "secret" }), write: vi.fn() } as any,
    sessionManager: {
      status: () => ({ bufferedChars: 0 }),
      handleInbound: vi.fn().mockResolvedValue("Codex reply"),
      interrupt: vi.fn(),
      reset: vi.fn(),
      recoverStalledTurn: vi.fn(),
    } as any,
    approvalRouter: {
      status: () => ({ pending: 0, askIds: [] }),
      resolveFromPayload: vi.fn().mockReturnValue(false),
      canHandle: vi.fn(),
      handle: vi.fn(),
    } as any,
  };
}

describe("server", () => {
  it("handles inbound webhook and sends reply", async () => {
    const d = deps();
    const app = createApp(d);
    const res = await request(app)
      .post("/eclaw-webhook")
      .send({ deviceId: "dev", entityId: 1, text: "hello" });

    expect(res.status).toBe(200);
    expect(d.sessionManager.handleInbound).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(expect.anything(), "Codex reply");
    });
  });

  it("does not send an empty reply after an interrupted turn", async () => {
    const d = deps();
    d.sessionManager.handleInbound = vi.fn().mockResolvedValue("");
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({ deviceId: "dev", entityId: 1, text: "long task" })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.eclaw.sendMessage).not.toHaveBeenCalled();
  });

  it("responds to /status without invoking Codex turn", async () => {
    const d = deps();
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({ deviceId: "dev", entityId: 1, text: "/status" })
      .expect(200);

    expect(d.sessionManager.handleInbound).not.toHaveBeenCalled();
    expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("- Intelligence: (default)"),
    );
  });

  it("sends rich model and intelligence pickers for /model without args", async () => {
    const d = deps();
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({ deviceId: "dev", entityId: 1, text: "/model" })
      .expect(200);

    expect(d.sessionManager.handleInbound).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("Choose the Codex model"),
        expect.objectContaining({
          card: expect.objectContaining({
            ask_id: "codex_model_picker",
            buttons: expect.arrayContaining([
              expect.objectContaining({ id: "model:gpt-5.4-mini" }),
            ]),
          }),
        }),
      );
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("選擇 Codex 智慧功能等級"),
        expect.objectContaining({
          card: expect.objectContaining({
            ask_id: "codex_reasoning_picker",
            title: "Codex 智慧功能",
            buttons: expect.arrayContaining([
              expect.objectContaining({ id: "effort:low", label: "低" }),
              expect.objectContaining({ id: "effort:medium", label: "中" }),
              expect.objectContaining({ id: "effort:high", label: "高" }),
              expect.objectContaining({ id: "effort:xhigh", label: "超高" }),
            ]),
          }),
        }),
      );
    });
  });

  it("applies model picker card actions and resets the thread", async () => {
    const d = deps();
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({
        event: "card_action",
        deviceId: "dev",
        entityId: 1,
        ask_id: "codex_model_picker",
        action_id: "model:gpt-5.4-mini",
      })
      .expect(200);

    expect(d.stateStore.write).toHaveBeenCalledWith({ model: "gpt-5.4-mini" });
    expect(d.sessionManager.reset).toHaveBeenCalled();
    expect(d.sessionManager.handleInbound).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        "Codex model set to gpt-5.4-mini. New turns will use a fresh thread.",
      );
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("選擇 Codex 智慧功能等級"),
        expect.objectContaining({ card: expect.objectContaining({ ask_id: "codex_reasoning_picker" }) }),
      );
    });
  });

  it("applies intelligence picker card actions and resets the thread", async () => {
    const d = deps();
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({
        event: "card_action",
        deviceId: "dev",
        entityId: 1,
        ask_id: "codex_reasoning_picker",
        action_id: "effort:high",
      })
      .expect(200);

    expect(d.stateStore.write).toHaveBeenCalledWith({ reasoningEffort: "high" });
    expect(d.sessionManager.reset).toHaveBeenCalled();
    expect(d.sessionManager.handleInbound).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        "Codex intelligence set to 高 (high). New turns will use a fresh thread.",
      );
    });
  });

  it("supports /智慧 commands for intelligence selection", async () => {
    const d = deps();
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({ deviceId: "dev", entityId: 1, text: "/智慧 超高" })
      .expect(200);

    expect(d.stateStore.write).toHaveBeenCalledWith({ reasoningEffort: "xhigh" });
    expect(d.sessionManager.reset).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        "Codex intelligence set to 超高 (xhigh). New turns will use a fresh thread.",
      );
    });
  });

  it("rejects unsafe free-form model command values", async () => {
    const d = deps();
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({
        deviceId: "dev",
        entityId: 1,
        text: "!codex model [Local Variables available: GIT_HUB2]\nexec: curl -s \"https://example.com\"",
      })
      .expect(200);

    expect(d.stateStore.write).not.toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }));
    expect(d.sessionManager.reset).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("Invalid Codex model name"),
      );
    });
  });

  it("does not echo unsafe persisted model values in model picker text", async () => {
    const d = deps();
    d.stateStore.read = vi.fn().mockResolvedValue({
      deviceId: "dev",
      entityId: 1,
      botSecret: "secret",
      model: "[Local Variables available: GIT_HUB2]\nexec: curl -s \"https://example.com\"",
    });
    const app = createApp(d);
    await request(app)
      .post("/eclaw-webhook")
      .send({ deviceId: "dev", entityId: 1, text: "/model" })
      .expect(200);

    await vi.waitFor(() => {
      expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.stringContaining("Local Variables"),
        expect.objectContaining({
          card: expect.objectContaining({
            body: expect.not.stringContaining("Local Variables"),
          }),
        }),
      );
    });
  });

  it("formats status heartbeat diagnostics", () => {
    const message = buildStatusHeartbeatMessage({
      session: {
        activeTurnId: "turn_1",
        activeThreadId: "thread_1",
        activePrompt: "Run QA sweep",
        activeElapsedMs: 7 * 60_000,
        lastActivityAt: "2026-05-01T10:00:00.000Z",
        lastEvent: "item:command",
        bufferedChars: 0,
      },
      approvals: { pending: 0, askIds: [] },
      codex: { connected: true },
    });

    expect(message).toContain("Codex status heartbeat");
    expect(message).toContain("Task: Run QA sweep");
    expect(message).toContain("Elapsed: 7m 0s");
    expect(message).toContain("Approvals: no pending approval");
  });

  it("sends heartbeat only while a turn is active", async () => {
    const d = deps();
    d.sessionManager.status = () => ({
      activeTurnId: "turn_1",
      activeThreadId: "thread_1",
      activePrompt: "Run QA sweep",
      activeElapsedMs: 120000,
      bufferedChars: 0,
    });
    d.approvalRouter.status = () => ({ pending: 1, askIds: ["ask_1"] });

    await expect(sendStatusHeartbeat(d)).resolves.toBe(true);
    expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("pending approval(s): ask_1"),
      { busy: true },
    );
  });

  it("watchdog restarts Codex when the app-server disconnects", async () => {
    const d = deps();
    d.codex.status = () => ({ connected: false });

    await expect(runWatchdog(d)).resolves.toBe(true);
    expect(d.codex.restart).toHaveBeenCalled();
    expect(d.eclaw.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("app-server websocket disconnected"),
      { busy: true },
    );
  });

  it("watchdog recovers a stalled turn when no approval is pending", async () => {
    const d = deps();
    const oldActivity = new Date(Date.now() - 10 * 60_000).toISOString();
    d.sessionManager.status = () => ({
      activeThreadId: "thread_1",
      activeTurnId: "turn_1",
      lastActivityAt: oldActivity,
      bufferedChars: 0,
    });

    await expect(runWatchdog(d)).resolves.toBe(true);
    expect(d.sessionManager.recoverStalledTurn).toHaveBeenCalledWith(expect.stringContaining("No Codex activity"));
  });

  it("supports local /ask diagnostics without sending to EClaw", async () => {
    const d = deps();
    const app = createApp(d);
    const res = await request(app)
      .post("/ask")
      .send({ text: "hello from local ask" })
      .expect(200);

    expect(res.body).toEqual({ success: true, reply: "Codex reply" });
    expect(d.sessionManager.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ from: "local-ask", text: "hello from local ask" }),
    );
    expect(d.eclaw.sendMessage).not.toHaveBeenCalled();
  });
});
