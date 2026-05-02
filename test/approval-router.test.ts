import { describe, expect, it, vi } from "vitest";
import { ApprovalRouter } from "../src/approval-router.js";
import type { BridgeConfig, ServerRequestMessage } from "../src/types.js";

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
  bridgePublicWebhookWatchdogEnabled: true,
  bridgePublicWebhookWatchdogMs: 120000,
  bridgePublicWebhookTimeoutMs: 10000,
  bridgeManagedTunnelEnabled: false,
  bridgeTunnelBin: "cloudflared",
  bridgeTunnelTargetUrl: "http://localhost:18800",
  bridgeTunnelReadyTimeoutMs: 45000,
};

describe("ApprovalRouter", () => {
  it("creates approval cards and resolves decisions", async () => {
    const codex = { respond: vi.fn(), fail: vi.fn() } as any;
    const eclaw = { sendMessage: vi.fn().mockResolvedValue({ success: true }) } as any;
    const stateStore = { read: vi.fn().mockResolvedValue({ deviceId: "dev", entityId: 1, botSecret: "secret" }) } as any;
    const router = new ApprovalRouter(config, codex, eclaw, stateStore);
    const message: ServerRequestMessage = {
      jsonrpc: "2.0",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test", cwd: "/repo" },
    };

    await router.handle(message);
    const card = eclaw.sendMessage.mock.calls[0][2].card;
    expect(card.title).toContain("command approval");
    expect(router.status().pending).toBe(1);

    expect(router.resolveFromPayload({ deviceId: "dev", entityId: 1, ask_id: card.ask_id, action_id: "approve_for_session" })).toBe(true);
    expect(codex.respond).toHaveBeenCalledWith(7, { decision: "approveForSession" });
    expect(router.status().pending).toBe(0);
  });
});
