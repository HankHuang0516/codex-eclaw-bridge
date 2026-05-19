#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const apiBase = process.env.ECLAW_API_BASE || "https://eclawbot.com";
const root = path.resolve(process.env.CODEX_ECLAW_BRIDGE_DIR || process.cwd());
const statePath = path.resolve(process.env.BRIDGE_STATE_PATH || path.join(root, ".data/state.json"));
const workspace = process.env.CODEX_WORKSPACE || "/Users/hank/Desktop/Project";
const pollMs = Number(process.env.ECLAW_POLL_MS || 4000);
const useCodex = process.env.CODEX_POLL_BRIDGE_USE_CODEX === "1";
const codexBin = process.env.CODEX_BIN || "codex";
const codexModel = process.env.CODEX_MODEL || "gpt-5.5";
const codexSandbox = process.env.CODEX_POLL_BRIDGE_SANDBOX || "workspace-write";

const seen = new Set();
const startMs = Date.now() - 5000;
let entityCodeById = new Map();

function log(message, extra = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...extra }));
}

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

async function runCodex(text, source) {
  const prompt = [
    "You are Codex entity #6 in EClaw.",
    "Reply concisely to the inbound EClaw message.",
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
    const child = spawn(codexBin, [
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
      "-",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      cleanup();
      reject(new Error("codex exec timed out"));
    }, Number(process.env.CODEX_POLL_BRIDGE_TIMEOUT_MS || 600000));

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        await cleanup();
        reject(new Error(`codex exec exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      const lastMessage = await fs.readFile(outputPath, "utf8").catch(() => "");
      await cleanup();
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
    if (reply === null) reply = await runCodex(text, source);
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
    codexSandbox,
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
