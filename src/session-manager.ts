import type { CodexClient } from "./codex-client.js";
import type { EClawClient } from "./eclaw-client.js";
import { formatInboundForCodex } from "./payload.js";
import type { StateStore } from "./state-store.js";
import type { BridgeConfig, BridgeState, EClawInboundPayload, ServerNotificationMessage } from "./types.js";

type ThreadStartResponse = {
  thread?: { id?: string };
};

type TurnStartResponse = {
  turn?: { id?: string };
};

type ActiveTurn = {
  threadId: string;
  turnId?: string;
  text: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class SessionManager {
  private activeTurn?: ActiveTurn;
  private readonly resumedThreads = new Set<string>();
  private lastTurnError?: string;

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
    if (state.threadId) {
      if (!this.resumedThreads.has(state.threadId)) {
        try {
          await this.codex.request("thread/resume", {
            threadId: state.threadId,
            cwd: this.config.codexWorkspace,
            model: state.model ?? this.config.codexModel ?? null,
            approvalPolicy: this.config.codexApprovalPolicy,
            sandbox: this.config.codexSandbox,
            baseInstructions: this.baseInstructions(),
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
      baseInstructions: this.baseInstructions(),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("Codex thread/start did not return a thread id.");
    await this.stateStore.write({ threadId });
    return threadId;
  }

  async handleInbound(payload: EClawInboundPayload): Promise<string> {
    return this.handleInboundOnce(payload, true);
  }

  private async handleInboundOnce(payload: EClawInboundPayload, retryOnMissingThread: boolean): Promise<string> {
    if (this.activeTurn) {
      throw new Error("Codex is still processing the previous message. Use /interrupt if you want to stop it.");
    }
    const state = await this.stateStore.read();
    const threadId = await this.ensureThread();
    const turnPromise = this.waitForTurn(threadId);
    if (this.config.bridgeSendBusyUpdates) {
      await this.eclaw.sendMessage(state, "Codex is working...", { busy: true }).catch(() => undefined);
    }
    const input = formatInboundForCodex(payload);
    try {
      const response = await this.codex.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: input, text_elements: [] }],
        cwd: this.config.codexWorkspace,
        model: state.model ?? this.config.codexModel ?? null,
        effort: this.config.codexReasoningEffort ?? null,
        approvalPolicy: this.config.codexApprovalPolicy,
      });
      const turnId = response.turn?.id;
      if (!turnId) throw new Error("Codex turn/start did not return a turn id.");
      const activeAfterStart = this.activeTurn as ActiveTurn | undefined;
      if (activeAfterStart) activeAfterStart.turnId = turnId;
      await this.stateStore.write({ activeTurnId: turnId });
      return await turnPromise;
    } catch (err) {
      const activeAfterError = this.activeTurn as ActiveTurn | undefined;
      if (activeAfterError) {
        clearTimeout(activeAfterError.timer);
        this.activeTurn = undefined;
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
    clearTimeout(active.timer);
    this.activeTurn = undefined;
    active.resolve("");
    await this.stateStore.write({ activeTurnId: undefined });
    if (active.turnId) {
      await this.codex.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
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

  status(): { activeTurnId?: string; activeThreadId?: string; bufferedChars: number; lastTurnError?: string } {
    return {
      activeTurnId: this.activeTurn?.turnId,
      activeThreadId: this.activeTurn?.threadId,
      bufferedChars: this.activeTurn?.text.length ?? 0,
      lastTurnError: this.lastTurnError,
    };
  }

  private waitForTurn(threadId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTurn = undefined;
        reject(new Error("Codex reply timed out."));
      }, this.config.bridgeReplyTimeoutMs);
      this.activeTurn = { threadId, text: "", resolve, reject, timer };
    });
  }

  private handleNotification(message: ServerNotificationMessage): void {
    const params = (message.params ?? {}) as Record<string, any>;
    if (!this.activeTurn) return;
    if (params.threadId && params.threadId !== this.activeTurn.threadId) return;
    if (this.activeTurn.turnId && params.turnId && params.turnId !== this.activeTurn.turnId) return;

    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.activeTurn.text += params.delta;
      return;
    }

    if (message.method === "item/completed") {
      const text = this.extractAgentMessage(params.item);
      if (text) this.activeTurn.text = text;
      return;
    }

    if (message.method === "rawResponseItem/completed") {
      const text = this.extractRawResponseText(params.item);
      if (text) this.activeTurn.text = text;
      return;
    }

    if (message.method === "turn/completed") {
      const turnError = this.extractTurnError(params);
      const text = turnError || this.extractFinalText(params) || this.activeTurn.text.trim() || "Done.";
      this.lastTurnError = turnError || undefined;
      clearTimeout(this.activeTurn.timer);
      this.activeTurn.resolve(text);
      this.stateStore.write({ activeTurnId: undefined }).catch(() => undefined);
      this.activeTurn = undefined;
    }
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

  private baseInstructions(): string {
    return [
      "You are Codex connected to EClawbot through a channel bridge.",
      "EClaw users only see final replies sent by the bridge; they do not see terminal output.",
      "When the user asks for code work, inspect the repository, make changes, run verification, and summarize the result.",
      "Keep final replies concise and user-facing.",
      "Never reveal API keys, secrets, auth tokens, or private device credentials.",
    ].join("\n");
  }
}

function isMissingThreadError(err: unknown): boolean {
  return err instanceof Error && /thread not found/i.test(err.message);
}
