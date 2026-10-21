import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { handleWebhookPayload, type BridgeAppDeps } from "../src/server.js";
import type { BridgeConfig, BridgeState, EClawInboundPayload } from "../src/types.js";

const config = {
  eclawApiBase: "https://eclawbot.com", eclawApiKey: "test-key", eclawApiTimeoutMs: 1000,
  eclawWebhookUrl: "https://example.com", eclawWebhookPort: 18802, eclawBotName: "Codex",
  codexBin: "codex", codexWorkspace: "/tmp", codexSandbox: "workspace-write",
  codexApprovalPolicy: "on-request", codexAppServerListen: "ws://127.0.0.1:0",
  bridgeStatePath: "/tmp/state.json", bridgeReplyTimeoutMs: 5000,
  bridgeApprovalTimeoutMs: 1000, bridgeSendBusyUpdates: false,
  bridgeStopProgressUpdates: false, bridgeRequireCallbackAuth: false, bridgeWebhookDispatchEnabled: true,
  bridgeStatusHeartbeatEnabled: false, bridgeStatusHeartbeatMs: 180000,
  bridgeRuntimeHeartbeatEnabled: false, bridgeRuntimeHeartbeatMs: 12000,
} as BridgeConfig;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ControlledCodex extends EventEmitter {
  starts: any[] = [];
  steers: any[] = [];
  interrupts: any[] = [];
  startError?: Error;
  startGate?: Promise<void>;
  interruptError?: Error;
  steerResult?: () => Promise<any>;
  request = vi.fn(async (method: string, params: any): Promise<any> => {
    if (method === "thread/resume") return { thread: { id: "thread_1" } };
    if (method === "turn/start") {
      this.starts.push(params);
      if (this.startError) { const err = this.startError; this.startError = undefined; throw err; }
      if (this.startGate) await this.startGate;
      return { turn: { id: `turn_${this.starts.length}` } };
    }
    if (method === "turn/steer") {
      this.steers.push(params);
      return this.steerResult ? this.steerResult() : { turnId: params.expectedTurnId };
    }
    if (method === "turn/interrupt") {
      if (this.interruptError) throw this.interruptError;
      this.interrupts.push(params);
      this.complete(Number(params.turnId.split("_")[1]), "", "interrupted");
    }
    return {};
  });
  status() { return { connected: true }; }
  complete(index: number, text: string, status = "completed") {
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread_1", turnId: `turn_${index}`,
        turn: { status, items: [{ type: "agentMessage", phase: "final_answer", text }],
          ...(status === "failed" ? { error: { message: "model unavailable" } } : {}) },
      },
    });
  }
}

function harness() {
  const state: BridgeState = { deviceId: "dev", entityId: 12, botSecret: "private-test-secret", threadId: "thread_1" };
  const stateStore = {
    read: vi.fn(async () => ({ ...state })),
    write: vi.fn(async (next: BridgeState) => { Object.assign(state, next); }),
    clearThread: vi.fn(),
  };
  const eclaw = {
    getPromptPolicy: vi.fn().mockResolvedValue(null), getRoutingPolicy: vi.fn().mockResolvedValue(""),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
  };
  const codex = new ControlledCodex();
  const manager = new SessionManager(config, codex as any, eclaw as any, stateStore as any);
  const payload = (text: string, extra: Partial<EClawInboundPayload> = {}): EClawInboundPayload =>
    ({ deviceId: "dev", entityId: 12, from: "web_chat", text, ...extra });
  return { state, stateStore, eclaw, codex, manager, payload };
}

describe("busy Codex inbound admission", () => {
  it("steers human follow-ups into the active turn with its exact id and no second final answer", async () => {
    const h = harness();
    const first = h.manager.handleInbound(h.payload("generate the batch"));
    await vi.waitFor(() => expect(h.manager.status().activeTurnId).toBe("turn_1"));
    await expect(h.manager.handleInbound(h.payload("use a blue background", { from: "android" }))).resolves.toBe("");
    expect(h.codex.steers).toEqual([expect.objectContaining({
      threadId: "thread_1", expectedTurnId: "turn_1",
      input: [expect.objectContaining({ text: expect.stringContaining("use a blue background") })],
    })]);
    expect(h.codex.starts).toHaveLength(1);
    expect(h.manager.status()).toMatchObject({ steeredInboundCount: 1, queuedInboundCount: 0 });
    h.codex.complete(1, "Blue batch ready.");
    await expect(first).resolves.toBe("Blue batch ready.");
  });

  it("serializes multiple simultaneous steer requests in arrival order", async () => {
    const h = harness();
    const first = h.manager.handleInbound(h.payload("start"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    const replies = await Promise.all(["follow-up one", "follow-up two", "follow-up three"].map(t => h.manager.handleInbound(h.payload(t))));
    expect(replies).toEqual(["", "", ""]);
    expect(h.codex.steers.map(p => p.input[0].text.split("User message:\n")[1])).toEqual(["follow-up one", "follow-up two", "follow-up three"]);
    h.codex.complete(1, "done"); await first;
  });

  it("allows a follow-up from the same sending bot to steer its task", async () => {
    const h = harness();
    const one = h.manager.handleInbound(h.payload("one", { fromEntityId: 14 }));
    await vi.waitFor(() => expect(h.manager.status().activeTurnId).toBe("turn_1"));
    await expect(h.manager.handleInbound(h.payload("updated constraint", { fromEntityId: 14 }))).resolves.toBe("");
    expect(h.codex.steers).toHaveLength(1);
    expect(h.manager.getLastSenderHint()).toEqual({ kind: "entity", entityId: 14 });
    h.codex.complete(1, "done"); await one;
  });

  it("queues independent kanban notifications even if they identify the same dispatcher", async () => {
    const h = harness();
    const one = h.manager.handleInbound(h.payload("one", { fromEntityId: 14 }));
    await vi.waitFor(() => expect(h.manager.status().activeTurnId).toBe("turn_1"));
    const two = h.manager.handleInbound(h.payload("another card", { fromEntityId: 14, from: "system", event: "kanban_notification" }));
    expect(h.codex.steers).toHaveLength(0);
    expect(h.manager.status().queuedInboundCount).toBe(1);
    h.codex.complete(1, "one"); await one;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    h.codex.complete(2, "two"); await two;
  });

  it("queues concurrent messages during thread/startup instead of starting competing turns", async () => {
    const h = harness();
    const one = h.manager.handleInbound(h.payload("one"));
    const two = h.manager.handleInbound(h.payload("two"));
    const three = h.manager.handleInbound(h.payload("three"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    expect(h.manager.status().queuedInboundCount).toBe(2);
    h.codex.complete(1, "one done"); await one;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    expect(h.codex.starts[1].input[0].text).toContain("User message:\ntwo");
    h.codex.complete(2, "two done"); await two;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(3));
    h.codex.complete(3, "three done"); await three;
    expect(h.manager.status().queuedInboundCount).toBe(0);
  });

  it("queues other senders and keeps every final reply routed to its original sender", async () => {
    const h = harness();
    const deps = {
      config, codex: h.codex, eclaw: h.eclaw, sessionManager: h.manager, stateStore: h.stateStore,
      approvalRouter: { resolveFromPayload: () => false },
    } as unknown as BridgeAppDeps;
    const one = handleWebhookPayload(deps, h.payload("from bot 14", { from: "entity", fromEntityId: 14 }));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    const two = handleWebhookPayload(deps, h.payload("from bot 2", { from: "entity", fromEntityId: 2 }));
    await vi.waitFor(() => expect(h.manager.status().queuedInboundCount).toBe(1));
    expect(h.codex.steers).toHaveLength(0);
    h.codex.complete(1, "reply to 14"); await one;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    h.codex.complete(2, "reply to 2"); await two;
    expect(h.eclaw.sendMessage).toHaveBeenCalledWith(expect.anything(), "reply to 14", { senderHint: { kind: "entity", entityId: 14 } });
    expect(h.eclaw.sendMessage).toHaveBeenCalledWith(expect.anything(), "reply to 2", { senderHint: { kind: "entity", entityId: 2 } });
    expect(h.eclaw.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("falls back to FIFO when turn/steer is unsupported or rejected", async () => {
    const h = harness(); h.codex.steerResult = async () => { throw new Error("Method not found"); };
    const one = h.manager.handleInbound(h.payload("one"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    const two = h.manager.handleInbound(h.payload("retained follow-up"));
    await vi.waitFor(() => expect(h.manager.status().steerFallbackCount).toBe(1));
    expect(h.manager.status().queuedInboundCount).toBe(1);
    h.codex.complete(1, "one"); await one;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    expect(h.codex.starts[1].input[0].text).toContain("retained follow-up");
    h.codex.complete(2, "two"); await expect(two).resolves.toBe("two");
  });

  it("reserves FIFO position before a late steer failure and keeps later messages behind it", async () => {
    const h = harness(); const steering = deferred<any>(); h.codex.steerResult = () => steering.promise;
    const one = h.manager.handleInbound(h.payload("one"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    const two = h.manager.handleInbound(h.payload("older follow-up"));
    const three = h.manager.handleInbound(h.payload("later bot", { fromEntityId: 14 }));
    await vi.waitFor(() => expect(h.codex.steers).toHaveLength(1));
    h.codex.complete(1, "one"); await one;
    steering.reject(new Error("no active turn"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    expect(h.codex.starts[1].input[0].text).toContain("older follow-up");
    h.codex.complete(2, "two"); await two;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(3));
    expect(h.codex.starts[2].input[0].text).toContain("later bot");
    h.codex.complete(3, "three"); await three;
  });

  it("does not let a second steer overtake an earlier failed steer", async () => {
    const h = harness(); h.codex.steerResult = async () => { throw new Error("no active turn"); };
    const one = h.manager.handleInbound(h.payload("one"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    const two = h.manager.handleInbound(h.payload("two"));
    const three = h.manager.handleInbound(h.payload("three"));
    await vi.waitFor(() => expect(h.manager.status().queuedInboundCount).toBe(2));
    expect(h.codex.steers).toHaveLength(1);
    h.codex.complete(1, "one"); await one;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    h.codex.complete(2, "two"); await two;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(3));
    h.codex.complete(3, "three"); await three;
  });

  it("retains a follow-up when completion wins the steering race", async () => {
    const h = harness();
    const one = h.manager.handleInbound(h.payload("one"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    const two = h.manager.handleInbound(h.payload("racing follow-up"));
    h.codex.complete(1, "one"); await one;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    expect(h.codex.steers).toHaveLength(0);
    h.codex.complete(2, "two"); await two;
  });

  it("does not poison later work when turn/start rejects", async () => {
    const h = harness(); h.codex.startError = new Error("startup unavailable");
    const one = h.manager.handleInbound(h.payload("one"));
    const failure = expect(one).rejects.toThrow("startup unavailable");
    const two = h.manager.handleInbound(h.payload("two"));
    await failure;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    h.codex.complete(2, "two"); await expect(two).resolves.toBe("two");
  });

  it("continues queued work after a failed model turn", async () => {
    const h = harness();
    const one = h.manager.handleInbound(h.payload("one"));
    const two = h.manager.handleInbound(h.payload("two"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    h.codex.complete(1, "", "failed"); await expect(one).resolves.toContain("model unavailable");
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    h.codex.complete(2, "two"); await two;
  });

  it("interrupts the current turn without rejecting or interrupting queued work", async () => {
    const h = harness();
    const one = h.manager.handleInbound(h.payload("one"));
    const two = h.manager.handleInbound(h.payload("two", { fromEntityId: 14 }));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    await expect(h.manager.interrupt()).resolves.toBe(true);
    await expect(one).resolves.toBe("");
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    expect(h.codex.interrupts).toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
    h.codex.complete(2, "two"); await two;
    await expect(h.manager.interrupt()).resolves.toBe(false);
  });

  it("keeps queued text, URLs, and credentials out of status diagnostics", async () => {
    const h = harness();
    const one = h.manager.handleInbound(h.payload("one"));
    const two = h.manager.handleInbound(h.payload("sensitive queued text botSecret=private-test-secret https://private.example/image"));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    const snapshot = JSON.stringify(h.manager.status());
    expect(snapshot).not.toMatch(/sensitive queued text|private-test-secret|private.example|botSecret/);
    h.codex.complete(1, "one"); await one;
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    h.codex.complete(2, "two"); await two;
  });

  it("honors an interrupt while the initial start RPC has not returned its id", async () => {
    const h = harness(); const gate = deferred<void>(); h.codex.startGate = gate.promise;
    const one = h.manager.handleInbound(h.payload("one"));
    const two = h.manager.handleInbound(h.payload("two", { fromEntityId: 14 }));
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(1));
    expect(h.manager.status().activeTurnId).toBeUndefined();
    await expect(h.manager.interrupt()).resolves.toBe(true);
    gate.resolve(); await expect(one).resolves.toBe("");
    expect(h.codex.interrupts).toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
    await vi.waitFor(() => expect(h.codex.starts).toHaveLength(2));
    h.codex.complete(2, "two"); await two;
  });

  it("leaves the active turn usable if the interrupt RPC fails", async () => {
    const h = harness(); h.codex.interruptError = new Error("interrupt unavailable");
    const one = h.manager.handleInbound(h.payload("one"));
    await vi.waitFor(() => expect(h.manager.status().activeTurnId).toBe("turn_1"));
    await expect(h.manager.interrupt()).rejects.toThrow("interrupt unavailable");
    await expect(h.manager.handleInbound(h.payload("still active"))).resolves.toBe("");
    expect(h.codex.steers).toHaveLength(1);
    h.codex.complete(1, "done"); await one;
  });
});
