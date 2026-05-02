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
| `BRIDGE_STATE_PATH` |  | `.data/state.json` | Runtime state path |
| `BRIDGE_REPLY_TIMEOUT_MS` |  | `600000` | Turn reply timeout |
| `BRIDGE_APPROVAL_TIMEOUT_MS` |  | `900000` | Approval card timeout |
| `BRIDGE_SEND_BUSY_UPDATES` |  | `false` | Send a persistent "working" message before turns |
| `BRIDGE_STATUS_HEARTBEAT_ENABLED` |  | `true` | Send periodic long-task status updates while a Codex turn is active |
| `BRIDGE_STATUS_HEARTBEAT_MS` |  | `180000` | Status heartbeat interval |
| `BRIDGE_WATCHDOG_ENABLED` |  | `true` | Restart/retry recoverable Codex bridge failures automatically |
| `BRIDGE_WATCHDOG_STALL_MS` |  | `480000` | Turn idle threshold before watchdog recovery |
| `BRIDGE_REQUIRE_CALLBACK_AUTH` |  | `false` | Require configured callback auth |

Never commit `.env`. `.gitignore` excludes `.env*` except `.env.example`.

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

The watchdog is separate from the heartbeat. It restarts the Codex app-server if
the websocket disconnects, resets the thread and retries once for recoverable
Codex request failures, and interrupts/retries turns that stop producing events
longer than `BRIDGE_WATCHDOG_STALL_MS` while no approval card is pending.

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

If Codex rejects an EClaw-inlined local-vault marker with
`invalid_request_error`, the bridge removes that reserved marker from subsequent
turn input, resets the thread/app-server state, and retries once. The human sees
a `Codex watchdog self-repair` status instead of a misleading "final reply"
progress update.

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
