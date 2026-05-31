import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  ECLAW_API_KEY: "test-channel-key",
  ECLAW_WEBHOOK_URL: "https://example.com/hook",
  CODEX_WORKSPACE: "/tmp",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("disables status heartbeats by default", () => {
    const config = loadConfig(baseEnv);

    expect(config.bridgeStatusHeartbeatEnabled).toBe(false);
  });

  it("honors the BUSY_HEARTBEAT_DISABLED kill switch", () => {
    const config = loadConfig({
      ...baseEnv,
      BRIDGE_STATUS_HEARTBEAT_ENABLED: "true",
      BUSY_HEARTBEAT_DISABLED: "1",
    });

    expect(config.bridgeStatusHeartbeatEnabled).toBe(false);
  });
});
