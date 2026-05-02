import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { buildStatusHeartbeatMessage, createApp, sendStatusHeartbeat } from "../src/server.js";
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
};

function deps(): BridgeAppDeps {
  return {
    config,
    codex: { status: () => ({ connected: true }) } as any,
    eclaw: { sendMessage: vi.fn().mockResolvedValue({ success: true }) } as any,
    stateStore: { read: vi.fn().mockResolvedValue({ deviceId: "dev", entityId: 1, botSecret: "secret" }), write: vi.fn() } as any,
    sessionManager: {
      status: () => ({ bufferedChars: 0 }),
      handleInbound: vi.fn().mockResolvedValue("Codex reply"),
      sendCodexReply: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
      reset: vi.fn(),
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
      expect((d.sessionManager as any).sendCodexReply).toHaveBeenCalledWith(
        expect.anything(),
        "Codex reply",
      );
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
    expect((d.sessionManager as any).sendCodexReply).not.toHaveBeenCalled();
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
    expect(d.eclaw.sendMessage).toHaveBeenCalled();
  });

  it("sends a rich model picker for /model without args", async () => {
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
