import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { isNoopCompletionText } from "../src/noop.js";
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

class MockCodexFailedTurn extends EventEmitter {
  async request(method: string): Promise<any> {
    if (method === "thread/start") return { thread: { id: "thread_failed" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread_failed",
            turnId: "turn_failed",
            turn: { status: "failed", error: { message: "You've hit your usage limit. Retry later." } },
          },
        } satisfies ServerNotificationMessage);
      });
      return { turn: { id: "turn_failed" } };
    }
    return {};
  }
}

class MockCodexNoFinalText extends EventEmitter {
  async request(method: string): Promise<any> {
    if (method === "thread/start") return { thread: { id: "thread_empty" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread_empty", turnId: "turn_empty" },
        } satisfies ServerNotificationMessage);
      });
      return { turn: { id: "turn_empty" } };
    }
    return {};
  }
}

class MockCodexNoopFinalText extends EventEmitter {
  async request(method: string): Promise<any> {
    if (method === "thread/start") return { thread: { id: "thread_noop" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread_noop",
            turnId: "turn_noop",
            item: { type: "agentMessage", phase: "final_answer", text: "Done." },
          },
        } satisfies ServerNotificationMessage);
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread_noop", turnId: "turn_noop" },
        } satisfies ServerNotificationMessage);
      });
      return { turn: { id: "turn_noop" } };
    }
    return {};
  }
}

class MockCodexRecoverableThenSuccess extends EventEmitter {
  restart = vi.fn().mockResolvedValue(undefined);
  turnStarts = 0;
  threadStarts = 0;

  async request(method: string): Promise<any> {
    if (method === "thread/start") {
      this.threadStarts += 1;
      return { thread: { id: `thread_${this.threadStarts}` } };
    }
    if (method === "turn/start") {
      this.turnStarts += 1;
      const turnId = `turn_${this.turnStarts}`;
      const threadId = `thread_${this.threadStarts}`;
      queueMicrotask(() => {
        if (this.turnStarts === 1) {
          this.emit("notification", {
            method: "turn/completed",
            params: {
              threadId,
              turnId,
              turn: {
                status: "failed",
                error: {
                  message: "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The '[Local Variables available' marker is invalid\"}}",
                },
              },
            },
          } satisfies ServerNotificationMessage);
          return;
        }
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { type: "agentMessage", phase: "final_answer", text: "Recovered answer." },
          },
        } satisfies ServerNotificationMessage);
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId, turnId },
        } satisfies ServerNotificationMessage);
      });
      return { turn: { id: turnId } };
    }
    return {};
  }
}

class MockCodexCaptureModel extends EventEmitter {
  models: unknown[] = [];
  efforts: unknown[] = [];

  async request(method: string, params?: any): Promise<any> {
    if (method === "thread/start") {
      this.models.push(params?.model);
      return { thread: { id: "thread_model" } };
    }
    if (method === "turn/start") {
      this.models.push(params?.model);
      this.efforts.push(params?.effort);
      queueMicrotask(() => {
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread_model",
            turnId: "turn_model",
            item: { type: "agentMessage", phase: "final_answer", text: "Model repaired." },
          },
        } satisfies ServerNotificationMessage);
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread_model", turnId: "turn_model" },
        } satisfies ServerNotificationMessage);
      });
      return { turn: { id: "turn_model" } };
    }
    return {};
  }
}

describe("SessionManager stop-progress enforcement", () => {
  it.each([
    "",
    "Done.",
    "[SILENT]",
    "ACK",
    "received",
    "收到。",
    [
      "EClaw progress update",
      "目前進度：本輪任務已完成，正在送出最終回覆。摘要：Done.",
      "阻塞點：無。",
      "下一步：等待下一個指令。",
    ].join("\n"),
  ])("classifies no-op completion text %#", (text) => {
    expect(isNoopCompletionText(text)).toBe(true);
  });

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
      { busy: true, suppressA2A: true },
    );
    expect(eclaw.sendMessage).toHaveBeenCalledWith(
      state,
      expect.stringContaining("阻塞點：無。"),
      { busy: true, suppressA2A: true },
    );
  });

  it("does not report failed Codex turns as completed progress", async () => {
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

    const manager = new SessionManager(config, new MockCodexFailedTurn() as any, eclaw as any, stateStore as any);

    await expect(manager.handleInbound({ deviceId: "dev", entityId: 6, text: "hello" })).rejects.toThrow("usage limit");
    expect(eclaw.sendMessage).not.toHaveBeenCalledWith(
      state,
      expect.stringContaining("本輪任務已完成"),
      expect.anything(),
    );
  });

  it("returns an empty reply instead of synthesizing Done when Codex has no final text", async () => {
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

    const manager = new SessionManager(config, new MockCodexNoFinalText() as any, eclaw as any, stateStore as any);
    const reply = await manager.handleInbound({ deviceId: "dev", entityId: 6, text: "hello" });

    expect(reply).toBe("");
    expect(eclaw.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send stop-progress updates for no-op final text", async () => {
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

    const manager = new SessionManager(config, new MockCodexNoopFinalText() as any, eclaw as any, stateStore as any);
    const reply = await manager.handleInbound({ deviceId: "dev", entityId: 6, text: "hello" });

    expect(reply).toBe("Done.");
    expect(eclaw.sendMessage).not.toHaveBeenCalled();
  });

  it("self-repairs a recoverable invalid_request turn error and retries once", async () => {
    let state: BridgeState = { deviceId: "dev", entityId: 6, botSecret: "secret" };
    const stateStore = {
      read: vi.fn().mockImplementation(async () => state),
      write: vi.fn().mockImplementation(async (patch: BridgeState) => {
        state = { ...state, ...patch };
      }),
      clearThread: vi.fn().mockImplementation(async () => {
        state = { deviceId: "dev", entityId: 6, botSecret: "secret" };
        return state;
      }),
    };
    const eclaw = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      getPromptPolicy: vi.fn().mockResolvedValue({ success: true, policy: { compiledPrompt: "" } }),
    };
    const codex = new MockCodexRecoverableThenSuccess();

    const manager = new SessionManager(config, codex as any, eclaw as any, stateStore as any);
    const reply = await manager.handleInbound({
      deviceId: "dev",
      entityId: 6,
      text: "investigate\n\n[Local Variables available: GIT_HUB2]\nexec: curl -s \"secret\"",
    });

    expect(reply).toBe("Recovered answer.");
    expect(codex.restart).toHaveBeenCalled();
    expect(stateStore.clearThread).toHaveBeenCalled();
    expect(eclaw.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Codex watchdog self-repair"),
      { busy: true, suppressA2A: true },
    );
  });

  it("drops unsafe state model overrides before starting Codex", async () => {
    let state: BridgeState = {
      deviceId: "dev",
      entityId: 6,
      botSecret: "secret",
      model: "[Local Variables available: GIT_HUB2]\nexec: curl -s \"https://example.com\"",
    };
    const stateStore = {
      read: vi.fn().mockImplementation(async () => state),
      write: vi.fn().mockImplementation(async (patch: BridgeState) => {
        state = { ...state, ...patch };
      }),
      clearThread: vi.fn(),
    };
    const eclaw = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      getPromptPolicy: vi.fn().mockResolvedValue({ success: true, policy: { compiledPrompt: "" } }),
    };
    const codex = new MockCodexCaptureModel();

    const manager = new SessionManager(
      { ...config, codexModel: "gpt-5.5" },
      codex as any,
      eclaw as any,
      stateStore as any,
    );
    const reply = await manager.handleInbound({ deviceId: "dev", entityId: 6, text: "hello" });

    expect(reply).toBe("Model repaired.");
    expect(state.model).toBeUndefined();
    expect(stateStore.write).toHaveBeenCalledWith({
      model: undefined,
      reasoningEffort: undefined,
      threadId: undefined,
      activeTurnId: undefined,
    });
    expect(codex.models).toEqual(["gpt-5.5", "gpt-5.5"]);
  });

  it("uses sanitized state reasoning effort for new Codex turns", async () => {
    const state: BridgeState = {
      deviceId: "dev",
      entityId: 6,
      botSecret: "secret",
      model: "gpt-5.5",
      reasoningEffort: "超高",
    };
    const stateStore = {
      read: vi.fn().mockResolvedValue(state),
      write: vi.fn().mockResolvedValue(undefined),
      clearThread: vi.fn(),
    };
    const eclaw = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      getPromptPolicy: vi.fn().mockResolvedValue({ success: true, policy: { compiledPrompt: "" } }),
    };
    const codex = new MockCodexCaptureModel();

    const manager = new SessionManager(config, codex as any, eclaw as any, stateStore as any);
    const reply = await manager.handleInbound({ deviceId: "dev", entityId: 6, text: "hello" });

    expect(reply).toBe("Model repaired.");
    expect(codex.efforts).toEqual(["xhigh"]);
  });

  it("drops unsafe state reasoning overrides before starting Codex", async () => {
    let state: BridgeState = {
      deviceId: "dev",
      entityId: 6,
      botSecret: "secret",
      reasoningEffort: "[Local Variables available: GIT_HUB2]",
    };
    const stateStore = {
      read: vi.fn().mockImplementation(async () => state),
      write: vi.fn().mockImplementation(async (patch: BridgeState) => {
        state = { ...state, ...patch };
      }),
      clearThread: vi.fn(),
    };
    const eclaw = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      getPromptPolicy: vi.fn().mockResolvedValue({ success: true, policy: { compiledPrompt: "" } }),
    };
    const codex = new MockCodexCaptureModel();

    const manager = new SessionManager(
      { ...config, codexReasoningEffort: "medium" },
      codex as any,
      eclaw as any,
      stateStore as any,
    );
    const reply = await manager.handleInbound({ deviceId: "dev", entityId: 6, text: "hello" });

    expect(reply).toBe("Model repaired.");
    expect(state.reasoningEffort).toBeUndefined();
    expect(stateStore.write).toHaveBeenCalledWith({
      model: undefined,
      reasoningEffort: undefined,
      threadId: undefined,
      activeTurnId: undefined,
    });
    expect(codex.efforts).toEqual(["medium"]);
  });
});
