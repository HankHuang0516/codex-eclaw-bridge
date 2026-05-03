import type { EClawInboundPayload } from "./types.js";

const NOOP_EXACT = new Set([
  "[silent]",
  "done",
  "done.",
  "ack",
  "ack.",
  "received",
  "received.",
  "收到",
  "收到。",
  "已收到",
  "已收到。",
  "完成",
  "完成。",
  "已完成",
  "已完成。",
]);

export function isNoopCompletionText(text: string | undefined | null): boolean {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return true;
  if (NOOP_EXACT.has(normalized)) return true;
  return isNoopProgressTemplate(normalized);
}

export function shouldEmitOutboundReply(reply: string | undefined | null, payload: EClawInboundPayload): boolean {
  const text = (reply ?? "").trim();
  if (!text) return false;
  if (isNoopCompletionText(text)) return false;
  if (isA2AInbound(payload) && isNoopA2AEcho(text)) return false;
  return true;
}

function normalizeCompletionText(text: string | undefined | null): string {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim()
    .toLowerCase();
}

function isNoopProgressTemplate(text: string): boolean {
  if (!text.startsWith("eclaw progress update\n")) return false;
  if (!text.includes("本輪任務已完成")) return false;
  if (!text.includes("正在送出最終回覆")) return false;
  if (!text.includes("阻塞點：無")) return false;
  if (!text.includes("下一步：等待下一個指令")) return false;

  const summary = text.match(/摘要：([\s\S]*?)(?:\n阻塞點：無|$)/)?.[1]?.trim();
  return !summary || NOOP_EXACT.has(summary);
}

function isA2AInbound(payload: EClawInboundPayload): boolean {
  if (payload.fromEntityId !== undefined && payload.fromEntityId !== null) return true;

  const event = String(payload.event ?? "").toLowerCase();
  if (["entity_message", "broadcast", "org_forward"].includes(event)) return true;

  const from = String(payload.from ?? "").toLowerCase();
  if (from.startsWith("entity:") || from.startsWith("xdevice:")) return true;

  const text = payload.text ?? "";
  return /^\[(bot-to-bot message|broadcast from|org forward)\b/i.test(text);
}

function isNoopA2AEcho(text: string): boolean {
  return /^ack(?:\s+post-\d+-verify-\S*)?\.?$/i.test(text.trim());
}
