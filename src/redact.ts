export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /The '\[Local Variables available:[\s\S]*?' model is not supported/gi,
      "The '[redacted unsafe model]' model is not supported",
    )
    .replace(/\[Local Variables available:[^\]]*\]/gi, "[Local Variables available: redacted]")
    .replace(/\b(eck|ecs)_[A-Za-z0-9_-]+/g, "$1_[redacted]")
    .replace(/\b(botSecret|deviceSecret|token|password)=([^&\s"'\\]+)/gi, "$1=[redacted]")
    .replace(/((?:botSecret|deviceSecret|token|password)\s*:\s*)("[^"]*"|'[^']*'|[A-Za-z0-9._-]+)/gi, "$1[redacted]")
    .replace(/((?:botSecret|deviceSecret|token|password)\\?":\\?")([^"\\]+)/gi, "$1[redacted]");
}
