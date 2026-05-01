import fs from "node:fs/promises";
import path from "node:path";
import type { BridgeState } from "./types.js";

export class StateStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as BridgeState;
    } catch (err: any) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  }

  async write(next: BridgeState): Promise<void> {
    const now = new Date().toISOString();
    const current = await this.read();
    const merged: BridgeState = {
      ...current,
      ...next,
      startedAt: current.startedAt ?? now,
      updatedAt: now,
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }

  async clearThread(): Promise<BridgeState> {
    const current = await this.read();
    const next = { ...current, threadId: undefined, activeTurnId: undefined };
    await this.write(next);
    return next;
  }
}
