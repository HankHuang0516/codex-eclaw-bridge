import { describe, expect, it, vi } from "vitest";
import { EClawClient } from "../src/eclaw-client.js";
import type { BridgeConfig } from "../src/types.js";

const config: BridgeConfig = {
  eclawApiBase: "https://eclawbot.com",
  eclawApiKey: "eck_test",
  eclawApiSecret: "ecs_test",
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

describe("EClawClient", () => {
  it("constructs channel message body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EClawClient(config);
    await client.sendMessage({ deviceId: "dev", entityId: 2, botSecret: "secret" }, "hello");

    expect(fetchMock).toHaveBeenCalledWith("https://eclawbot.com/api/channel/message", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        channel_api_key: "eck_test",
        deviceId: "dev",
        entityId: 2,
        botSecret: "secret",
        state: "IDLE",
        message: "hello",
      }),
    }));
  });
});
