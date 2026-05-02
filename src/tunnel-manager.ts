import { spawn, type ChildProcess } from "node:child_process";
import type { BridgeConfig } from "./types.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

export type ManagedTunnelStatus = {
  enabled: boolean;
  running: boolean;
  pid?: number;
  publicUrl?: string;
  lastStartedAt?: string;
  lastError?: string;
};

export class ManagedTunnel {
  private child?: ChildProcess;
  private publicUrl?: string;
  private lastStartedAt?: string;
  private lastError?: string;

  constructor(private readonly config: BridgeConfig) {}

  status(): ManagedTunnelStatus {
    return {
      enabled: this.config.bridgeManagedTunnelEnabled,
      running: this.isRunning(),
      pid: this.child?.pid,
      publicUrl: this.publicUrl,
      lastStartedAt: this.lastStartedAt,
      lastError: this.lastError,
    };
  }

  async ensureStarted(): Promise<string> {
    if (this.isRunning() && this.publicUrl) return this.publicUrl;
    return this.start();
  }

  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.publicUrl = undefined;
    if (!child || child.exitCode !== null || child.killed) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async start(): Promise<string> {
    this.lastStartedAt = new Date().toISOString();
    this.lastError = undefined;
    const child = spawn(this.config.bridgeTunnelBin, [
      "tunnel",
      "--url",
      this.config.bridgeTunnelTargetUrl,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    console.log(`[bridge] managed tunnel starting for ${this.config.bridgeTunnelTargetUrl}`);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.lastError = `Tunnel did not publish a public URL within ${this.config.bridgeTunnelReadyTimeoutMs}ms.`;
        child.kill("SIGTERM");
        reject(new Error(this.lastError));
      }, this.config.bridgeTunnelReadyTimeoutMs);

      const finish = (url: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.publicUrl = url.replace(/\/$/, "");
        console.log(`[bridge] managed tunnel public URL: ${this.publicUrl}`);
        resolve(this.publicUrl);
      };

      const handleData = (data: Buffer): void => {
        const text = data.toString("utf8");
        const match = text.match(QUICK_TUNNEL_URL_RE)?.[0];
        if (match) finish(match);
      };

      child.stdout?.on("data", handleData);
      child.stderr?.on("data", handleData);
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.lastError = err.message;
        reject(err);
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.lastError = `Tunnel exited before ready: code ${code ?? "null"}, signal ${signal ?? "null"}.`;
          reject(new Error(this.lastError));
          return;
        }
        if (this.child === child) {
          this.child = undefined;
          this.lastError = `Tunnel exited: code ${code ?? "null"}, signal ${signal ?? "null"}.`;
        }
      });
    });
  }

  private isRunning(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }
}
