import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import type { BridgeConfig } from "./types.js";

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());
}

const envSchema = z.object({
  ECLAW_API_BASE: z.string().url().default("https://eclawbot.com"),
  ECLAW_API_KEY: z.string().min(1),
  ECLAW_API_SECRET: z.string().optional(),
  ECLAW_WEBHOOK_URL: z.string().url().optional(),
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
  BRIDGE_SEND_BUSY_UPDATES: booleanEnv(false),
  BRIDGE_REQUIRE_CALLBACK_AUTH: booleanEnv(false),
  BRIDGE_STATUS_HEARTBEAT_ENABLED: booleanEnv(true),
  BRIDGE_STATUS_HEARTBEAT_MS: z.coerce.number().int().positive().default(180_000),
  BRIDGE_WATCHDOG_ENABLED: booleanEnv(true),
  BRIDGE_WATCHDOG_STALL_MS: z.coerce.number().int().positive().default(480_000),
  BRIDGE_PUBLIC_WEBHOOK_WATCHDOG_ENABLED: booleanEnv(true),
  BRIDGE_PUBLIC_WEBHOOK_WATCHDOG_MS: z.coerce.number().int().positive().default(120_000),
  BRIDGE_PUBLIC_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  BRIDGE_MANAGED_TUNNEL_ENABLED: booleanEnv(false),
  BRIDGE_TUNNEL_BIN: z.string().min(1).default("cloudflared"),
  BRIDGE_TUNNEL_TARGET_URL: z.string().url().optional(),
  BRIDGE_TUNNEL_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
});

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = envSchema.parse(env);
  const webhookUrl = parsed.ECLAW_WEBHOOK_URL?.replace(/\/$/, "");
  if (!webhookUrl && !parsed.BRIDGE_MANAGED_TUNNEL_ENABLED) {
    throw new Error("ECLAW_WEBHOOK_URL is required unless BRIDGE_MANAGED_TUNNEL_ENABLED=true.");
  }
  const statePath = path.isAbsolute(parsed.BRIDGE_STATE_PATH)
    ? parsed.BRIDGE_STATE_PATH
    : path.resolve(process.cwd(), parsed.BRIDGE_STATE_PATH);

  return {
    eclawApiBase: parsed.ECLAW_API_BASE.replace(/\/$/, ""),
    eclawApiKey: parsed.ECLAW_API_KEY,
    eclawApiSecret: emptyToUndefined(parsed.ECLAW_API_SECRET),
    eclawWebhookUrl: webhookUrl ?? "https://managed-tunnel.pending",
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
    bridgeWatchdogEnabled: parsed.BRIDGE_WATCHDOG_ENABLED,
    bridgeWatchdogStallMs: parsed.BRIDGE_WATCHDOG_STALL_MS,
    bridgePublicWebhookWatchdogEnabled: parsed.BRIDGE_PUBLIC_WEBHOOK_WATCHDOG_ENABLED,
    bridgePublicWebhookWatchdogMs: parsed.BRIDGE_PUBLIC_WEBHOOK_WATCHDOG_MS,
    bridgePublicWebhookTimeoutMs: parsed.BRIDGE_PUBLIC_WEBHOOK_TIMEOUT_MS,
    bridgeManagedTunnelEnabled: parsed.BRIDGE_MANAGED_TUNNEL_ENABLED,
    bridgeTunnelBin: parsed.BRIDGE_TUNNEL_BIN,
    bridgeTunnelTargetUrl: parsed.BRIDGE_TUNNEL_TARGET_URL ?? `http://localhost:${parsed.ECLAW_WEBHOOK_PORT}`,
    bridgeTunnelReadyTimeoutMs: parsed.BRIDGE_TUNNEL_READY_TIMEOUT_MS,
  };
}
