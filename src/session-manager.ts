import type { CodexClient } from "./codex-client.js";
import type { EClawClient } from "./eclaw-client.js";
import { formatInboundForCodex } from "./payload.js";
import type { StateStore } from "./state-store.js";
import type {
  BridgeConfig,
  BridgeState,
  EClawInboundPayload,
  SenderHint,
  ServerNotificationMessage,
} from "./types.js";

type ThreadStartResponse = {
  thread?: { id?: string };
};

type TurnStartResponse = {
  turn?: { id?: string };
};

type ActiveTurn = {
  threadId: string;
  turnId?: string;
  senderKey?: string;
  steeringClosed?: boolean;
  interrupted?: boolean;
  text: string;
  startedAt: number;
  lastActivityAt: number;
  lastEvent?: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

const REDACTED_ACTIVE_PROMPT = "[redacted]";

export class SessionManager {
  private activeTurn?: ActiveTurn;
  // Only admission/start is serialized. Same-sender follow-ups can steer a
  // running turn without waiting for its final answer.
  private inboundTail: Promise<void> = Promise.resolve();
  private steerTail: Promise<void> = Promise.resolve();
  private queuedInboundCount = 0;
  private queuedWorkCount = 0;
  private steeredInboundCount = 0;
  private steerFallbackCount = 0;
  private lastInboundAt?: string;
  private lastSteeredAt?: string;
  private readonly resumedThreads = new Set<string>();
  private lastTurnError?: string;
  private lastSenderHint?: SenderHint;
  /** Cached routing policy text (one network call per process). */
  private routingPolicy?: string;

  constructor(
    private readonly config: BridgeConfig,
    private readonly codex: CodexClient,
    private readonly eclaw: EClawClient,
    private readonly stateStore: StateStore,
  ) {
    this.codex.on("notification", (message) => this.handleNotification(message));
  }

  async ensureThread(): Promise<string> {
    const state = await this.stateStore.read();
    const baseInstructions = await this.baseInstructions(state);
    if (state.threadId) {
      if (!this.resumedThreads.has(state.threadId)) {
        try {
          await this.codex.request("thread/resume", {
            threadId: state.threadId,
            cwd: this.config.codexWorkspace,
            model: state.model ?? this.config.codexModel ?? null,
            approvalPolicy: this.config.codexApprovalPolicy,
            sandbox: this.config.codexSandbox,
            baseInstructions,
            excludeTurns: true,
            persistExtendedHistory: true,
          });
          this.resumedThreads.add(state.threadId);
        } catch (err) {
          if (!isMissingThreadError(err)) throw err;
          await this.stateStore.clearThread();
          return this.ensureThread();
        }
      }
      return state.threadId;
    }
    const response = await this.codex.request<ThreadStartResponse>("thread/start", {
      cwd: this.config.codexWorkspace,
      model: state.model ?? this.config.codexModel ?? null,
      approvalPolicy: this.config.codexApprovalPolicy,
      sandbox: this.config.codexSandbox,
      baseInstructions,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("Codex thread/start did not return a thread id.");
    await this.stateStore.write({ threadId });
    return threadId;
  }

  async handleInbound(payload: EClawInboundPayload): Promise<string> {
    this.lastInboundAt = new Date().toISOString();
    const active = this.activeTurn;
    const senderKey = inboundSenderKey(payload);
    const canSteer = Boolean(active?.turnId && !active.interrupted && senderKey && active.senderKey === senderKey && this.queuedWorkCount === 0);
    return this.enqueueInbound(payload, canSteer && active ? this.trySteer(payload, active) : undefined);
  }

  private trySteer(payload: EClawInboundPayload, active: ActiveTurn): Promise<boolean> {
    const steering = this.steerTail.then(async () => {
      // Completion or /interrupt can race the asynchronous admission.
      if (this.activeTurn !== active || active.interrupted || active.steeringClosed) return false;
      try {
        const response = await this.codex.request<{ turnId?: string }>("turn/steer", {
          threadId: active.threadId,
          expectedTurnId: active.turnId,
          input: this.buildInput(payload),
        });
        if (response.turnId !== active.turnId) throw new Error("Steering was not confirmed.");
        this.steeredInboundCount += 1;
        this.lastSteeredAt = new Date().toISOString();
        if (this.activeTurn === active) this.markActive("turn/steer");
        return true;
      } catch {
        // Once a follow-up needs FIFO fallback, do not let a later one
        // overtake it by steering this same turn.
        active.steeringClosed = true;
        this.steerFallbackCount += 1;
        return false;
      }
    });
    this.steerTail = steering.then(() => undefined, () => undefined);
    return steering;
  }

  private enqueueInbound(payload: EClawInboundPayload, steering?: Promise<boolean>): Promise<string> {
    let resolve!: (reply: string) => void;
    let reject!: (error: unknown) => void;
    const reply = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    this.queuedInboundCount += 1;
    if (!steering) this.queuedWorkCount += 1;
    const admission = (steering ?? Promise.resolve(false)).then((accepted) => {
      if (accepted) {
        this.queuedInboundCount -= 1;
        // The original request owns delivery of the single final answer.
        resolve("");
      } else if (steering) {
        this.queuedWorkCount += 1;
      }
      return accepted;
    });
    // Reserve FIFO position before the asynchronous steering response. Even a
    // failed/late steering RPC cannot move this input behind later arrivals.
    const work = this.inboundTail.then(async () => {
      if (await admission) return;
      this.queuedInboundCount -= 1;
      this.queuedWorkCount -= 1;
      this.lastSenderHint = deriveSenderHint(payload);
      resolve(await this.handleInboundOnce(payload, true));
    });
    // One failed turn must not poison the queue for subsequent messages.
    this.inboundTail = work.catch(reject);
    return reply;
  }

  private buildInput(payload: EClawInboundPayload) {
    return [{ type: "text" as const, text: formatInboundForCodex(payload), text_elements: [] }];
  }

  /** Last-seen sender hint, exposed for tests / status surfaces. */
  getLastSenderHint(): SenderHint | undefined {
    return this.lastSenderHint;
  }

  private async handleInboundOnce(payload: EClawInboundPayload, retryOnMissingThread: boolean): Promise<string> {
    const state = await this.stateStore.read();
    const threadId = await this.ensureThread();
    const turnPromise = this.waitForTurn(threadId, inboundSenderKey(payload));
    void turnPromise.catch(() => undefined);
    if (this.config.bridgeSendBusyUpdates) {
      // Busy updates are status-only — don't trigger speakTo via senderHint
      // even when the inbound was bot-to-bot.
      await this.eclaw.sendMessage(state, "Codex is working...", { busy: true }).catch(() => undefined);
    }
    try {
      const response = await this.codex.request<TurnStartResponse>("turn/start", {
        threadId,
        input: this.buildInput(payload),
        cwd: this.config.codexWorkspace,
        model: state.model ?? this.config.codexModel ?? null,
        effort: this.config.codexReasoningEffort ?? null,
        approvalPolicy: this.config.codexApprovalPolicy,
      });
      const turnId = response.turn?.id;
      if (!turnId) throw new Error("Codex turn/start did not return a turn id.");
      const activeAfterStart = this.activeTurn as ActiveTurn | undefined;
      if (activeAfterStart) {
        activeAfterStart.turnId = turnId;
        this.markActive("turn/start");
        await this.stateStore.write({ activeTurnId: turnId });
        if (activeAfterStart.interrupted) await this.interrupt();
      }
      const reply = await turnPromise;
      await this.sendStopProgressUpdateIfRequired(state, reply);
      return reply;
    } catch (err) {
      const activeAfterError = this.activeTurn as ActiveTurn | undefined;
      if (activeAfterError) {
        clearTimeout(activeAfterError.timer);
        this.activeTurn = undefined;
        // turn/start can reject before anyone awaits turnPromise.
        activeAfterError.resolve("");
      }
      if (retryOnMissingThread && isMissingThreadError(err)) {
        await this.stateStore.clearThread();
        return this.handleInboundOnce(payload, false);
      }
      throw err;
    }
  }

  async interrupt(): Promise<boolean> {
    const active = this.activeTurn;
    if (!active) return false;
    active.interrupted = true;
    // A start RPC may still be in flight; finish cancellation once its exact
    // id is known instead of allowing a competing queued turn to start.
    if (!active.turnId) return true;
    try {
      await this.codex.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
    } catch (err) {
      if (this.activeTurn === active) active.interrupted = false;
      throw err;
    }
    clearTimeout(active.timer);
    if (this.activeTurn === active) {
      this.activeTurn = undefined;
      active.resolve("");
      await this.stateStore.write({ activeTurnId: undefined });
    }
    return true;
  }

  async reset(): Promise<BridgeState> {
    const state = await this.stateStore.read();
    if (state.threadId) {
      await this.codex.request("thread/archive", { threadId: state.threadId }).catch(() => undefined);
    }
    return this.stateStore.clearThread();
  }

  status(): {
    activeTurnId?: string;
    activeThreadId?: string;
    activePrompt?: string;
    activeStartedAt?: string;
    activeElapsedMs?: number;
    lastActivityAt?: string;
    lastEvent?: string;
    bufferedChars: number;
    lastTurnError?: string;
    queuedInboundCount?: number;
    steeredInboundCount?: number;
    steerFallbackCount?: number;
    lastInboundAt?: string;
    lastSteeredAt?: string;
  } {
    const now = Date.now();
    return {
      activeTurnId: this.activeTurn?.turnId,
      activeThreadId: this.activeTurn?.threadId,
      activePrompt: this.activeTurn ? REDACTED_ACTIVE_PROMPT : undefined,
      activeStartedAt: this.activeTurn ? new Date(this.activeTurn.startedAt).toISOString() : undefined,
      activeElapsedMs: this.activeTurn ? now - this.activeTurn.startedAt : undefined,
      lastActivityAt: this.activeTurn ? new Date(this.activeTurn.lastActivityAt).toISOString() : undefined,
      lastEvent: this.activeTurn?.lastEvent,
      bufferedChars: this.activeTurn?.text.length ?? 0,
      lastTurnError: this.lastTurnError,
      queuedInboundCount: this.queuedInboundCount,
      steeredInboundCount: this.steeredInboundCount,
      steerFallbackCount: this.steerFallbackCount,
      lastInboundAt: this.lastInboundAt,
      lastSteeredAt: this.lastSteeredAt,
    };
  }

  private waitForTurn(threadId: string, senderKey?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTurn = undefined;
        reject(new Error("Codex reply timed out."));
      }, this.config.bridgeReplyTimeoutMs);
      const now = Date.now();
      this.activeTurn = {
        threadId,
        senderKey,
        text: "",
        startedAt: now,
        lastActivityAt: now,
        lastEvent: "turn/queued",
        resolve,
        reject,
        timer,
      };
    });
  }

  private handleNotification(message: ServerNotificationMessage): void {
    const params = (message.params ?? {}) as Record<string, any>;
    if (!this.activeTurn) return;
    if (params.threadId && params.threadId !== this.activeTurn.threadId) return;
    if (this.activeTurn.turnId && params.turnId && params.turnId !== this.activeTurn.turnId) return;

    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.activeTurn.text += params.delta;
      this.markActive(message.method);
      return;
    }

    if (message.method === "item/completed") {
      const text = this.extractAgentMessage(params.item);
      if (text) this.activeTurn.text = text;
      this.markActive(describeItemEvent(params.item, message.method));
      return;
    }

    if (message.method === "rawResponseItem/completed") {
      const text = this.extractRawResponseText(params.item);
      if (text) this.activeTurn.text = text;
      this.markActive(describeItemEvent(params.item, message.method));
      return;
    }

    if (message.method === "turn/completed") {
      const active = this.activeTurn;
      const turnError = this.extractTurnError(params);
      const text = active.interrupted || params.turn?.status === "interrupted"
        ? ""
        : turnError || this.extractFinalText(params) || active.text.trim() || "Done.";
      this.lastTurnError = turnError || undefined;
      clearTimeout(active.timer);
      this.activeTurn = undefined;
      // A queued turn must not race the previous turn's persisted cleanup.
      this.stateStore.write({ activeTurnId: undefined }).then(() => active.resolve(text), active.reject);
    }
  }

  private markActive(event: string): void {
    if (!this.activeTurn) return;
    this.activeTurn.lastActivityAt = Date.now();
    this.activeTurn.lastEvent = event;
  }

  private extractFinalText(params: Record<string, any>): string {
    const items = params.turn?.items;
    if (!Array.isArray(items)) return "";
    const finalMessages = items
      .map((item) => this.extractAgentMessage(item, true))
      .filter(Boolean);
    if (finalMessages.length > 0) return finalMessages.at(-1) ?? "";
    return items
      .map((item) => this.extractAgentMessage(item))
      .filter(Boolean)
      .at(-1) ?? "";
  }

  private extractAgentMessage(item: any, finalOnly = false): string {
    if (item?.type !== "agentMessage" || typeof item?.text !== "string") return "";
    if (finalOnly && item.phase && item.phase !== "final_answer" && item.phase !== "final") return "";
    return item.text.trim();
  }

  private extractTurnError(params: Record<string, any>): string {
    const errorMessage = params.turn?.error?.message;
    if (params.turn?.status !== "failed" || typeof errorMessage !== "string") return "";
    return `Codex error: ${errorMessage}`;
  }

  private extractRawResponseText(item: any): string {
    if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return "";
    return item.content
      .filter((content: any) => content?.type === "output_text" && typeof content.text === "string")
      .map((content: any) => content.text)
      .join("")
      .trim();
  }

  private async baseInstructions(state: BridgeState): Promise<string> {
    const localInstructions = [
      "You are Codex connected to EClawbot through a channel bridge.",
      "EClaw users only see final replies sent by the bridge; they do not see terminal output.",
      "When the user asks for code work, inspect the repository, make changes, run verification, and summarize the result.",
      "For long-running work, first send a short test plan/status outline before deep execution.",
      "While working through a long task, provide concise progress updates after meaningful milestones, including what step you are on, the last command or tool action, and whether you are blocked.",
      "If you are blocked by approval, a tool error, a pending command, quota, or missing context, say that explicitly instead of staying silent.",
      "Keep final replies concise and user-facing.",
      "Never reveal API keys, secrets, auth tokens, or private device credentials.",
    ].join("\n");

    const remotePolicy = await this.eclaw.getPromptPolicy(state, "codex").catch(() => null);
    const compiledPrompt = remotePolicy?.policy?.compiledPrompt?.trim();
    const routingPolicy = await this.fetchRoutingPolicyOnce();

    const blocks: string[] = [localInstructions];
    if (routingPolicy) {
      blocks.push(
        "EClaw central smart-routing policy (server-managed, EClaw#2285):",
        routingPolicy,
      );
    }
    if (compiledPrompt) {
      blocks.push(
        "The following EClaw backend prompt policy is centrally managed and applies to this entity/channel:",
        compiledPrompt,
      );
    }
    return blocks.join("\n\n");
  }

  /**
   * Fetch the smart-routing policy once per process. The policy is static, so
   * we cache the result in memory; a refresh requires a bridge restart. Fails
   * open with "" so older servers (pre-EClaw#2287) don't break delivery.
   */
  private async fetchRoutingPolicyOnce(): Promise<string> {
    if (this.routingPolicy !== undefined) return this.routingPolicy;
    this.routingPolicy = await this.eclaw.getRoutingPolicy("codex", "en").catch(() => "");
    return this.routingPolicy;
  }

  private async sendStopProgressUpdateIfRequired(state: BridgeState, reply: string): Promise<void> {
    if (!this.config.bridgeStopProgressUpdates) return;
    const remotePolicy = await this.eclaw.getPromptPolicy(state, "codex").catch(() => null);
    const compiledPrompt = remotePolicy?.policy?.compiledPrompt ?? "";
    if (!requiresStopProgressTransform(compiledPrompt)) return;

    const summary = summarizePromptForStatus(reply || "Final reply ready.");
    await this.eclaw.sendMessage(
      state,
      [
        "EClaw progress update",
        `目前進度：本輪任務已完成，正在送出最終回覆。${summary ? `摘要：${summary}` : ""}`,
        "阻塞點：無。",
        "下一步：等待下一個指令。",
      ].join("\n"),
      { busy: true },
    ).catch(() => undefined);
  }

  /**
   * Send Codex's final answer to EClaw. Wraps `eclaw.sendMessage` so the
   * captured senderHint from the most recent inbound is propagated, letting
   * the EClaw server resolve speakTo centrally (EClaw#2285 Phase 3).
   */
  async sendCodexReply(state: BridgeState, reply: string, options: { card?: any; senderHint?: SenderHint } = {}): Promise<void> {
    const senderHint = options.senderHint ?? this.lastSenderHint;
    await this.eclaw.sendMessage(state, reply, { ...options, ...(senderHint ? { senderHint } : {}) });
  }
}

export function requiresStopProgressTransform(compiledPrompt: string): boolean {
  const text = compiledPrompt.toLowerCase();
  return (
    text.includes("transform api") &&
    (text.includes("停下手邊工作前") || text.includes("before stopping") || text.includes("before final"))
  );
}

function isMissingThreadError(err: unknown): boolean {
  return err instanceof Error && /thread not found/i.test(err.message);
}

// System notifications have independent work/routing semantics, so queue them.
// Human follow-ups across web/mobile may steer each other on the same device.
function inboundSenderKey(payload: EClawInboundPayload): string | undefined {
  const scope = `${payload.deviceId}:${payload.entityId}`;
  const from = (payload.from ?? "").toLowerCase();
  if (payload.isBroadcast || (payload.event && payload.event !== "message") || ["system", "kanban", "kanban_notify", "org_forward"].includes(from)) return undefined;
  if (typeof payload.fromEntityId === "number") return `${scope}:entity:${payload.fromEntityId}`;
  if (payload.fromPublicCode) return `${scope}:code:${payload.fromPublicCode}`;
  if (["client", "user", "web_chat", "android", "android_app", "ios", "ios_app", "local-ask"].includes(from)) {
    return `${scope}:human`;
  }
  return undefined;
}

function summarizePromptForStatus(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 120);
}

function describeItemEvent(item: any, fallback: string): string {
  if (item?.type) return `item:${item.type}`;
  if (item?.name) return `item:${item.name}`;
  return fallback;
}

/**
 * Map an inbound payload to a SenderHint shaped for /api/channel/message.
 *
 * - bot-to-bot: payload.fromEntityId is the speaker → kind=entity
 * - real user via /api/client/speak: payload.from === "client" → kind=user
 * - system events (kanban, watchdog): payload.from === "system" → kind=user
 *   (treated as no-routing: the system shows the reply through chat history,
 *   not a directed @mention)
 * - broadcast inbound: kind=broadcast — but only when explicitly flagged so
 *   we don't accidentally re-broadcast every reply.
 * - everything else: kind=unknown → no routing.
 */
export function deriveSenderHint(payload: EClawInboundPayload): SenderHint {
  if (payload.isBroadcast) return { kind: "broadcast" };
  const fromKey = (payload.from ?? "").toLowerCase();
  if (fromKey === "client" || fromKey === "user" || fromKey === "system" || fromKey === "kanban") {
    return { kind: "user" };
  }
  if (typeof payload.fromEntityId === "number" || typeof payload.fromPublicCode === "string") {
    return {
      kind: "entity",
      ...(typeof payload.fromEntityId === "number" ? { entityId: payload.fromEntityId } : {}),
      ...(payload.fromPublicCode ? { publicCode: payload.fromPublicCode } : {}),
    };
  }
  return { kind: "unknown" };
}
