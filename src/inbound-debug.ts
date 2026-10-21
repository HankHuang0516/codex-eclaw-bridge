import crypto from "node:crypto";
import type { RequestHandler } from "express";
import type { BridgeAppDeps } from "./server.js";

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Owner-only, metadata-only diagnostics; never expose prompts or queued input. */
export function inboundDebugHandler(deps: BridgeAppDeps): RequestHandler {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const state = await deps.stateStore.read();
      const token = deps.config.eclawCallbackToken;
      const callbackOwner = Boolean(token && sameToken(String(req.headers.authorization ?? ""), `Bearer ${token}`));
      if (!callbackOwner) {
        const { deviceId, deviceSecret } = req.query;
        if (typeof deviceId !== "string" || typeof deviceSecret !== "string" || !deviceSecret || deviceId !== state.deviceId) {
          res.status(401).json({ success: false, error: "invalid_owner_credentials" });
          return;
        }
        // /api/logs uses the canonical deviceId + deviceSecret owner check.
        // Fetch one row only, discard it, and never echo the URL or response.
        const url = new URL("/api/logs", deps.config.eclawApiBase);
        url.search = new URLSearchParams({ deviceId, deviceSecret, limit: "1", filterDevice: deviceId }).toString();
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
        if (response.status === 401 || response.status === 403) {
          res.status(401).json({ success: false, error: "invalid_owner_credentials" });
          return;
        }
        const auth = await response.json() as { success?: boolean };
        if (!response.ok || auth.success !== true) throw new Error("Owner verification unavailable.");
      }
      const session = deps.sessionManager.status();
      res.json({
        success: true,
        bug: "codex-inbound",
        diagnostics: {
          entityId: state.entityId,
          connected: deps.codex.status().connected,
          active: Boolean(session.activeThreadId),
          activeTurnId: session.activeTurnId ?? null,
          lastActivityAt: session.lastActivityAt ?? null,
          lastEvent: session.lastEvent ?? null,
          queuedInboundCount: session.queuedInboundCount ?? 0,
          steeredInboundCount: session.steeredInboundCount ?? 0,
          steerFallbackCount: session.steerFallbackCount ?? 0,
          lastInboundAt: session.lastInboundAt ?? null,
          lastSteeredAt: session.lastSteeredAt ?? null,
          approvalsPending: deps.approvalRouter.status().pending,
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(502).json({ success: false, error: "diagnostics_unavailable" });
    }
  };
}
