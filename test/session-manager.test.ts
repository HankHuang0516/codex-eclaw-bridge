import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { deriveSenderHint, requiresStopProgressTransform, SessionManager } from "../src/session-manager.js";
import type { BridgeConfig, BridgeState, ServerNotificationMessage } from "../src/types.js";

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

class MockCodex extends EventEmitter {
  async request(method: string): Promise<any> {
    if (method === "thread/start") return { thread: { id: "thread_1" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread_1",
            turnId: "turn_1",
            item: { type: "agentMessage", phase: "final_answer", text: "Final answer." },
          },
        } satisfies ServerNotificationMessage);
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread_1", turnId: "turn_1" },
        } satisfies ServerNotificationMessage);
      });
      return { turn: { id: "turn_1" } };
    }
    return {};
  }
}

describe("deriveSenderHint", () => {
  it("maps bot-to-bot fromEntityId to kind=entity with publicCode passthrough", () => {
    const hint = deriveSenderHint({
      deviceId: "dev",
      entityId: 1,
      fromEntityId: 5,
      fromPublicCode: "abc123",
    });
    expect(hint).toEqual({ kind: "entity", entityId: 5, publicCode: "abc123" });
  });

  it("maps client/user/system/kanban inbound to kind=user (no routing)", () => {
    expect(deriveSenderHint({ deviceId: "d", entityId: 1, from: "client" })).toEqual({ kind: "user" });
    expect(deriveSenderHint({ deviceId: "d", entityId: 1, from: "user" })).toEqual({ kind: "user" });
    expect(deriveSenderHint({ deviceId: "d", entityId: 1, from: "system" })).toEqual({ kind: "user" });
    expect(deriveSenderHint({ deviceId: "d", entityId: 1, from: "kanban" })).toEqual({ kind: "user" });
  });

  it("maps explicit broadcast inbound to kind=broadcast", () => {
    expect(
      deriveSenderHint({ deviceId: "d", entityId: 1, isBroadcast: true, fromEntityId: 9 }),
    ).toEqual({ kind: "broadcast" });
  });

  it("returns kind=unknown when no fromEntityId/publicCode and no special from", () => {
    expect(deriveSenderHint({ deviceId: "d", entityId: 1 })).toEqual({ kind: "unknown" });
    expect(deriveSenderHint({ deviceId: "d", entityId: 1, from: "mysterious" })).toEqual({ kind: "unknown" });
  });
});

describe("SessionManager.sendCodexReply", () => {
  it("propagates the captured senderHint from the most recent inbound", async () => {
    const state: BridgeState = { deviceId: "dev", entityId: 1, botSecret: "secret" };
    const stateStore = {
      read: vi.fn().mockResolvedValue(state),
      write: vi.fn().mockResolvedValue(undefined),
      clearThread: vi.fn(),
    };
    const eclaw = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      getPromptPolicy: vi.fn().mockResolvedValue(null),
      getRoutingPolicy: vi.fn().mockResolvedValue(""),
    };
    const manager = new SessionManager(config, new MockCodex() as any, eclaw as any, stateStore as any);
    await manager.handleInbound({ deviceId: "dev", entityId: 1, fromEntityId: 5, fromPublicCode: "abc123", text: "hi" });
    await manager.sendCodexReply(state, "the reply");

    // Last sendMessage call should include senderHint derived from the inbound
    const lastCall = eclaw.sendMessage.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe("the reply");
    expect(lastCall?.[2].senderHint).toEqual({ kind: "entity", entityId: 5, publicCode: "abc123" });
  });
});

describe("SessionManager stop-progress enforcement", () => {
  it("detects centrally managed stop-progress transform policy", () => {
    expect(requiresStopProgressTransform("在停下手邊工作前，必須先呼叫 EClaw TRANSFORM API 回報目前進度。")).toBe(true);
    expect(requiresStopProgressTransform("Use short replies.")).toBe(false);
  });

  it("sends a progress transform before returning the final reply when policy requires it", async () => {
    const state: BridgeState = { deviceId: "dev", entityId: 6, botSecret: "secret" };
    const stateStore = {
      read: vi.fn().mockResolvedValue(state),
      write: vi.fn().mockResolvedValue(undefined),
      clearThread: vi.fn(),
    };
    const eclaw = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      getPromptPolicy: vi.fn().mockResolvedValue({
        success: true,
        policy: {
          compiledPrompt: "在停下手邊工作前，必須先呼叫 EClaw TRANSFORM API 回報目前進度、阻塞點與下一步。",
        },
      }),
      getRoutingPolicy: vi.fn().mockResolvedValue(""),
    };

    const manager = new SessionManager(config, new MockCodex() as any, eclaw as any, stateStore as any);
    const reply = await manager.handleInbound({ deviceId: "dev", entityId: 6, text: "hello" });

    expect(reply).toBe("Final answer.");
    expect(eclaw.sendMessage).toHaveBeenCalledWith(
      state,
      expect.stringContaining("EClaw progress update"),
      { busy: true },
    );
    expect(eclaw.sendMessage).toHaveBeenCalledWith(
      state,
      expect.stringContaining("阻塞點：無。"),
      { busy: true },
    );
  });
});
