import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import type {
  BridgeConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  ServerNotificationMessage,
  ServerRequestMessage,
} from "./types.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

export type CodexClientEvents = {
  notification: [ServerNotificationMessage];
  serverRequest: [ServerRequestMessage];
};

export class CodexClient extends EventEmitter<CodexClientEvents> {
  private proc?: ChildProcessByStdio<null, Readable, Readable>;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private endpoint?: string;

  constructor(private readonly config: BridgeConfig) {
    super();
  }

  async start(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.endpoint = await this.launchAppServer();
    await this.connect(this.endpoint);
    await this.request("initialize", {
      clientInfo: {
        name: "codex-eclaw-bridge",
        title: "Codex EClaw Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex client stopped."));
    }
    this.pending.clear();
    this.ws?.close();
    this.proc?.kill("SIGTERM");
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not connected.");
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    this.ws.send(JSON.stringify(message));
    return promise;
  }

  respond(id: number | string, result: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not connected.");
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  fail(id: number | string, code: number, message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not connected.");
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  status(): { connected: boolean; endpoint?: string; pid?: number } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      endpoint: this.endpoint,
      pid: this.proc?.pid,
    };
  }

  private async launchAppServer(): Promise<string> {
    const args = ["app-server", "--listen", this.config.codexAppServerListen];
    this.proc = spawn(this.config.codexBin, args, {
      cwd: this.config.codexWorkspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for codex app-server endpoint. stdout=${stdout} stderr=${stderr}`));
      }, 30_000);

      const check = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        stdout += text;
        stderr += text;
        const match = text.match(/ws:\/\/[^\s"'<>]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };

      this.proc?.stdout.on("data", check);
      this.proc?.stderr.on("data", check);
      this.proc?.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.proc?.once("exit", (code) => {
        if (!this.endpoint) {
          clearTimeout(timer);
          reject(new Error(`codex app-server exited early with code ${code}. stdout=${stdout} stderr=${stderr}`));
        }
      });
    });
  }

  private async connect(endpoint: string): Promise<void> {
    this.ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${endpoint}`)), 15_000);
      this.ws?.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws?.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.ws.on("message", (raw) => this.handleMessage(raw.toString("utf8")));
    this.ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Codex app-server websocket closed."));
      }
      this.pending.clear();
    });
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcResponse | ServerNotificationMessage | ServerRequestMessage;
    try {
      message = JSON.parse(raw) as JsonRpcResponse | ServerNotificationMessage | ServerRequestMessage;
    } catch {
      return;
    }
    if (process.env.DEBUG_CODEX_EVENTS === "true" && "method" in message) {
      console.error("[codex:event]", JSON.stringify(message));
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("id" in message && "method" in message) {
      this.emit("serverRequest", message as ServerRequestMessage);
      return;
    }

    if ("method" in message) {
      this.emit("notification", message as ServerNotificationMessage);
    }
  }
}
