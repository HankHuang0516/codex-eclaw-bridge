#!/usr/bin/env bash
# selfheal/self-repair.sh — repo-bound, version-aware self-repair program
# Channel: #6 codex-eclaw-bridge (POLLING bridge; no callback URL).
#
# Mirrors the shared EClaw channel self-repair contract (reference impl lives in
# HankHuang0516/claude-code-eclaw-channel selfheal/). Differences for #6:
#   - repair  = restart the tmux poller + wedge watchdog (scripts/restart-poller.sh)
#   - health  = heartbeat freshness (.data/poll-heartbeat.json), NOT an HTTP server
#   - bind    = a successful authenticated /api/chat/history poll (no /api/channel/bind)
#
# Contract order:
#   1. Detect whether THIS program is latest (manifest.json::selfRepairVersion vs GitHub raw).
#   2. If behind, auto-install latest selfheal/ (skip if dirty) and re-exec once.
#   3. Repair (restart-poller.sh).
#   4. Health-verify (heartbeat fresh within maxAgeSec).
#   5. Poll sync-verify (authenticated /api/chat/history returns 200).
#
# Emits exactly one JSON line on stdout. NEVER prints any secret.
set -uo pipefail

SELFHEAL_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$SELFHEAL_DIR/.." && pwd)"
MANIFEST="$SELFHEAL_DIR/manifest.json"

mf() { python3 -c "import json;print(json.load(open('$MANIFEST')).get('$1',''))" 2>/dev/null; }
mfn() { python3 -c "import json;print(json.load(open('$MANIFEST')).get('healthCheck',{}).get('$1',''))" 2>/dev/null; }

CHANNEL_TYPE="$(mf channelType)"
REPO="$(mf repo)"
BRANCH="$(mf branch)"
ENTITY_ID="$(mf entityId)"
LOCAL_VERSION="$(mf selfRepairVersion)"
HEARTBEAT_REL="$(mfn path)"; [ -z "$HEARTBEAT_REL" ] && HEARTBEAT_REL=".data/poll-heartbeat.json"
MAX_AGE_SEC="$(mfn maxAgeSec)"; [ -z "$MAX_AGE_SEC" ] && MAX_AGE_SEC=120
HEARTBEAT="$BRIDGE_DIR/$HEARTBEAT_REL"
RAW_MANIFEST_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/selfheal/manifest.json"
API_BASE="${ECLAW_API_BASE:-https://eclawbot.com}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] selfheal($CHANNEL_TYPE): $*" >> /tmp/eclaw-selfheal.log; }

emit() { # emit <ok> <stage> <updated> <healthOk> <bindOk> <msg>
  python3 - "$@" "$CHANNEL_TYPE" "$ENTITY_ID" "$LOCAL_VERSION" "$LATEST_VERSION" <<'PY'
import json,sys
ok,stage,updated,healthOk,bindOk,msg,ct,eid,lv,latv=sys.argv[1:11]
print(json.dumps({
  "ok": ok=="true","channelType":ct,"entityId":int(eid),
  "stage":stage,"localVersion":lv,"latestVersion":latv,
  "updated":updated=="true","healthOk":healthOk=="true","bindOk":bindOk=="true",
  "message":msg
}))
PY
}

# Load env (ECLAW_API_KEY / state etc.) without echoing secrets.
if [ -f "$BRIDGE_DIR/.env" ]; then set -a; . "$BRIDGE_DIR/.env"; set +a; fi

# ── Stage 1+2: version self-detection + auto-install latest ──────────────────
LATEST_VERSION="$LOCAL_VERSION"
UPDATED="false"
if [ "${SELFHEAL_UPDATED:-0}" != "1" ] && command -v git >/dev/null 2>&1; then
  REMOTE_MANIFEST="$(curl -sf --max-time 8 "$RAW_MANIFEST_URL" 2>/dev/null || true)"
  if [ -n "$REMOTE_MANIFEST" ]; then
    LATEST_VERSION="$(printf '%s' "$REMOTE_MANIFEST" | python3 -c "import json,sys;print(json.load(sys.stdin).get('selfRepairVersion',''))" 2>/dev/null || echo "$LOCAL_VERSION")"
    if [ "$LATEST_VERSION" != "$LOCAL_VERSION" ] && \
       [ "$(printf '%s\n%s\n' "$LOCAL_VERSION" "$LATEST_VERSION" | sort -V | tail -1)" = "$LATEST_VERSION" ]; then
      log "behind: local=$LOCAL_VERSION latest=$LATEST_VERSION"
      cd "$BRIDGE_DIR"
      if [ -z "$(git status --porcelain -- selfheal/ 2>/dev/null)" ]; then
        if git fetch --quiet origin "$BRANCH" 2>/dev/null && \
           git checkout --quiet "origin/$BRANCH" -- selfheal/ 2>/dev/null; then
          UPDATED="true"
          log "auto-installed latest selfheal/ ($LOCAL_VERSION -> $LATEST_VERSION); re-exec"
          SELFHEAL_UPDATED=1 exec bash "$SELFHEAL_DIR/self-repair.sh" "$@"
        else
          log "auto-install failed (git fetch/checkout); proceed with local $LOCAL_VERSION"
        fi
      else
        log "selfheal/ dirty; skip auto-install, proceed with local $LOCAL_VERSION"
      fi
    fi
  else
    log "remote manifest unreachable; proceed with local $LOCAL_VERSION"
  fi
fi

# ── Stage 3: repair (restart poller + watchdog) ──────────────────────────────
REPAIR_OUT="$(bash "$BRIDGE_DIR/scripts/restart-poller.sh" 2>>/tmp/eclaw-selfheal.log | tail -1)"
REPAIR_OK="$(printf '%s' "$REPAIR_OUT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('ok',False))" 2>/dev/null || echo "False")"
log "repair result: $REPAIR_OUT"
if [ "$REPAIR_OK" != "True" ]; then
  emit "false" "repair_failed" "$UPDATED" "false" "false" "restart-poller.sh did not report ok"
  exit 1
fi

# ── Stage 4: health verify (heartbeat fresh) ─────────────────────────────────
# Give the freshly-launched poller up to ~35s to emit a heartbeat past startup/EINTR window.
HEALTH_OK="false"
for _ in $(seq 1 7); do
  sleep 5
  [ -f "$HEARTBEAT" ] || continue
  AGE="$(python3 -c "
import json,time
try:
  d=json.load(open('$HEARTBEAT')); import datetime
  ts=d.get('ts','')
  t=datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
  print(int(time.time()-t))
except Exception: print(99999)
" 2>/dev/null || echo 99999)"
  if [ "$AGE" -ge 0 ] 2>/dev/null && [ "$AGE" -le "$MAX_AGE_SEC" ]; then HEALTH_OK="true"; break; fi
done
log "health verify: heartbeat_ok=$HEALTH_OK (maxAge=${MAX_AGE_SEC}s)"

# ── Stage 5: poll sync-verify (authenticated /api/chat/history 200) ──────────
BIND_OK="false"
DEVICE_ID="$(python3 -c "import json;print(json.load(open('$BRIDGE_DIR/.data/state.json')).get('deviceId',''))" 2>/dev/null || echo "")"
BOT_SECRET="$(python3 -c "import json;print(json.load(open('$BRIDGE_DIR/.data/state.json')).get('botSecret',''))" 2>/dev/null || echo "")"
if [ -n "$DEVICE_ID" ] && [ -n "$BOT_SECRET" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'User-Agent: Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120' \
    "$API_BASE/api/chat/history?deviceId=$DEVICE_ID&botSecret=$BOT_SECRET&entityId=$ENTITY_ID&limit=1" 2>/dev/null || echo "000")"
  [ "$CODE" = "200" ] && BIND_OK="true"
  log "poll sync-verify: http=$CODE"
else
  log "state.json missing deviceId/botSecret; cannot poll sync-verify"
fi

OK="false"; [ "$HEALTH_OK" = "true" ] && [ "$BIND_OK" = "true" ] && OK="true"
emit "$OK" "complete" "$UPDATED" "$HEALTH_OK" "$BIND_OK" "self-repair done (restart+heartbeat+poll verify)"
[ "$OK" = "true" ] && exit 0 || exit 1
