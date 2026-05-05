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
  bridgeStatusHeartbeatEnabled: true,
  bridgeStatusHeartbeatMs: 180000,
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

  it("forwards senderHint into the channel message body when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EClawClient(config);
    await client.sendMessage(
      { deviceId: "dev", entityId: 2, botSecret: "secret" },
      "reply",
      { senderHint: { kind: "entity", entityId: 5, publicCode: "abc123" } },
    );

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.senderHint).toEqual({ kind: "entity", entityId: 5, publicCode: "abc123" });
  });

  it("getRoutingPolicy returns trimmed policy text on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, policy: "  ROUTING block  " }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EClawClient(config);
    const policy = await client.getRoutingPolicy("codex", "en");
    expect(policy).toBe("ROUTING block");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://eclawbot.com/api/channel/routing-policy?channel=codex&lang=en",
    );
  });

  it("getRoutingPolicy returns '' on 404 (older server pre-EClaw#2287)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    const client = new EClawClient(config);
    expect(await client.getRoutingPolicy()).toBe("");
  });

  it("getRoutingPolicy returns '' when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    const client = new EClawClient(config);
    expect(await client.getRoutingPolicy()).toBe("");
  });

  // ── Phase 2: channel key path ─────────────────────────────────────────────

  it("routes to /api/transform with X-Channel-Key when eclawPreferTransformViaChannelKey=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const channelKeyConfig: BridgeConfig = { ...config, eclawPreferTransformViaChannelKey: true };
    const client = new EClawClient(channelKeyConfig);
    await client.sendMessage({ deviceId: "dev", entityId: 2, botSecret: "secret" }, "hello via channel key");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://eclawbot.com/api/transform",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Channel-Key": "eck_test" }),
      }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.actAs).toBe("channel");
    expect(sentBody.deviceId).toBe("dev");
    expect(sentBody.entityId).toBe(2);
    expect(sentBody.botSecret).toBeUndefined();
    expect(sentBody.channel_api_key).toBeUndefined();
  });

  it("falls back to /api/channel/message when eclawPreferTransformViaChannelKey=false (default)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EClawClient(config); // flag defaults to false/undefined
    await client.sendMessage({ deviceId: "dev", entityId: 2, botSecret: "secret" }, "hello legacy");

    expect(fetchMock).toHaveBeenCalledWith("https://eclawbot.com/api/channel/message", expect.anything());
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.botSecret).toBe("secret");
    expect(sentBody.actAs).toBeUndefined();
  });

  it("throws when botSecret is missing on legacy path", async () => {
    const client = new EClawClient(config);
    await expect(
      client.sendMessage({ deviceId: "dev", entityId: 2 }, "no secret"),
    ).rejects.toThrow("not bound");
  });

  it("throws when botSecret is missing but channel key path does not need it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const channelKeyConfig: BridgeConfig = { ...config, eclawPreferTransformViaChannelKey: true };
    const client = new EClawClient(channelKeyConfig);
    // Should succeed without botSecret on channel key path
    await expect(
      client.sendMessage({ deviceId: "dev", entityId: 2 }, "no botSecret needed"),
    ).resolves.not.toThrow();
  });

  // ── fetches centrally managed prompt policy ───────────────────────────────

  it("fetches centrally managed prompt policy for the bound entity", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, policy: { compiledPrompt: "central policy" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EClawClient(config);
    const policy = await client.getPromptPolicy({ deviceId: "dev", entityId: 2, botSecret: "secret" }, "codex");

    expect(policy?.policy?.compiledPrompt).toBe("central policy");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://eclawbot.com/api/channel/prompt-policy?deviceId=dev&entityId=2&botSecret=secret&channel=codex",
      expect.objectContaining({
        method: "GET",
        body: undefined,
      }),
    );
  });
});
