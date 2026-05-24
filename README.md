# Codex EClaw Bridge

Persistent [Codex CLI](https://developers.openai.com/codex/) bridge for
[EClawbot](https://eclawbot.com) Channel API.

This repo lets an EClawbot entity receive messages from the EClaw app or portal,
forward them into a long-lived Codex `app-server` thread, then send Codex's final
answer back through `POST /api/channel/message`.

> Status: experimental. This bridge intentionally targets `codex app-server`,
> which Codex CLI currently marks as experimental.

## Architecture

```text
EClaw App / Portal
  -> EClaw Channel callback
  -> codex-eclaw-bridge /eclaw-webhook
  -> codex app-server JSON-RPC thread/turn
  -> final Codex reply
  -> POST /api/channel/message
  -> EClaw App / Portal
```

The bridge uses EClaw's existing Channel API. No EClaw backend changes are
required.

## Requirements

- Node.js 20+
- Codex CLI installed and logged in
- A project workspace that Codex can access
- EClawbot Channel API key (`eck_...`)
- A public HTTPS URL for local development or deployment

## Quick Start

```bash
git clone https://github.com/YOUR_ORG/codex-eclaw-bridge.git
cd codex-eclaw-bridge
npm install
cp .env.example .env
```

Edit `.env`:

```bash
ECLAW_API_KEY=eck_your_channel_api_key
ECLAW_WEBHOOK_URL=https://your-public-url.example.com
CODEX_WORKSPACE=/absolute/path/to/your/project
```

Run:

```bash
npm run generate:codex-types
npm run build
npm start
```

On startup the bridge:

1. Starts `codex app-server`.
2. Registers `${ECLAW_WEBHOOK_URL}/eclaw-webhook` with EClawbot.
3. Binds an EClaw entity through `/api/channel/bind`.
4. Stores non-secret runtime state in `.data/state.json`.

Send a message to the bound EClawbot entity. Codex should answer in the same
chat.

## Local Tunnel

For local development:

```bash
npm run dev
```

Then expose the local server:

```bash
cloudflared tunnel --url http://localhost:18800
# or
ngrok http 18800
```

See [scripts/dev-tunnel.md](scripts/dev-tunnel.md).

## Environment Variables

| Variable | Required | Default | Description |
|---|---:|---|---|
| `ECLAW_API_BASE` |  | `https://eclawbot.com` | EClawbot API base URL |
| `ECLAW_API_KEY` | yes |  | Channel API key (`eck_...`) |
| `ECLAW_API_SECRET` |  |  | Optional Channel API secret (`ecs_...`) |
| `ECLAW_WEBHOOK_URL` | yes |  | Public base URL for this bridge |
| `ECLAW_WEBHOOK_PORT` |  | `18800` | Local HTTP port |
| `ECLAW_BOT_NAME` |  | `Codex` | Entity display name |
| `ECLAW_ENTITY_ID` |  |  | Optional target entity slot |
| `ECLAW_CALLBACK_TOKEN` |  |  | Optional bearer callback token |
| `ECLAW_CALLBACK_USERNAME` |  |  | Optional basic auth username |
| `ECLAW_CALLBACK_PASSWORD` |  |  | Optional basic auth password |
| `CODEX_BIN` |  | `codex` | Codex CLI executable |
| `CODEX_WORKSPACE` | yes |  | Workspace directory for Codex |
| `CODEX_MODEL` |  | Codex default | Model override |
| `CODEX_SANDBOX` |  | `workspace-write` | Codex sandbox |
| `CODEX_APPROVAL_POLICY` |  | `on-request` | Codex approval policy |
| `CODEX_APP_SERVER_LISTEN` |  | `ws://127.0.0.1:0` | App-server listen URL |
| `CODEX_POLL_BRIDGE_BYPASS_APPROVALS` |  | `false` | Polling bridge only: pass `--dangerously-bypass-approvals-and-sandbox` to non-interactive `codex exec`, needed for unattended Computer Use app access |
| `CODEX_POLL_BRIDGE_TIMEOUT_MS` |  | `600000` | Polling bridge only: maximum `codex exec` turn duration before replying with a blocked/error message |
| `CODEX_POLL_BRIDGE_TERMINATE_GRACE_MS` |  | `10000` | Polling bridge only: grace period after timeout SIGTERM before SIGKILL |
| `CODEX_POLL_BRIDGE_DIAGNOSTIC_LOG` |  | `.data/codex-exec-diagnostics.jsonl` | Polling bridge only: JSONL diagnostics for `codex exec` start, timeout, close, signal, stdout/stderr tails, and output tail |
| `BRIDGE_STATE_PATH` |  | `.data/state.json` | Runtime state path |
| `BRIDGE_REPLY_TIMEOUT_MS` |  | `600000` | Turn reply timeout |
| `BRIDGE_APPROVAL_TIMEOUT_MS` |  | `900000` | Approval card timeout |
| `BRIDGE_SEND_BUSY_UPDATES` |  | `false` | Send a persistent "working" message before turns |
| `BRIDGE_STATUS_HEARTBEAT_ENABLED` |  | `true` | Send periodic long-task status updates while a Codex turn is active |
| `BRIDGE_STATUS_HEARTBEAT_MS` |  | `180000` | Status heartbeat interval |
| `BRIDGE_REQUIRE_CALLBACK_AUTH` |  | `false` | Require configured callback auth |

Never commit `.env`. `.gitignore` excludes `.env*` except `.env.example`.

For the #6 polling bridge, keep `CODEX_POLL_BRIDGE_TIMEOUT_MS=600000` when
running `gpt-5.5` with `CODEX_REASONING_EFFORT=xhigh`; 240s is too short for
large-workspace cold starts and roadmap tasks. Timeout diagnostics are appended
to `.data/codex-exec-diagnostics.jsonl` with redacted stdout/stderr/output
tails, exit code/signal, and the SIGTERM/SIGKILL sequence used to stop a stuck
`codex exec`.

## Bridge Commands

Send these directly in the EClaw chat:

| Command | Behavior |
|---|---|
| `!codex status` | Show bridge, Codex, thread, and approval status |
| `!codex reset` | Archive current Codex thread and start fresh on the next message |
| `!codex interrupt` | Interrupt the active Codex turn |
| `!codex model <name>` | Use a different model for subsequent turns |
| `/model` or `/模型` | Show an EClaw rich card model picker |

The bridge also accepts `/status`, `/reset`, `/interrupt`, and `/model` on
direct webhook calls. `/model` is safe in EClaw chat because the bridge responds
with a model picker card; for other commands, prefer `!codex ...` to avoid
conflicts with EClaw built-in platform actions.

## Long-Running Task Visibility

The bridge has two layers of progress visibility:

1. Codex task protocol instructions tell Codex to start long work with a short
   test plan and report meaningful milestones instead of only sending a final
   answer.
2. The bridge sends an external status heartbeat while a Codex turn is active.
   This heartbeat does not rely on Codex choosing to speak; it reports the
   active task summary, elapsed time, last observed Codex event, connection
   state, and whether any approval cards are pending.

Default heartbeat interval is 3 minutes. Tune it with
`BRIDGE_STATUS_HEARTBEAT_MS`, or disable it with
`BRIDGE_STATUS_HEARTBEAT_ENABLED=false`.

## Central Prompt Policy

When the bound EClaw backend supports `/api/channel/prompt-policy`, the bridge
fetches the composed Codex policy before starting or resuming a thread. The
central policy is appended after the bridge's local safety and task-protocol
fallback instructions, so the bridge still works if the endpoint is unavailable.

Manage device-level policy in EClaw Portal Settings > Developer > Agent Policy.
Entity-level policy can be stored in `identity.promptPolicy` through the EClaw
prompt-policy API and is merged with device policy and channel overrides at
runtime.

## Approval Flow

When Codex asks for command, file, permission, MCP elicitation, or user-input
approval, the bridge sends an EClaw rich card with action buttons. The card
action callback resolves the original Codex JSON-RPC server request.

The bridge does not auto-approve by default.

## Testing

```bash
npm run typecheck
npm run lint
npm test
npm run smoke:local
```

With the bridge running, you can test the Codex side locally without sending an
EClaw message:

```bash
curl -s -X POST http://localhost:18800/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"Reply exactly: ECLAW_CODEX_BRIDGE_OK"}'
```

If this returns `Codex error: You've hit your usage limit...`, the bridge is
healthy but the logged-in Codex CLI account cannot start a model turn yet. Check
`GET /status` for `session.lastTurnError`, switch to an available model with
`!codex model <name>`, or retry after the time reported by Codex.

Optional live smoke:

```bash
npm run smoke:live
```

`smoke:live` requires real `.env` credentials and sends a real EClaw message. It
validates Channel API registration, binding, and outbound message delivery. For
full EClaw -> Codex -> EClaw verification, send a real chat message to the bound
entity and confirm the final reply appears in EClaw.

### Network Access

`workspace-write` is the safer default for local code work, but some Codex
installations block outbound DNS/network from that sandbox. If you want the
Codex bot to use EClaw API hints itself, for example `curl
https://eclawbot.com/api/mission/...`, use a network-enabled sandbox/profile.
For local trusted testing:

```bash
CODEX_SANDBOX=danger-full-access
CODEX_APPROVAL_POLICY=on-request
```

Keep `on-request` so command/file approvals still become EClaw rich cards.

### Polling Bridge Computer Use

The fallback polling bridge runs `codex exec` non-interactively. Computer Use
app access is requested through MCP elicitation; without
`CODEX_POLL_BRIDGE_BYPASS_APPROVALS=1`, those app-access requests are denied and
the bot must report that Computer Use is blocked. For browser automation, use a
real browser app such as Google Chrome or Safari. Computer Use intentionally
blocks the Codex desktop app / in-app browser (`com.openai.codex`).

For #6 on Hank's local fleet, run the polling bridge from the dedicated
`codex-eclaw-cua` tmux socket rather than the legacy default tmux server. The
old server can inherit a macOS Automation/TCC context that makes Chrome access
fail with Apple event `-1743`; the dedicated socket preserves the desktop
Computer Use context used by the working #6 browser-chat validation.

## Security Notes

- Treat the bridge as a tool-capable agent endpoint. Protect the public webhook
  with `ECLAW_CALLBACK_TOKEN` or basic auth when possible.
- Do not expose `codex app-server` directly to the internet.
- Keep Codex sandbox and approval policy conservative for public or shared
  workspaces.
- Never put API keys, device secrets, or auth tokens in source control.

## Development

Generate Codex protocol types after installing Codex CLI:

```bash
npm run generate:codex-types
```

The generated `src/codex-protocol/` folder is ignored because it is derived from
the installed Codex CLI version.
