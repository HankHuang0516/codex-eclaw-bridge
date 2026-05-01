import type { EClawInboundPayload } from "./types.js";

export function shouldIgnoreInbound(payload: EClawInboundPayload): { ignore: boolean; reason?: string } {
  const text = (payload.text ?? "").trim();
  const silentToken = payload.eclaw_context?.silentToken ?? "[SILENT]";
  if (!text && payload.event !== "card_action") return { ignore: true, reason: "empty_text" };
  if (text.toLowerCase() === silentToken.toLowerCase()) return { ignore: true, reason: "silent_token" };
  if (payload.from === "system" && payload.eclaw_context?.expectsReply === false) {
    return { ignore: true, reason: "system_no_reply" };
  }
  if (payload.event === "kanban_notification" && payload.eclaw_context?.expectsReply !== true) {
    return { ignore: true, reason: "kanban_notification_no_reply" };
  }
  if (payload.eclaw_context?.expectsReply === false) {
    return { ignore: true, reason: "expects_reply_false" };
  }
  return { ignore: false };
}

export function formatInboundForCodex(payload: EClawInboundPayload): string {
  const lines = [
    "You received an EClawbot channel message.",
    "",
    "Reply to the human by producing a normal final answer. The bridge will deliver your final answer back to EClawbot.",
    "Do not mention internal JSON-RPC, webhook, or bridge implementation details unless the user asks.",
    "",
    "EClaw metadata:",
    `- event: ${payload.event ?? "message"}`,
    `- from: ${payload.from ?? "client"}`,
    `- deviceId: ${payload.deviceId}`,
    `- entityId: ${payload.entityId}`,
  ];
  if (payload.fromEntityId !== undefined) lines.push(`- fromEntityId: ${payload.fromEntityId}`);
  if (payload.fromCharacter) lines.push(`- fromCharacter: ${payload.fromCharacter}`);
  const text = payload.text ?? "";
  const hasInlinedMissionHints = payload.contextInlined || text.includes("[AVAILABLE TOOLS");
  if (payload.eclaw_context?.missionHints && !hasInlinedMissionHints) {
    lines.push("", "Mission/API hints from EClaw:", payload.eclaw_context.missionHints);
  }
  lines.push("", "User message:", text);
  return lines.join("\n");
}

export function isBridgeCommand(text: string): boolean {
  const trimmed = text.trim();
  return /^\/(?:status|reset|interrupt|model)(?:\s|$)/i.test(trimmed) ||
    /^!codex(?:\s+(?:status|reset|interrupt|model)(?:\s|$)|\s*$)/i.test(trimmed);
}

export function parseBridgeCommand(text: string): { name: string; args: string } {
  const trimmed = text.trim();
  const codexMatch = trimmed.match(/^!codex(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i);
  if (codexMatch) {
    return {
      name: (codexMatch[1] ?? "status").toLowerCase(),
      args: (codexMatch[2] ?? "").trim(),
    };
  }
  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  return {
    name: (match?.[1] ?? "").toLowerCase(),
    args: (match?.[2] ?? "").trim(),
  };
}
