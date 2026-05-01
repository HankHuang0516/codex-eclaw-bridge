import { nanoid } from "nanoid";
import type { CodexClient } from "./codex-client.js";
import type { EClawClient } from "./eclaw-client.js";
import type { StateStore } from "./state-store.js";
import type { ApprovalRequest, BridgeConfig, EClawCard, EClawInboundPayload, ServerRequestMessage } from "./types.js";

type PendingApproval = ApprovalRequest & {
  askId: string;
  createdAt: number;
  timeout: NodeJS.Timeout;
};

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
]);

export class ApprovalRouter {
  private pending = new Map<string, PendingApproval>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly codex: CodexClient,
    private readonly eclaw: EClawClient,
    private readonly stateStore: StateStore,
  ) {}

  canHandle(message: ServerRequestMessage): boolean {
    return APPROVAL_METHODS.has(message.method);
  }

  async handle(message: ServerRequestMessage): Promise<void> {
    const request = this.describeRequest(message);
    const askId = `codex_${nanoid(12)}`;
    const timeout = setTimeout(() => {
      this.pending.delete(askId);
      this.codex.fail(message.id, -32000, "Approval timed out.");
    }, this.config.bridgeApprovalTimeoutMs);

    this.pending.set(askId, { ...request, askId, timeout, createdAt: Date.now() });
    const card: EClawCard = {
      ask_id: askId,
      title: request.title,
      body: request.body,
      buttons: this.buttonsFor(request),
    };
    const state = await this.stateStore.read();
    await this.eclaw.sendMessage(state, request.body, { card });
  }

  resolveFromPayload(payload: EClawInboundPayload): boolean {
    const askId = payload.ask_id ?? undefined;
    const actionId = payload.action_id ?? undefined;
    if (!askId || !actionId) return false;
    const pending = this.pending.get(askId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pending.delete(askId);
    const response = this.responseFor(pending.method, actionId, pending.rawParams);
    this.codex.respond(pending.rpcId, response);
    return true;
  }

  status(): { pending: number; askIds: string[] } {
    return { pending: this.pending.size, askIds: [...this.pending.keys()] };
  }

  private describeRequest(message: ServerRequestMessage): ApprovalRequest {
    const params = (message.params ?? {}) as Record<string, any>;
    const command = params.command ? `\n\nCommand:\n${params.command}` : "";
    const cwd = params.cwd ? `\n\nWorking directory:\n${params.cwd}` : "";
    const reason = params.reason ? `\n\nReason:\n${params.reason}` : "";
    const question = params.questions
      ? `\n\nQuestions:\n${JSON.stringify(params.questions, null, 2)}`
      : "";
    const title = this.titleFor(message.method);
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : ["approve", "approveForSession", "deny"];

    return {
      rpcId: message.id,
      method: message.method,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      title,
      body: `${title}${reason}${command}${cwd}${question}`.trim(),
      availableDecisions,
      rawParams: params,
    };
  }

  private titleFor(method: string): string {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval":
        return "Codex requests command approval";
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
        return "Codex requests file change approval";
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request":
        return "Codex requests input";
      case "item/permissions/requestApproval":
        return "Codex requests permission";
      default:
        return "Codex requests approval";
    }
  }

  private buttonsFor(request: ApprovalRequest): EClawCard["buttons"] {
    if (request.method === "item/tool/requestUserInput" || request.method === "mcpServer/elicitation/request") {
      return [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ];
    }
    return [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "approve_for_session", label: "Approve for session", style: "secondary" },
      { id: "deny", label: "Deny", style: "danger" },
    ];
  }

  private responseFor(method: string, actionId: string, rawParams: unknown): unknown {
    const denied = actionId === "deny" || actionId === "decline";
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      return { decision: denied ? "decline" : actionId === "approve_for_session" ? "acceptForSession" : "accept" };
    }
    if (method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request") {
      if (denied) return { answers: {} };
      const params = rawParams as { questions?: Array<{ id: string; options?: Array<{ label: string }> | null }> };
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of params.questions ?? []) {
        const first = q.options?.[0]?.label ?? "Approved";
        answers[q.id] = { answers: [first] };
      }
      return { answers };
    }
    return { decision: denied ? "deny" : actionId === "approve_for_session" ? "approveForSession" : "approve" };
  }
}
