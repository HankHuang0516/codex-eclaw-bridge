/**
 * card_35cb55fc — wallpaper activity-state redesign (#6 Codex bridge side).
 *
 * The bridge forwards Codex's REAL runtime activity to EClaw's
 * POST /api/entity/heartbeat `runtimeState` field so the live wallpaper
 * reflects what the agent is actually doing. computeRuntimeState() maps the
 * in-process signals (codex connection / pending approval / active turn) to the
 * 4-value contract the EClaw backend receiver consumes; sendRuntimeStateHeartbeat
 * wires it through EClawClient.sendRuntimeHeartbeat.
 *
 * Contract (must match the EClaw-backend receiver EXACTLY):
 *   "busy" | "stuck" | "crashed" | "idle"
 */

import { describe, expect, it, vi } from "vitest";
import { computeRuntimeState, sendRuntimeStateHeartbeat, startRuntimeStateHeartbeat } from "../src/server.js";
import type { BridgeAppDeps } from "../src/server.js";
import { EClawClient } from "../src/eclaw-client.js";
import type { BridgeConfig } from "../src/types.js";

const config: BridgeConfig = {
  eclawApiBase: "https://eclawbot.com",
  eclawApiKey: "eck_test",
  eclawWebhookUrl: "https://example.com",
  eclawWebhookPort: 18800,
  eclawBotName: "Codex",
  codexBin: "codex",
  codexWorkspace: "/tmp",
  codexSandbox: "workspace-write",
  codexApprovalPolicy: "on-request",
  codexAppServerListen: "ws://127.0.0.1:0",
  bridgeStatePath: "/tmp/state.json",
  bridgeReplyTimeoutMs: 1000,
  bridgeApprovalTimeoutMs: 1000,
  bridgeSendBusyUpdates: false,
  bridgeStopProgressUpdates: false,
  bridgeRequireCallbackAuth: false,
  bridgeStatusHeartbeatEnabled: true,
  bridgeStatusHeartbeatMs: 180000,
  bridgeRuntimeHeartbeatEnabled: true,
  bridgeRuntimeHeartbeatMs: 12000,
};

describe("computeRuntimeState — signals → runtimeState contract", () => {
  it("disconnected codex app-server maps to crashed (highest priority)", () => {
    expect(
      computeRuntimeState({ codexConnected: false, approvalsPending: 2, activeTurn: true }),
    ).toBe("crashed");
  });

  it("pending approval maps to stuck", () => {
    expect(
      computeRuntimeState({ codexConnected: true, approvalsPending: 1, activeTurn: true }),
    ).toBe("stuck");
  });

  it("active turn (no pending approval) maps to busy", () => {
    expect(
      computeRuntimeState({ codexConnected: true, approvalsPending: 0, activeTurn: true }),
    ).toBe("busy");
  });

  it("connected, no approval, no active turn maps to idle", () => {
    expect(
      computeRuntimeState({ codexConnected: true, approvalsPending: 0, activeTurn: false }),
    ).toBe("idle");
  });

  it("only ever emits the four contract values", () => {
    const allowed = new Set(["busy", "stuck", "crashed", "idle"]);
    for (const codexConnected of [true, false]) {
      for (const approvalsPending of [0, 1]) {
        for (const activeTurn of [true, false]) {
          expect(allowed.has(computeRuntimeState({ codexConnected, approvalsPending, activeTurn }))).toBe(true);
        }
      }
    }
  });
});

function deps(over: {
  connected?: boolean;
  pending?: number;
  activeTurnId?: string;
  sendRuntimeHeartbeat?: ReturnType<typeof vi.fn>;
} = {}): BridgeAppDeps {
  return {
    config,
    codex: { status: () => ({ connected: over.connected ?? true }) } as any,
    eclaw: { sendRuntimeHeartbeat: over.sendRuntimeHeartbeat ?? vi.fn().mockResolvedValue(true) } as any,
    stateStore: { read: vi.fn().mockResolvedValue({ deviceId: "dev", entityId: 1, botSecret: "secret" }) } as any,
    sessionManager: { status: () => ({ bufferedChars: 0, activeTurnId: over.activeTurnId }) } as any,
    approvalRouter: { status: () => ({ pending: over.pending ?? 0, askIds: [] }) } as any,
  };
}

describe("sendRuntimeStateHeartbeat — wiring", () => {
  it("forwards the computed runtimeState with the bound entity creds", async () => {
    const sendRuntimeHeartbeat = vi.fn().mockResolvedValue(true);
    const ok = await sendRuntimeStateHeartbeat(deps({ activeTurnId: "turn_1", sendRuntimeHeartbeat }));
    expect(ok).toBe(true);
    expect(sendRuntimeHeartbeat).toHaveBeenCalledWith(
      { deviceId: "dev", entityId: 1, botSecret: "secret" },
      "busy",
    );
  });

  it("reports idle when no turn is active", async () => {
    const sendRuntimeHeartbeat = vi.fn().mockResolvedValue(true);
    await sendRuntimeStateHeartbeat(deps({ sendRuntimeHeartbeat }));
    expect(sendRuntimeHeartbeat).toHaveBeenCalledWith(expect.anything(), "idle");
  });
});

describe("startRuntimeStateHeartbeat — gating", () => {
  it("returns undefined when disabled", () => {
    const d = deps();
    d.config = { ...config, bridgeRuntimeHeartbeatEnabled: false };
    expect(startRuntimeStateHeartbeat(d)).toBeUndefined();
  });

  it("returns a timer when enabled", () => {
    const timer = startRuntimeStateHeartbeat(deps());
    expect(timer).toBeDefined();
    if (timer) clearInterval(timer);
  });
});

describe("EClawClient.sendRuntimeHeartbeat", () => {
  it("POSTs runtimeState + creds to /api/entity/heartbeat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EClawClient(config);
    const ok = await client.sendRuntimeHeartbeat({ deviceId: "dev", entityId: 2, botSecret: "secret" }, "stuck");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://eclawbot.com/api/entity/heartbeat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ deviceId: "dev", entityId: 2, botSecret: "secret", runtimeState: "stuck" }),
      }),
    );
  });

  it("returns false (fail-open) when the entity is not bound", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new EClawClient(config);
    const ok = await client.sendRuntimeHeartbeat({ deviceId: undefined, entityId: undefined }, "busy");
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false (fail-open) when the endpoint errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ success: false }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new EClawClient(config);
    const ok = await client.sendRuntimeHeartbeat({ deviceId: "dev", entityId: 2, botSecret: "secret" }, "idle");
    expect(ok).toBe(false);
  });
});
