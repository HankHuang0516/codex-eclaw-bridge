#!/usr/bin/env bash
# scripts/restart-poller.sh — canonical clean relaunch of the codex (#6) polling bridge.
#
# Single source of truth for how the poller is supervised. Replaces the ad-hoc inline tmux
# command that had drifted: it tears down the old session, then starts a fresh tmux session
# with a HARDENED supervisor (cd-into-dir each iteration + exponential backoff so a stale
# cwd / EINTR loop can never tight-loop the machine) PLUS a wedge watchdog window.
#
# Emits exactly one JSON line on stdout: {ok, action, pollerPid, message}.
# NEVER prints secrets.
set -uo pipefail

DIR="${CODEX_ECLAW_BRIDGE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="${CODEX_POLL_BRIDGE_LOG:-/private/tmp/codex-eclaw-polling-bridge.log}"
TMUX_SOCK="${CODEX_POLL_TMUX_SOCK:-codex-eclaw-cua}"
TMUX_SESSION="${CODEX_POLL_TMUX_SESSION:-codex-eclaw-poller}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── teardown ─────────────────────────────────────────────────────────────────
tmux -L "$TMUX_SOCK" kill-session -t "$TMUX_SESSION" >/dev/null 2>&1 || true
pkill -9 -f "eclaw-polling-bridge.mjs" >/dev/null 2>&1 || true
pkill -9 -f "poller-watchdog.mjs" >/dev/null 2>&1 || true
sleep 1
echo "$(ts) [restart-poller] CLEAN RESTART — fresh tmux session, hardened supervisor + watchdog" >> "$LOG"

# ── supervisor command (poller loop) ─────────────────────────────────────────
# cd into $DIR every iteration; back off to 15s after 3 consecutive failures.
read -r -d '' SUP_CMD <<EOF || true
cd "$DIR"; set -a; [ -f .env ] && . ./.env; set +a; fails=0; \
while true; do \
  cd "$DIR" || { echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ) [supervisor] cd failed, retry 5s" >> "$LOG"; sleep 5; continue; }; \
  CODEX_ECLAW_BRIDGE_DIR="$DIR" \
  CODEX_POLL_BRIDGE_USE_CODEX="\${CODEX_POLL_BRIDGE_USE_CODEX:-1}" \
  CODEX_POLL_BRIDGE_BYPASS_APPROVALS="\${CODEX_POLL_BRIDGE_BYPASS_APPROVALS:-1}" \
  CODEX_MODEL="\${CODEX_MODEL:-gpt-5.5}" \
  CODEX_REASONING_EFFORT="\${CODEX_REASONING_EFFORT:-xhigh}" \
  CODEX_POLL_BRIDGE_SANDBOX="\${CODEX_POLL_BRIDGE_SANDBOX:-workspace-write}" \
  CODEX_POLL_BRIDGE_TIMEOUT_MS="\${CODEX_POLL_BRIDGE_TIMEOUT_MS:-1200000}" \
  CODEX_POLL_BRIDGE_TERMINATE_GRACE_MS="\${CODEX_POLL_BRIDGE_TERMINATE_GRACE_MS:-10000}" \
  CODEX_POLL_BRIDGE_DIAGNOSTIC_LOG="\${CODEX_POLL_BRIDGE_DIAGNOSTIC_LOG:-$DIR/.data/codex-exec-diagnostics.jsonl}" \
  node scripts/eclaw-polling-bridge.mjs >> "$LOG" 2>&1; \
  rc=\$?; \
  if [ \$rc -ne 0 ]; then fails=\$((fails+1)); else fails=0; fi; \
  back=2; [ \$fails -ge 3 ] && back=15; \
  echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ) [supervisor] poller exited rc=\$rc (fails=\$fails), relaunching in \${back}s" >> "$LOG"; \
  sleep \$back; \
done
EOF

# ── watchdog command (separate window) ───────────────────────────────────────
read -r -d '' WD_CMD <<EOF || true
cd "$DIR"; set -a; [ -f .env ] && . ./.env; set +a; \
while true; do \
  CODEX_ECLAW_BRIDGE_DIR="$DIR" CODEX_POLL_BRIDGE_LOG="$LOG" node scripts/poller-watchdog.mjs >> "$LOG" 2>&1; \
  echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ) [watchdog-supervisor] watchdog exited, relaunching in 5s" >> "$LOG"; \
  sleep 5; \
done
EOF

# ── launch ───────────────────────────────────────────────────────────────────
tmux -L "$TMUX_SOCK" new-session -d -s "$TMUX_SESSION" -c "$DIR" "$SUP_CMD"
LAUNCH_RC=$?
tmux -L "$TMUX_SOCK" new-window -t "$TMUX_SESSION" -c "$DIR" "$WD_CMD" >/dev/null 2>&1 || true

sleep 4
POLLER_PID="$(pgrep -f 'node scripts/eclaw-polling-bridge.mjs' | head -1)"

if [ "$LAUNCH_RC" -eq 0 ] && [ -n "$POLLER_PID" ]; then
  echo "{\"ok\":true,\"action\":\"restart-poller\",\"pollerPid\":$POLLER_PID,\"message\":\"poller + watchdog relaunched in fresh tmux session\"}"
  exit 0
else
  echo "{\"ok\":false,\"action\":\"restart-poller\",\"pollerPid\":null,\"message\":\"poller did not come up within 4s (launchRc=$LAUNCH_RC)\"}"
  exit 1
fi
