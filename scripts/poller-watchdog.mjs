#!/usr/bin/env node
// scripts/poller-watchdog.mjs — wedge detector for the codex (#6) polling bridge.
//
// Why this exists (2026-06-17 incident): the tmux supervisor (`while true; do node ...; done`)
// only relaunches the poller when the poller PROCESS EXITS. A *wedged* poller — hung in a
// syscall, stuck socket, or a Node bootstrap EINTR loop — may stop doing useful work without
// exiting, so the supervisor never relaunches it and the user gets silence while health looks
// "green". This watchdog reads the heartbeat file the poller writes every loop iteration; if it
// goes stale past the allowed window, it kills the wedged poller so the supervisor relaunches a
// fresh one. Together with the in-process "sustained-error -> exit(2)" path in the poller, this
// makes health honest and self-repair automatic.
//
// Phase-aware staleness: a legitimate codex exec can run for many minutes (codexTimeoutMs), so
// while phase === "codex_exec" we allow codexTimeoutMs + grace before acting; otherwise a tight
// staleMs window (a non-codex poll cycle should never take that long).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(process.env.CODEX_ECLAW_BRIDGE_DIR || process.cwd());
const heartbeatPath = path.resolve(
  process.env.CODEX_POLL_BRIDGE_HEARTBEAT || path.join(root, ".data/poll-heartbeat.json"),
);
const pollMs = Number(process.env.ECLAW_POLL_MS || 30000);
const staleMs = Math.max(Number(process.env.CODEX_POLL_BRIDGE_WEDGE_STALE_MS) || pollMs * 3, 90000);
const graceMs = Number(process.env.CODEX_POLL_BRIDGE_WEDGE_GRACE_MS) || 120000;
const checkMs = Number(process.env.CODEX_POLL_BRIDGE_WATCHDOG_CHECK_MS) || 30000;
const logPath = process.env.CODEX_POLL_BRIDGE_LOG || "/private/tmp/codex-eclaw-polling-bridge.log";

function logLine(obj) {
  const line = `${new Date().toISOString()} [watchdog] ${JSON.stringify(obj)}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    /* ignore */
  }
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
  } catch {
    return null;
  }
}

let killCount = 0;
let missingSince = 0;

function check() {
  const hb = readHeartbeat();
  const now = Date.now();

  if (!hb || !hb.ts) {
    // No heartbeat file yet. The poller may be starting; only act if it never appears
    // for well beyond a startup window (then something is wrong with the poller launch).
    if (!missingSince) missingSince = now;
    if (now - missingSince > staleMs * 2) {
      logLine({ event: "no_heartbeat_persisted", missingForMs: now - missingSince });
      killWedged(null, "no_heartbeat");
      missingSince = now; // re-arm
    }
    return;
  }
  missingSince = 0;

  const age = now - Date.parse(hb.ts);
  const inCodex = hb.phase === "codex_exec";
  const codexTimeoutMs = Number(hb.codexTimeoutMs) || 1200000;
  const limit = inCodex ? codexTimeoutMs + graceMs : staleMs;

  if (age <= limit) return; // healthy (or legitimately busy running codex)

  logLine({
    event: "wedge_detected",
    ageMs: age,
    limitMs: limit,
    phase: hb.phase,
    pid: hb.pid,
    lastPollOk: hb.lastPollOk,
    note: hb.note || "",
  });
  killWedged(hb.pid, `stale_${hb.phase}`);
}

function killWedged(pid, reason) {
  try {
    if (pid && Number.isInteger(pid)) {
      process.kill(pid, "SIGKILL");
      killCount += 1;
      logLine({ event: "killed_wedged_poller", pid, reason, killCount, action: "supervisor_relaunches" });
    } else {
      execSync("pkill -9 -f eclaw-polling-bridge.mjs");
      killCount += 1;
      logLine({ event: "pkilled_wedged_poller", reason, killCount, action: "supervisor_relaunches" });
    }
  } catch (e) {
    logLine({ event: "kill_failed", pid, reason, error: String((e && e.message) || e) });
  }
}

logLine({ event: "watchdog_started", heartbeatPath, staleMs, graceMs, checkMs });
setInterval(check, checkMs);
// Keep the event loop alive even if setInterval is the only handle.
process.stdin.resume?.();
