import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { EClawClient } from "../src/eclaw-client.js";
import { StateStore } from "../src/state-store.js";
import { registerAndBind } from "../src/server.js";

const config = loadConfig();
if (!config.eclawApiKey.startsWith("eck_") || config.eclawWebhookUrl.includes("example.com")) {
  throw new Error("Live smoke requires real ECLAW_API_KEY and ECLAW_WEBHOOK_URL in .env.");
}

const eclaw = new EClawClient(config);
const stateStore = new StateStore(config.bridgeStatePath);
await registerAndBind(eclaw, stateStore);
const state = await stateStore.read();
await eclaw.sendMessage(state, "Codex EClaw bridge live smoke: registered, bound, and able to send.");
console.log(`live smoke ok: device=${state.deviceId} entity=${state.entityId}`);
console.log("note: this smoke verifies EClaw Channel API delivery, not Codex model quota.");
