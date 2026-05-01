import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
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
    expect(d.eclaw.sendMessage).toHaveBeenCalled();
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
