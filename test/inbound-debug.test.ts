import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inboundDebugHandler } from "../src/inbound-debug.js";
import type { BridgeAppDeps } from "../src/server.js";

function app(token: string | undefined = "owner-callback-token") {
  const deps = {
    config: { eclawCallbackToken: token, eclawApiBase: "https://eclawbot.com" },
    stateStore: { read: async () => ({ deviceId: "dev", entityId: 12, botSecret: "private-test-secret" }) },
    sessionManager: { status: () => ({ activeThreadId: "thread", activeTurnId: "turn", queuedInboundCount: 2,
      steeredInboundCount: 3, steerFallbackCount: 1, activePrompt: "private queued text", lastTurnError: "secret-error", lastEvent: "turn/steer" }) },
    codex: { status: () => ({ connected: true, endpoint: "private endpoint", pid: 123 }) },
    approvalRouter: { status: () => ({ pending: 0 }) },
  } as unknown as BridgeAppDeps;
  const server = express(); server.get("/api/debug/codex-inbound", inboundDebugHandler(deps)); return server;
}

afterEach(() => vi.unstubAllGlobals());

describe("codex inbound owner diagnostics", () => {
  it("requires owner authentication even when general webhook authentication is disabled", async () => {
    await request(app(undefined)).get("/api/debug/codex-inbound").expect(401);
    await request(app()).get("/api/debug/codex-inbound").set("Authorization", "Bearer wrong-token").expect(401);
  });
  it("accepts the configured owner callback token and reveals metadata only", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const r = await request(app()).get("/api/debug/codex-inbound").set("Authorization", "Bearer owner-callback-token").expect(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toMatchObject({ success: true, bug: "codex-inbound", diagnostics: { entityId: 12, active: true, queuedInboundCount: 2, steeredInboundCount: 3, steerFallbackCount: 1 } });
    expect(JSON.stringify(r.body)).not.toMatch(/private|secret|owner-callback-token|deviceId|endpoint|pid/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks a matching deviceId/deviceSecret against the canonical EClaw owner auth", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, logs: [{ message: "private-server-log" }] }) });
    vi.stubGlobal("fetch", fetch);
    const r = await request(app()).get("/api/debug/codex-inbound").query({ deviceId: "dev", deviceSecret: "owner-secret" }).expect(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/logs"); expect(url.searchParams.get("limit")).toBe("1");
    expect(JSON.stringify(r.body)).not.toMatch(/owner-secret|private-server-log/);
  });
  it("rejects a different device before making an upstream request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await request(app()).get("/api/debug/codex-inbound").query({ deviceId: "other", deviceSecret: "owner-secret" }).expect(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid device secrets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    await request(app()).get("/api/debug/codex-inbound").query({ deviceId: "dev", deviceSecret: "wrong" }).expect(401);
  });
  it("fails closed on auth outages without echoing credential-bearing errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("deviceSecret=owner-secret")));
    const r = await request(app()).get("/api/debug/codex-inbound").query({ deviceId: "dev", deviceSecret: "owner-secret" }).expect(502);
    expect(r.body).toEqual({ success: false, error: "diagnostics_unavailable" });
  });
});
