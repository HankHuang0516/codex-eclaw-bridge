import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexStatusUpdateMessage,
  buildCodexTimeoutWarningMessage,
} from "../scripts/eclaw-polling-bridge.mjs";

const childProcessMock = vi.hoisted(() => {
  const state = {
    spawnImpl: () => {
      throw new Error("spawn mock not configured");
    },
    spawn: vi.fn((...args) => state.spawnImpl(...args)),
  };
  return state;
});

vi.mock("node:child_process", () => ({
  spawn: childProcessMock.spawn,
}));

const cleanupTasks = [];
const envKeys = [
  "ECLAW_API_BASE",
  "CODEX_ECLAW_BRIDGE_DIR",
  "CODEX_WORKSPACE",
  "CODEX_BIN",
  "CODEX_POLL_BRIDGE_TIMEOUT_MS",
  "CODEX_POLL_BRIDGE_NEAR_TIMEOUT_WARNING_MS",
  "CODEX_POLL_BRIDGE_NEAR_TIMEOUT_CANCEL_MS",
  "CODEX_POLL_BRIDGE_TERMINATE_GRACE_MS",
  "CODEX_POLL_BRIDGE_DIAGNOSTIC_LOG",
  "CODEX_POLL_BRIDGE_STATUS_UPDATES",
  "BUSY_HEARTBEAT_DISABLED",
];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  childProcessMock.spawn.mockClear();
  childProcessMock.spawnImpl = () => {
    throw new Error("spawn mock not configured");
  };
  vi.resetModules();
});

describe("eclaw polling bridge status heartbeat", () => {
  it("redacts the active prompt preview", () => {
    const fakeBotSecret = "fake-bot-secret-123456";
    const fakeDeviceSecret = "fake-device-secret-654321";
    const message = buildCodexStatusUpdateMessage(
      {
        durationMs: 42_000,
        prompt: `curl -d '{"deviceId":"fake-device","botSecret":"${fakeBotSecret}","deviceSecret":"${fakeDeviceSecret}"}'`,
        lastOutputAt: "2026-05-01T10:00:00.000Z",
      },
      1_200_000,
    );

    expect(message).toContain("Codex #6 status heartbeat");
    expect(message).toContain("Task: [task in progress - preview redacted to prevent secret leak]");
    expect(message).not.toContain(fakeBotSecret);
    expect(message).not.toContain(fakeDeviceSecret);
    expect(message).not.toContain("botSecret");
    expect(message).not.toContain("deviceSecret");
    expect(message).not.toContain("fake-device");
    expect(message).toContain("Hard cutoff: 20m 0s");
  });

  it("formats timeout warnings without exposing prompt text", () => {
    const fakeBotSecret = "fake-bot-secret-123456";
    const message = buildCodexTimeoutWarningMessage(
      {
        durationMs: 15 * 60_000,
        prompt: `finish before timeout botSecret=${fakeBotSecret}`,
        lastOutputAt: null,
      },
      20 * 60_000,
      18 * 60_000,
    );

    expect(message).toContain("Codex #6 timeout warning");
    expect(message).toContain("Task: [task in progress - preview redacted to prevent secret leak]");
    expect(message).toContain("Elapsed: 15m 0s");
    expect(message).toContain("Cancel signal: 18m 0s");
    expect(message).toContain("Hard cutoff: 20m 0s");
    expect(message).not.toContain(fakeBotSecret);
    expect(message).not.toContain("botSecret");
  });
});

async function startScaledCodexRun({ closeAfterMs }) {
  vi.resetModules();
  vi.useFakeTimers();
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "eclaw-polling-bridge-test-"));
  const diagnosticLog = path.join(tempDir, "diagnostics.jsonl");
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ECLAW_API_BASE: "https://example.invalid",
    CODEX_ECLAW_BRIDGE_DIR: tempDir,
    CODEX_WORKSPACE: tempDir,
    CODEX_BIN: "codex-test",
    CODEX_POLL_BRIDGE_TIMEOUT_MS: "120",
    CODEX_POLL_BRIDGE_NEAR_TIMEOUT_WARNING_MS: "90",
    CODEX_POLL_BRIDGE_NEAR_TIMEOUT_CANCEL_MS: "108",
    CODEX_POLL_BRIDGE_TERMINATE_GRACE_MS: "12",
    CODEX_POLL_BRIDGE_DIAGNOSTIC_LOG: diagnosticLog,
    CODEX_POLL_BRIDGE_STATUS_UPDATES: "0",
    BUSY_HEARTBEAT_DISABLED: "0",
  });
  cleanupTasks.push(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fsSync.rmSync(tempDir, { recursive: true, force: true });
  });

  const kills = [];
  childProcessMock.spawnImpl = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    child.kill = vi.fn((signal) => {
      kills.push(signal);
      if (signal === "SIGKILL") {
        child.emit("close", null, "SIGKILL");
      }
      return true;
    });

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    if (Number.isFinite(closeAfterMs)) {
      globalThis.setTimeout(() => {
        fsSync.writeFileSync(outputPath, "Codex completed");
        child.emit("close", 0, null);
      }, closeAfterMs);
    }
    return child;
  };

  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ success: true }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const bridge = await import("../scripts/eclaw-polling-bridge.mjs");
  const promise = bridge.runCodex(
    { deviceId: "dev", entityId: 6, botSecret: "secret" },
    { id: "inbound_1", text: "run the acceptance test", source: "entity:2:LOBSTER->6" },
  );
  expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);

  const readTimeoutEvents = () => {
    if (!fsSync.existsSync(diagnosticLog)) return [];
    return fsSync
      .readFileSync(diagnosticLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event.startsWith("timeout_"))
      .map((event) => event.event);
  };

  return { fetchMock, kills, promise, readTimeoutEvents };
}

describe("eclaw polling bridge timeout acceptance", () => {
  it("14min task completes before warning or cancellation", async () => {
    const run = await startScaledCodexRun({ closeAfterMs: 84 });

    await vi.advanceTimersByTimeAsync(84);

    await expect(run.promise).resolves.toBe("Codex completed");
    expect(run.readTimeoutEvents()).toEqual([]);
    expect(run.fetchMock).not.toHaveBeenCalled();
    expect(run.kills).toEqual([]);
  });

  it("17min task warns once at 15min and then completes", async () => {
    const run = await startScaledCodexRun({ closeAfterMs: 102 });

    await vi.advanceTimersByTimeAsync(90);
    expect(run.fetchMock).toHaveBeenCalledTimes(1);
    expect(run.readTimeoutEvents()).toEqual(["timeout_warning"]);

    await vi.advanceTimersByTimeAsync(12);

    await expect(run.promise).resolves.toBe("Codex completed");
    expect(run.readTimeoutEvents()).toEqual(["timeout_warning"]);
    expect(run.kills).toEqual([]);
  });

  it("25min runaway warns, cancels at 18min, and kills at 20min", async () => {
    const run = await startScaledCodexRun({ closeAfterMs: null });

    await vi.advanceTimersByTimeAsync(90);
    expect(run.fetchMock).toHaveBeenCalledTimes(1);
    expect(run.readTimeoutEvents()).toEqual(["timeout_warning"]);

    await vi.advanceTimersByTimeAsync(18);
    expect(run.kills).toEqual(["SIGTERM"]);
    expect(run.readTimeoutEvents()).toEqual(["timeout_warning", "timeout_cancel"]);

    await vi.advanceTimersByTimeAsync(12);

    await expect(run.promise).rejects.toThrow("codex exec timed out after 120ms");
    expect(run.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(run.readTimeoutEvents()).toEqual(["timeout_warning", "timeout_cancel", "timeout_kill"]);
  });
});
