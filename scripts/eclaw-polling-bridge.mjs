#!/usr/bin/env node
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const apiBase = process.env.ECLAW_API_BASE || "https://eclawbot.com";
const root = path.resolve(process.env.CODEX_ECLAW_BRIDGE_DIR || process.cwd());
const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const statePath = path.resolve(process.env.BRIDGE_STATE_PATH || path.join(root, ".data/state.json"));
const workspace = process.env.CODEX_WORKSPACE || "/Users/hank/Desktop/Project";
const pollMs = Number(process.env.ECLAW_POLL_MS || 4000);
const useCodex = process.env.CODEX_POLL_BRIDGE_USE_CODEX === "1";
const codexBin = process.env.CODEX_BIN || "codex";
const codexModel = process.env.CODEX_MODEL || "gpt-5.5";
const codexReasoningEffort = process.env.CODEX_REASONING_EFFORT || "xhigh";
const codexReportModel = process.env.CODEX_REPORT_MODEL || "GPT-5.5";
const codexReportReasoning = process.env.CODEX_REPORT_REASONING || "extrahigh";
const codexSandbox = process.env.CODEX_POLL_BRIDGE_SANDBOX || "workspace-write";
const codexBypassApprovals = process.env.CODEX_POLL_BRIDGE_BYPASS_APPROVALS === "1";
const codexTimeoutMs = positiveNumber(process.env.CODEX_POLL_BRIDGE_TIMEOUT_MS, 600000);
const codexTerminateGraceMs = positiveNumber(process.env.CODEX_POLL_BRIDGE_TERMINATE_GRACE_MS, 10000);
const codexDiagnosticLog = path.resolve(
  process.env.CODEX_POLL_BRIDGE_DIAGNOSTIC_LOG || path.join(root, ".data/codex-exec-diagnostics.jsonl"),
);

const seen = new Set();
const startMs = Date.now() - 5000;
let entityCodeById = new Map();

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
    throw new Error(data.message || data.error || `${pathname} failed with HTTP ${res.status}`);
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
    throw new Error(data.message || data.error || `${pathname} failed with HTTP ${res.status}`);
  }
  return data;
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

async function runCodex(text, source, inboundId) {
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

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "eclaw-codex-reply-"));
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
    let sigkillTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      writeCodexDiagnostic({
        event: "timeout_before_sigterm",
        ...diagnosticContext,
        durationMs: Date.now() - startedAt,
        stdoutTail: tailDiagnosticText(stdout),
        stderrTail: tailDiagnosticText(stderr),
        outputTail: readOutputTail(outputPath),
      });
      const killed = child.kill("SIGTERM");
      writeCodexDiagnostic({
        event: "timeout_sigterm_sent",
        ...diagnosticContext,
        durationMs: Date.now() - startedAt,
        killed,
      });
      sigkillTimer = setTimeout(() => {
        const killedBySigkill = child.kill("SIGKILL");
        writeCodexDiagnostic({
          event: "timeout_sigkill_sent",
          ...diagnosticContext,
          durationMs: Date.now() - startedAt,
          killed: killedBySigkill,
        });
      }, codexTerminateGraceMs);
    }, codexTimeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
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
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
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

async function sendReply(state, inbound, reply) {
  const fromId = senderEntityId(inbound.source);
  const speakTo = fromId != null ? entityCodeById.get(fromId) : null;
  const body = {
    deviceId: state.deviceId,
    entityId: state.entityId,
    botSecret: state.botSecret,
    state: "IDLE",
    message: reply,
    ...(speakTo ? { speakTo: [speakTo] } : {}),
  };
  await apiPost("/api/transform", body);
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
  for (const message of messages) {
    if (!message.id || seen.has(message.id)) continue;

    const text = String(message.text || "");
    const source = String(message.source || "");
    if (!text.trim()) {
      seen.add(message.id);
      continue;
    }
    if (isOwnBotMessage(message, state)) {
      seen.add(message.id);
      continue;
    }
    if (/^ACK\b/.test(text.trim())) {
      seen.add(message.id);
      continue;
    }
    if (Number(message.entity_id) === state.entityId && /^ACK\b/.test(text.trim())) {
      seen.add(message.id);
      continue;
    }

    let reply = replyFor(text);
    if (reply === null) {
      try {
        reply = await runCodex(text, source, message.id);
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

async function main() {
  const state = await readState();
  await refreshEntities(state);
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
    codexDiagnosticLog,
    pollMs,
  });

  for (;;) {
    try {
      await pollOnce(state);
    } catch (error) {
      log("poll error", { error: error.message });
      try { await refreshEntities(state); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
