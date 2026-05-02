import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/redact.js";

describe("redactSensitiveText", () => {
  it("collapses unsafe local-vars model errors and redacts credentials", () => {
    const redacted = redactSensitiveText(
      "The '[Local Variables available: GIT_HUB2]\\nexec: curl -s \"https://eclawbot.com/api/mission/cards?deviceId=dev&botSecret=abc123\"' model is not supported",
    );

    expect(redacted).toContain("[redacted unsafe model]");
    expect(redacted).not.toContain("GIT_HUB2");
    expect(redacted).not.toContain("abc123");
  });

  it("redacts query string and json-like secret values", () => {
    const redacted = redactSensitiveText(
      'botSecret=abc123&deviceSecret=def456 {"botSecret":"ghi789","token":"jkl012"}',
    );

    expect(redacted).toContain("botSecret=[redacted]");
    expect(redacted).toContain("deviceSecret=[redacted]");
    expect(redacted).toContain('"botSecret":"[redacted]"');
    expect(redacted).toContain('"token":"[redacted]"');
  });
});
