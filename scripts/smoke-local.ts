import { handleWebhookPayload } from "../src/server.js";
import type { BridgeAppDeps } from "../src/server.js";

const sent: unknown[] = [];
const deps: BridgeAppDeps = {
  config: {
    eclawApiBase: "https://eclawbot.com",
    eclawApiKey: "eck_test",
    eclawWebhookUrl: "https://example.com",
    eclawWebhookPort: 18800,
    eclawBotName: "Codex",
    codexBin: "codex",
    codexWorkspace: process.cwd(),
    codexSandbox: "workspace-write",
    codexApprovalPolicy: "on-request",
    codexAppServerListen: "ws://127.0.0.1:0",
    bridgeStatePath: ".data/state.json",
    bridgeReplyTimeoutMs: 1000,
    bridgeApprovalTimeoutMs: 1000,
    bridgeSendBusyUpdates: false,
    bridgeRequireCallbackAuth: false,
  },
  codex: { status: () => ({ connected: true }) } as any,
  eclaw: { sendMessage: async (_state: unknown, message: string) => sent.push(message) } as any,
  stateStore: { read: async () => ({ deviceId: "dev", entityId: 1, botSecret: "secret" }) } as any,
  sessionManager: { status: () => ({ bufferedChars: 0 }), handleInbound: async () => "local smoke reply" } as any,
  approvalRouter: { status: () => ({ pending: 0, askIds: [] }), resolveFromPayload: () => false } as any,
};

await handleWebhookPayload(deps, { deviceId: "dev", entityId: 1, text: "hello" });
if (sent.at(-1) !== "local smoke reply") {
  throw new Error(`Unexpected local smoke output: ${JSON.stringify(sent)}`);
}
console.log("local smoke ok");
