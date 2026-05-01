import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { requiresStopProgressTransform, SessionManager } from "../src/session-manager.js";
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
