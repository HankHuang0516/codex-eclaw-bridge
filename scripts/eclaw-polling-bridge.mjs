#!/usr/bin/env node
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const apiBase = process.env.ECLAW_API_BASE || "https://eclawbot.com";
const root = path.resolve(process.env.CODEX_ECLAW_BRIDGE_DIR || process.cwd());
const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const nonNegativeNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const booleanFlag = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};
const statePath = path.resolve(process.env.BRIDGE_STATE_PATH || path.join(root, ".data/state.json"));
const workspace = process.env.CODEX_WORKSPACE || "/Users/hank/Desktop/Project";
const pollMs = Number(process.env.ECLAW_POLL_MS || 30000);
const useCodex = process.env.CODEX_POLL_BRIDGE_USE_CODEX === "1";
const codexBin = process.env.CODEX_BIN || "codex";
const codexModel = process.env.CODEX_MODEL || "gpt-5.5";
const codexReasoningEffort = process.env.CODEX_REASONING_EFFORT || "xhigh";
const codexReportModel = process.env.CODEX_REPORT_MODEL || "GPT-5.5";
const codexReportReasoning = process.env.CODEX_REPORT_REASONING || "extrahigh";
const codexSandbox = process.env.CODEX_POLL_BRIDGE_SANDBOX || "workspace-write";
const codexBypassApprovals = process.env.CODEX_POLL_BRIDGE_BYPASS_APPROVALS === "1";
const codexTimeoutMs = positiveNumber(process.env.CODEX_POLL_BRIDGE_TIMEOUT_MS, 20 * 60_000);
const codexNearTimeoutWarningMs = nonNegativeNumber(
  process.env.CODEX_POLL_BRIDGE_NEAR_TIMEOUT_WARNING_MS,
  15 * 60_000,
);
const codexNearTimeoutCancelMs = positiveNumber(
  process.env.CODEX_POLL_BRIDGE_NEAR_TIMEOUT_CANCEL_MS,
  18 * 60_000,
);
const codexTerminateGraceMs = positiveNumber(process.env.CODEX_POLL_BRIDGE_TERMINATE_GRACE_MS, 2 * 60_000);
const codexDiagnosticLog = path.resolve(
  process.env.CODEX_POLL_BRIDGE_DIAGNOSTIC_LOG || path.join(root, ".data/codex-exec-diagnostics.jsonl"),
);
const busyHeartbeatDisabled = booleanFlag(process.env.BUSY_HEARTBEAT_DISABLED, false);
const codexStatusUpdatesEnabled =
  !busyHeartbeatDisabled && booleanFlag(process.env.CODEX_POLL_BRIDGE_STATUS_UPDATES, false);
const codexNearTimeoutWarningEnabled =
  !busyHeartbeatDisabled && codexNearTimeoutWarningMs > 0 && codexNearTimeoutWarningMs < codexTimeoutMs;
const codexNearTimeoutCancelEnabled = codexNearTimeoutCancelMs > 0 && codexNearTimeoutCancelMs < codexTimeoutMs;
const codexStatusInitialMs = positiveNumber(process.env.CODEX_POLL_BRIDGE_STATUS_INITIAL_MS, 30000);
const codexStatusMs = positiveNumber(process.env.CODEX_POLL_BRIDGE_STATUS_MS, 180000);
const directProbePollMs = positiveNumber(
  process.env.ECLAW_DIRECT_PROBE_POLL_MS,
  Math.max(60000, pollMs * 2),
);
const rateLimitBackoffBaseMs = positiveNumber(process.env.ECLAW_RATE_LIMIT_BACKOFF_BASE_MS, 60_000);
const rateLimitBackoffMaxMs = positiveNumber(process.env.ECLAW_RATE_LIMIT_BACKOFF_MAX_MS, 5 * 60_000);
const redactedTaskPreview = "[task in progress - preview redacted to prevent secret leak]";

const seen = new Set();
const startMs = Date.now() - 5000;
let entityCodeById = new Map();
let directProbePollActive = false;
const rateLimitState = {
  poll: { failures: 0, until: 0 },
  directProbe: { failures: 0, until: 0 },
};

function log(message, extra = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...extra }));
}

process.on("uncaughtException", (error) => {
  log("fatal uncaughtException", { error: compactError(error) });
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  log("fatal unhandledRejection", { error: compactError(error) });
  process.exitCode = 1;
});

async function readState() {
  const raw = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  if (!state.deviceId || state.entityId == null || !state.botSecret) {
    throw new Error(`State file is missing deviceId/entityId/botSecret: ${statePath}`);
  }
  return state;
}

async function apiGet(pathname, query) {
  const url = new URL(pathname, apiBase);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const error = new Error(data.message || data.error || `${pathname} failed with HTTP ${res.status}`);
    error.status = res.status;
    error.retryAfter = res.headers.get("retry-after");
    throw error;
  }
  return data;
}

async function apiPost(pathname, body) {
  const res = await fetch(new URL(pathname, apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const error = new Error(data.message || data.error || `${pathname} failed with HTTP ${res.status}`);
    error.status = res.status;
    error.retryAfter = res.headers.get("retry-after");
    throw error;
  }
  return data;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRateLimitError(error) {
  return Number(error?.status) === 429 || /too many|rate.?limit/i.test(String(error?.message || error || ""));
}

export function nextRateLimitBackoffMs(failures, options = {}) {
  const baseMs = positiveNumber(options.baseMs, rateLimitBackoffBaseMs);
  const maxMs = positiveNumber(options.maxMs, rateLimitBackoffMaxMs);
  const exponent = Math.max(0, Math.min(8, Number(failures || 1) - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function rateLimitRemainingMs(kind, now = Date.now()) {
  return Math.max(0, (rateLimitState[kind]?.until || 0) - now);
}

function recordRateLimit(kind, error) {
  const state = rateLimitState[kind];
  if (!state) return 0;
  state.failures += 1;
  const retryAfterMs = Number(error?.retryAfter) > 0 ? Number(error.retryAfter) * 1000 : 0;
  const delayMs = Math.max(retryAfterMs, nextRateLimitBackoffMs(state.failures));
  state.until = Date.now() + delayMs;
  log("rate_limit_backoff", {
    kind,
    failures: state.failures,
    delayMs,
    until: new Date(state.until).toISOString(),
    error: compactError(error),
  });
  return delayMs;
}

function clearRateLimit(kind) {
  const state = rateLimitState[kind];
  if (!state) return;
  state.failures = 0;
  state.until = 0;
}

async function refreshEntities(state) {
  const data = await apiGet("/api/entities", {
    deviceId: state.deviceId,
    entityId: state.entityId,
    botSecret: state.botSecret,
  });
  const entities = Array.isArray(data) ? data : data.entities || [];
  entityCodeById = new Map(
    entities
      .filter((entity) => entity.publicCode && entity.entityId != null)
      .map((entity) => [Number(entity.entityId), entity.publicCode]),
  );
}

export async function refreshEntitiesWithRetry(state, options = {}) {
  const attempts = Math.max(1, Number(options.attempts ?? 6));
  const delayMs = Math.max(0, Number(options.delayMs ?? 10_000));
  const refresh = options.refresh ?? refreshEntities;
  const sleepFn = options.sleep ?? sleep;
  const phase = options.phase || "refresh";
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await refresh(state);
      return true;
    } catch (error) {
      lastError = error;
      log("entity cache refresh failed", {
        phase,
        attempt,
        attempts,
        error: compactError(error),
      });
      if (attempt < attempts && delayMs > 0) {
        await sleepFn(delayMs);
      }
    }
  }

  log("entity cache refresh unavailable; continuing with current routing cache", {
    phase,
    error: compactError(lastError),
  });
  return false;
}

function senderEntityId(source) {
  const match = /^entity:(\d+):/.exec(String(source || ""));
  return match ? Number(match[1]) : null;
}

function isOwnBotMessage(message, state) {
  const source = String(message.source || "");
  if (source.startsWith(`entity:${state.entityId}:`)) return true;
  if (source.startsWith("entity:")) return false;
  return Number(message.entity_id) === Number(state.entityId) &&
    Boolean(message.is_from_bot || message.from_bot);
}

function replyFor(text) {
  const health = /\bECLAW_HEALTHCHECK\s+([A-Za-z0-9_-]+)/.exec(text);
  if (health) return `ACK ${health[1]}`;

  const pong = /reply with ['"]?(pong-[A-Za-z0-9_-]+)['"]?/i.exec(text);
  if (pong) return pong[1];

  if (!useCodex) {
    return "Codex polling bridge is online. Message received.";
  }
  return null;
}

function hasDirectProbeReply(text) {
  return /\bECLAW_HEALTHCHECK\s+[A-Za-z0-9_-]+/.test(text)
    || /reply with ['"]?pong-[A-Za-z0-9_-]+['"]?/i.test(text);
}

function isModelHealthProbe(text) {
  return /\bMODEL_HEALTHCHECK\s+[A-Za-z0-9_-]+/.test(text);
}

function isSilentInbound(text) {
  return /\[SILENT\]/i.test(String(text || ""));
}

export function pollPriority(message) {
  const text = String(message?.text || "");
  if (hasDirectProbeReply(text)) return 0;
  if (isModelHealthProbe(text)) return 1;
  return 2;
}

export function prioritizePollMessages(messages) {
  return messages
    .map((message, index) => ({ message, index, priority: pollPriority(message) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.message);
}

function shouldSkipInboundMessage(message, state) {
  if (!message?.id || seen.has(message.id)) return true;

  const text = String(message.text || "");
  if (!text.trim()) {
    seen.add(message.id);
    return true;
  }
  if (isSilentInbound(text)) {
    seen.add(message.id);
    return true;
  }
  if (isOwnBotMessage(message, state)) {
    seen.add(message.id);
    return true;
  }
  if (/^ACK\b/.test(text.trim())) {
    seen.add(message.id);
    return true;
  }
  if (Number(message.entity_id) === state.entityId && /^ACK\b/.test(text.trim())) {
    seen.add(message.id);
    return true;
  }
  return false;
}

function compactError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 320);
}

function redactDiagnosticText(value) {
  return String(value || "")
    .replace(/(bearer\s+)[^\s"']+/ig, "$1[REDACTED]")
    .replace(
      /((?:["']?(?:api[_-]?key|botSecret|deviceSecret|password|secret|token)["']?\s*[:=]\s*["']?))[^\s"',}]+/ig,
      "$1[REDACTED]",
    );
}

function tailDiagnosticText(value, limit = 8000) {
  return redactDiagnosticText(String(value || "").replace(/\r/g, "").slice(-limit));
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function readOutputTail(outputPath) {
  try {
    return tailDiagnosticText(fsSync.readFileSync(outputPath, "utf8"));
  } catch {
    return "";
  }
}

function writeCodexDiagnostic(event) {
  try {
    fsSync.mkdirSync(path.dirname(codexDiagnosticLog), { recursive: true });
    fsSync.appendFileSync(
      codexDiagnosticLog,
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
    );
  } catch (error) {
    log("codex diagnostic write failed", { error: compactError(error) });
  }
}

function blockedReplyFor(text, error) {
  const reason = compactError(error);
  const explicit = /\b([A-Z0-9_]+_BLOCKED\s+[A-Z0-9_]+(?:_[A-Z0-9]+)*)\b/.exec(text);
  if (explicit) return `${explicit[1]} reason=${reason}`;

  const marker = /\b(CU6[A-Z0-9_]*_[0-9]{10,}_[0-9]+|CU6_[A-Z0-9_]+_[0-9]{10,})\b/.exec(text);
  if (marker) return `CU6_BLOCKED ${marker[1]} reason=${reason}`;

  return `#6_BLOCKED reason=${reason}`;
}

export async function runCodex(state, inbound) {
  const text = String(inbound.text || "");
  const source = String(inbound.source || "");
  const inboundId = inbound.id || null;
  const prompt = [
    "You are Codex entity #6 in EClaw.",
    `Runtime model policy: model=${codexReportModel}; reasoning=${codexReportReasoning}. Internal Codex config is CODEX_MODEL=${codexModel} and CODEX_REASONING_EFFORT=${codexReasoningEffort}. If asked to report your current model/reasoning, use model=${codexReportModel} reasoning=${codexReportReasoning} exactly.`,
    "Complete the inbound EClaw request, then reply concisely with what you did or why you are blocked.",
    "If the request asks for Computer Use, browser operation, desktop operation, or visible UI verification, actually use the available Computer Use tools before replying.",
    "Do not satisfy Computer Use requests with shell commands, open, osascript, AppleScript, or API calls; use the Computer Use MCP tools directly.",
    "For browser Computer Use, prefer Google Chrome or Safari. Do not target the Codex app or Codex in-app browser with Computer Use because com.openai.codex is blocked by Computer Use safety policy.",
    "For Chrome navigation, first inspect Google Chrome with Computer Use, then use the address/search field via Computer Use set_value or click+type_text, press Return, and inspect Google Chrome again.",
    "When reporting a browser title or URL from Computer Use, read the active app_state Window/title/URL values after the operation and report those exact values; do not infer from bookmarks, browser history, or the request text.",
    "If Computer Use or another required tool is unavailable, denied, or times out, state the exact blocker and do not claim the task is done.",
    "Do not reveal secrets. Do not make file changes unless the message explicitly asks for code changes.",
    "",
    `Source: ${source || "unknown"}`,
    "Message:",
    text,
  ].join("\n");

  const outputDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "eclaw-codex-reply-"));
  const outputPath = path.join(outputDir, "reply.txt");
  const cleanup = async () => {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  };

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-last-message",
      outputPath,
      "--sandbox",
      codexSandbox,
      "-C",
      workspace,
      "-m",
      codexModel,
      "-c",
      `model_reasoning_effort="${codexReasoningEffort}"`,
      "-",
    ];
    if (codexBypassApprovals) {
      args.splice(1, 0, "--dangerously-bypass-approvals-and-sandbox");
    }
    const diagnosticContext = {
      inboundId: inboundId || null,
      source: String(source || "unknown").slice(0, 160),
      command: [codexBin, ...args].join(" "),
      workspace,
      codexModel,
      codexReasoningEffort,
      codexSandbox,
      codexBypassApprovals,
      timeoutMs: codexTimeoutMs,
      nearTimeoutWarningMs: codexNearTimeoutWarningMs,
      nearTimeoutCancelMs: codexNearTimeoutCancelMs,
      terminateGraceMs: codexTerminateGraceMs,
      textPreview: tailDiagnosticText(text, 500),
    };
    writeCodexDiagnostic({ event: "start", ...diagnosticContext });

    const child = spawn(codexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelTimer = null;
    let sigkillTimer = null;
    let hardTimeoutTimer = null;
    let statusTimer = null;
    let warningTimer = null;
    let statusInFlight = false;
    let codexRunning = true;
    let timeoutCancelSent = false;
    let timeoutKillSent = false;
    let scheduledSigkillAt = null;
    let lastOutputAt = null;
    const clearStatusTimer = () => {
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = null;
    };
    const scheduleStatusUpdate = (delayMs) => {
      if (!codexStatusUpdatesEnabled) return;
      statusTimer = setTimeout(() => {
        if (!codexRunning) return;
        emitStatusUpdate();
        if (codexRunning) scheduleStatusUpdate(codexStatusMs);
      }, delayMs);
      statusTimer.unref?.();
    };
    const emitStatusUpdate = () => {
      if (!codexRunning) return;
      if (statusInFlight) return;
      statusInFlight = true;
      sendCodexStatusUpdate(state, inbound, {
        durationMs: Date.now() - startedAt,
        lastOutputAt,
      })
        .catch((error) => log("codex status update failed", { inboundId, error: compactError(error) }))
        .finally(() => {
          statusInFlight = false;
        });
    };
    const scheduleTimeoutWarning = () => {
      if (!codexNearTimeoutWarningEnabled) return;
      warningTimer = setTimeout(() => {
        if (!codexRunning) return;
        writeCodexDiagnostic({
          event: "timeout_warning",
          ...diagnosticContext,
          durationMs: Date.now() - startedAt,
          stdoutTail: tailDiagnosticText(stdout),
          stderrTail: tailDiagnosticText(stderr),
          outputTail: readOutputTail(outputPath),
        });
        sendCodexTimeoutWarning(state, inbound, {
          durationMs: Date.now() - startedAt,
          lastOutputAt,
        }).catch((error) => log("codex timeout warning failed", { inboundId, error: compactError(error) }));
      }, codexNearTimeoutWarningMs);
      warningTimer.unref?.();
    };
    const sendTimeoutKill = (trigger) => {
      if (!codexRunning || timeoutKillSent) return;
      timedOut = true;
      timeoutKillSent = true;
      const killed = child.kill("SIGKILL");
      writeCodexDiagnostic({
        event: "timeout_kill",
        ...diagnosticContext,
        durationMs: Date.now() - startedAt,
        trigger,
        killed,
        stdoutTail: tailDiagnosticText(stdout),
        stderrTail: tailDiagnosticText(stderr),
        outputTail: readOutputTail(outputPath),
      });
    };
    const sendTimeoutCancel = (trigger) => {
      if (!codexRunning || timeoutCancelSent) return;
      timedOut = true;
      timeoutCancelSent = true;
      const killed = child.kill("SIGTERM");
      writeCodexDiagnostic({
        event: "timeout_cancel",
        ...diagnosticContext,
        durationMs: Date.now() - startedAt,
        trigger,
        killed,
        stdoutTail: tailDiagnosticText(stdout),
        stderrTail: tailDiagnosticText(stderr),
        outputTail: readOutputTail(outputPath),
      });
      scheduledSigkillAt = startedAt + codexNearTimeoutCancelMs + codexTerminateGraceMs;
      sigkillTimer = setTimeout(() => {
        sendTimeoutKill("terminate_grace");
      }, codexTerminateGraceMs);
      sigkillTimer.unref?.();
    };
    if (codexNearTimeoutCancelEnabled) {
      cancelTimer = setTimeout(() => {
        sendTimeoutCancel("near_timeout_cancel");
      }, codexNearTimeoutCancelMs);
      cancelTimer.unref?.();
    }
    hardTimeoutTimer = setTimeout(() => {
      if (timeoutCancelSent && scheduledSigkillAt != null && scheduledSigkillAt <= startedAt + codexTimeoutMs) {
        return;
      }
      if (!timeoutCancelSent) sendTimeoutCancel("hard_timeout");
      sendTimeoutKill("hard_timeout");
    }, codexTimeoutMs);
    hardTimeoutTimer.unref?.();

    scheduleStatusUpdate(codexStatusInitialMs);
    scheduleTimeoutWarning();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      lastOutputAt = new Date().toISOString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      lastOutputAt = new Date().toISOString();
    });
    child.on("error", (error) => {
      codexRunning = false;
      if (cancelTimer) clearTimeout(cancelTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
      if (warningTimer) clearTimeout(warningTimer);
      clearStatusTimer();
      writeCodexDiagnostic({
        event: "spawn_error",
        ...diagnosticContext,
        durationMs: Date.now() - startedAt,
        error: compactError(error),
        stdoutTail: tailDiagnosticText(stdout),
        stderrTail: tailDiagnosticText(stderr),
        outputTail: readOutputTail(outputPath),
      });
      cleanup();
      reject(error);
    });
    child.on("close", async (code, signal) => {
      codexRunning = false;
      if (cancelTimer) clearTimeout(cancelTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
      if (warningTimer) clearTimeout(warningTimer);
      clearStatusTimer();
      const lastMessage = await fs.readFile(outputPath, "utf8").catch(() => "");
      const outputTail = tailDiagnosticText(lastMessage);
      writeCodexDiagnostic({
        event: timedOut ? "close_after_timeout" : "close",
        ...diagnosticContext,
        durationMs: Date.now() - startedAt,
        code,
        signal,
        stdoutTail: tailDiagnosticText(stdout),
        stderrTail: tailDiagnosticText(stderr),
        outputTail,
      });
      await cleanup();
      if (timedOut) {
        reject(new Error(`codex exec timed out after ${codexTimeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`codex exec exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve(lastMessage.trim() || stdout.trim() || "Codex completed with no text output.");
    });
    child.stdin.end(prompt);
  });
}

function transformRoutingForInbound(inbound) {
  const fromId = senderEntityId(inbound.source);
  const speakTo = fromId != null ? entityCodeById.get(fromId) : null;
  return speakTo ? { speakTo: [speakTo] } : {};
}

async function sendTransformMessage(state, inbound, message, busy = false) {
  const body = {
    deviceId: state.deviceId,
    entityId: state.entityId,
    botSecret: state.botSecret,
    state: busy ? "BUSY" : "IDLE",
    message,
    ...transformRoutingForInbound(inbound),
  };
  await apiPost("/api/transform", body);
}

export function buildCodexStatusUpdateMessage(status, timeoutMs = codexTimeoutMs) {
  return [
    "Codex #6 status heartbeat",
    `- Task: ${redactedTaskPreview}`,
    `- Elapsed: ${formatElapsed(status.durationMs)}`,
    `- Hard cutoff: ${formatElapsed(timeoutMs)}`,
    `- Last exec output: ${status.lastOutputAt || "(none yet)"}`,
    "- State: codex exec is still running; final reply will be sent when it completes.",
  ].join("\n");
}

export function buildCodexTimeoutWarningMessage(
  status,
  timeoutMs = codexTimeoutMs,
  cancelMs = codexNearTimeoutCancelMs,
) {
  return [
    "Codex #6 timeout warning",
    `- Task: ${redactedTaskPreview}`,
    `- Elapsed: ${formatElapsed(status.durationMs)}`,
    `- Cancel signal: ${formatElapsed(cancelMs)}`,
    `- Hard cutoff: ${formatElapsed(timeoutMs)}`,
    `- Last exec output: ${status.lastOutputAt || "(none yet)"}`,
    "- State: codex exec is still running; SIGTERM will be sent at the cancel threshold if it does not finish.",
  ].join("\n");
}

async function sendCodexStatusUpdate(state, inbound, status) {
  await sendTransformMessage(state, inbound, buildCodexStatusUpdateMessage(status), true);
}

async function sendCodexTimeoutWarning(state, inbound, status) {
  await sendTransformMessage(state, inbound, buildCodexTimeoutWarningMessage(status), true);
}

async function sendReply(state, inbound, reply) {
  await sendTransformMessage(state, inbound, reply, false);
}

async function pollOnce(state) {
  const data = await apiGet("/api/chat/history", {
    deviceId: state.deviceId,
    entityId: state.entityId,
    botSecret: state.botSecret,
    limit: 100,
    since: startMs,
  });
  const messages = data.messages || [];
  const pending = [];
  for (const message of messages) {
    if (shouldSkipInboundMessage(message, state)) continue;
    pending.push(message);
  }

  for (const message of prioritizePollMessages(pending)) {
    if (seen.has(message.id)) continue;
    const text = String(message.text || "");
    const source = String(message.source || "");
    let reply = replyFor(text);
    if (reply === null) {
      try {
        reply = await runCodex(state, message);
      } catch (error) {
        reply = blockedReplyFor(text, error);
      }
    }
    if (!reply || !reply.trim()) continue;

    await sendReply(state, message, reply.trim());
    seen.add(message.id);
    log("replied", { inboundId: message.id, source, replyPreview: reply.trim().slice(0, 80) });
  }
}

async function pollDirectProbes(state) {
  if (directProbePollActive) return;
  const backoffMs = rateLimitRemainingMs("directProbe");
  if (backoffMs > 0) {
    log("direct probe poll deferred by rate limit backoff", { remainingMs: backoffMs });
    return;
  }
  directProbePollActive = true;
  try {
    const data = await apiGet("/api/chat/history", {
      deviceId: state.deviceId,
      entityId: state.entityId,
      botSecret: state.botSecret,
      limit: 30,
      since: startMs,
    });
    for (const message of data.messages || []) {
      if (shouldSkipInboundMessage(message, state)) continue;

      const text = String(message.text || "");
      if (!hasDirectProbeReply(text)) continue;

      const reply = replyFor(text);
      if (!reply || !reply.trim()) continue;

      await sendReply(state, message, reply.trim());
      seen.add(message.id);
      log("direct_probe_replied", {
        inboundId: message.id,
        source: String(message.source || ""),
        replyPreview: reply.trim().slice(0, 80),
      });
    }
    clearRateLimit("directProbe");
  } catch (error) {
    log("direct probe poll error", { error: error.message });
    if (isRateLimitError(error)) recordRateLimit("directProbe", error);
  } finally {
    directProbePollActive = false;
  }
}

async function main() {
  const state = await readState();
  await refreshEntitiesWithRetry(state, { phase: "startup" });
  log("codex polling bridge started", {
    deviceId: state.deviceId,
    entityId: state.entityId,
    publicCode: state.publicCode,
    useCodex,
    codexModel,
    codexReasoningEffort,
    codexSandbox,
    codexBypassApprovals,
    codexTimeoutMs,
    codexNearTimeoutWarningMs,
    codexNearTimeoutWarningEnabled,
    codexNearTimeoutCancelMs,
    codexNearTimeoutCancelEnabled,
    codexTerminateGraceMs,
    codexStatusUpdatesEnabled,
    codexStatusInitialMs,
    codexStatusMs,
    codexDiagnosticLog,
    pollMs,
    directProbePollMs,
  });

  setInterval(() => {
    pollDirectProbes(state).catch((error) => {
      log("direct probe poll fatal", { error: error.message });
    });
  }, directProbePollMs);
  await pollDirectProbes(state);

  for (;;) {
    try {
      const backoffMs = rateLimitRemainingMs("poll");
      if (backoffMs > 0) {
        log("poll deferred by rate limit backoff", { remainingMs: backoffMs });
        await sleep(Math.min(backoffMs, pollMs));
        continue;
      }
      await pollOnce(state);
      clearRateLimit("poll");
    } catch (error) {
      log("poll error", { error: error.message });
      if (isRateLimitError(error)) {
        recordRateLimit("poll", error);
      } else {
        try {
          await refreshEntities(state);
        } catch {
          // The next polling cycle will retry with the current routing cache.
        }
      }
    }
    await sleep(pollMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
