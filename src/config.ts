import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import type { BridgeConfig } from "./types.js";

const envSchema = z.object({
  ECLAW_API_BASE: z.string().url().default("https://eclawbot.com"),
  ECLAW_API_KEY: z.string().min(1),
  ECLAW_API_SECRET: z.string().optional(),
  ECLAW_WEBHOOK_URL: z.string().url(),
  ECLAW_WEBHOOK_PORT: z.coerce.number().int().positive().default(18800),
  ECLAW_BOT_NAME: z.string().min(1).max(20).default("Codex"),
  ECLAW_ENTITY_ID: z.coerce.number().int().nonnegative().optional(),
  ECLAW_CALLBACK_TOKEN: z.string().optional(),
  ECLAW_CALLBACK_USERNAME: z.string().optional(),
  ECLAW_CALLBACK_PASSWORD: z.string().optional(),
  CODEX_BIN: z.string().min(1).default("codex"),
  CODEX_WORKSPACE: z.string().min(1),
  CODEX_MODEL: z.string().optional(),
  CODEX_SANDBOX: z.string().default("workspace-write"),
  CODEX_APPROVAL_POLICY: z.string().default("on-request"),
  CODEX_APP_SERVER_LISTEN: z.string().default("ws://127.0.0.1:0"),
  CODEX_REASONING_EFFORT: z.string().optional(),
  BRIDGE_STATE_PATH: z.string().default(".data/state.json"),
  BRIDGE_REPLY_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  BRIDGE_APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  BRIDGE_SEND_BUSY_UPDATES: z.coerce.boolean().default(false),
  BRIDGE_REQUIRE_CALLBACK_AUTH: z.coerce.boolean().default(false),
  BRIDGE_STATUS_HEARTBEAT_ENABLED: z.coerce.boolean().default(true),
  BRIDGE_STATUS_HEARTBEAT_MS: z.coerce.number().int().positive().default(180_000),
});

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = envSchema.parse(env);
  const statePath = path.isAbsolute(parsed.BRIDGE_STATE_PATH)
    ? parsed.BRIDGE_STATE_PATH
    : path.resolve(process.cwd(), parsed.BRIDGE_STATE_PATH);

  return {
    eclawApiBase: parsed.ECLAW_API_BASE.replace(/\/$/, ""),
    eclawApiKey: parsed.ECLAW_API_KEY,
    eclawApiSecret: emptyToUndefined(parsed.ECLAW_API_SECRET),
    eclawWebhookUrl: parsed.ECLAW_WEBHOOK_URL.replace(/\/$/, ""),
    eclawWebhookPort: parsed.ECLAW_WEBHOOK_PORT,
    eclawBotName: parsed.ECLAW_BOT_NAME,
    eclawEntityId: parsed.ECLAW_ENTITY_ID,
    eclawCallbackToken: emptyToUndefined(parsed.ECLAW_CALLBACK_TOKEN),
    eclawCallbackUsername: emptyToUndefined(parsed.ECLAW_CALLBACK_USERNAME),
    eclawCallbackPassword: emptyToUndefined(parsed.ECLAW_CALLBACK_PASSWORD),
    codexBin: parsed.CODEX_BIN,
    codexWorkspace: path.resolve(parsed.CODEX_WORKSPACE),
    codexModel: emptyToUndefined(parsed.CODEX_MODEL),
    codexSandbox: parsed.CODEX_SANDBOX,
    codexApprovalPolicy: parsed.CODEX_APPROVAL_POLICY,
    codexAppServerListen: parsed.CODEX_APP_SERVER_LISTEN,
    codexReasoningEffort: emptyToUndefined(parsed.CODEX_REASONING_EFFORT),
    bridgeStatePath: statePath,
    bridgeReplyTimeoutMs: parsed.BRIDGE_REPLY_TIMEOUT_MS,
    bridgeApprovalTimeoutMs: parsed.BRIDGE_APPROVAL_TIMEOUT_MS,
    bridgeSendBusyUpdates: parsed.BRIDGE_SEND_BUSY_UPDATES,
    bridgeRequireCallbackAuth: parsed.BRIDGE_REQUIRE_CALLBACK_AUTH,
    bridgeStatusHeartbeatEnabled: parsed.BRIDGE_STATUS_HEARTBEAT_ENABLED,
    bridgeStatusHeartbeatMs: parsed.BRIDGE_STATUS_HEARTBEAT_MS,
  };
}
