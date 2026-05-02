import { describe, expect, it } from "vitest";
import { formatInboundForCodex, isBridgeCommand, parseBridgeCommand, sanitizeInboundTextForCodex, shouldIgnoreInbound } from "../src/payload.js";

describe("payload helpers", () => {
  it("ignores silent token messages", () => {
    expect(shouldIgnoreInbound({
      deviceId: "dev",
      entityId: 1,
      text: "[SILENT]",
    })).toEqual({ ignore: true, reason: "silent_token" });
  });

  it("ignores non-reply system events", () => {
    expect(shouldIgnoreInbound({
      deviceId: "dev",
      entityId: 1,
      from: "system",
      text: "[SYSTEM:NAME_CHANGED]",
      eclaw_context: { expectsReply: false },
    })).toEqual({ ignore: true, reason: "system_no_reply" });
  });

  it("ignores kanban notifications unless EClaw explicitly expects a reply", () => {
    expect(shouldIgnoreInbound({
      deviceId: "dev",
      entityId: 1,
      event: "kanban_notification",
      from: "kanban",
      text: "New task assigned",
      eclaw_context: { silentToken: "[SILENT]" },
    })).toEqual({ ignore: true, reason: "kanban_notification_no_reply" });
  });

  it("allows normal messages", () => {
    expect(shouldIgnoreInbound({
      deviceId: "dev",
      entityId: 1,
      from: "client",
      text: "hello",
    })).toEqual({ ignore: false });
  });

  it("parses bridge commands", () => {
    expect(parseBridgeCommand("/model gpt-5.4")).toEqual({ name: "model", args: "gpt-5.4" });
    expect(parseBridgeCommand("/模型")).toEqual({ name: "model", args: "" });
    expect(isBridgeCommand("!codex status")).toBe(true);
    expect(parseBridgeCommand("!codex model gpt-5.4-mini")).toEqual({ name: "model", args: "gpt-5.4-mini" });
    expect(parseBridgeCommand("!codex")).toEqual({ name: "status", args: "" });
  });

  it("parses only the first command line before inlined EClaw context", () => {
    const injected = [
      "/model",
      "",
      "[Local Variables available: GIT_HUB2]",
      "exec: curl -s \"https://eclawbot.com/api/device-vars?deviceId=dev&botSecret=secret\"",
    ].join("\n");

    expect(isBridgeCommand(injected)).toBe(true);
    expect(parseBridgeCommand(injected)).toEqual({ name: "model", args: "" });
    expect(parseBridgeCommand("!codex reset\n\n[AVAILABLE TOOLS — Mission Dashboard]")).toEqual({
      name: "reset",
      args: "",
    });
  });

  it("does not duplicate mission hints when EClaw already inlined context", () => {
    const prompt = formatInboundForCodex({
      deviceId: "dev",
      entityId: 1,
      text: "hello\n\n[AVAILABLE TOOLS — Mission Dashboard]\nRead notes",
      contextInlined: true,
      eclaw_context: {
        missionHints: "[AVAILABLE TOOLS — Mission Dashboard]\nRead notes",
      },
    });

    expect(prompt.match(/\[AVAILABLE TOOLS/g)).toHaveLength(1);
    expect(prompt).not.toContain("Mission/API hints from EClaw:");
  });

  it("removes EClaw local variables marker before sending text to Codex", () => {
    const text = [
      "please investigate #6",
      "",
      "[Local Variables available: GIT_HUB2, OPENAI_API_KEY]",
      "exec: curl -s \"https://eclawbot.com/api/device-vars?deviceId=dev&botSecret=secret\"",
    ].join("\n");

    const sanitized = sanitizeInboundTextForCodex(text);
    expect(sanitized.removedLocalVariablesHint).toBe(true);
    expect(sanitized.text).toContain("please investigate #6");
    expect(sanitized.text).not.toContain("[Local Variables available");
    expect(sanitized.text).not.toContain("botSecret=secret");

    const prompt = formatInboundForCodex({ deviceId: "dev", entityId: 6, text });
    expect(prompt).toContain("EClaw vault context:");
    expect(prompt).not.toContain("[Local Variables available");
    expect(prompt).not.toContain("botSecret=secret");
  });
});
