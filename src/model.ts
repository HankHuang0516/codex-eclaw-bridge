const MAX_CODEX_MODEL_LENGTH = 80;
const CODEX_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const UNSAFE_MODEL_MARKERS = [
  /\[Local Variables available:/i,
  /\[AVAILABLE TOOLS/i,
  /\bbotSecret\b/i,
  /\bdeviceSecret\b/i,
  /\bcurl\b/i,
  /https?:\/\//i,
  /\/api\//i,
];

export function sanitizeCodexModel(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CODEX_MODEL_LENGTH) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  if (!CODEX_MODEL_PATTERN.test(trimmed)) return undefined;
  if (UNSAFE_MODEL_MARKERS.some((marker) => marker.test(trimmed))) return undefined;
  return trimmed;
}

const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const REASONING_EFFORT_ALIASES = new Map([
  ["低", "low"],
  ["中", "medium"],
  ["高", "high"],
  ["超高", "xhigh"],
]);

export function sanitizeCodexReasoningEffort(effort: string | null | undefined): string | undefined {
  const trimmed = effort?.trim().toLowerCase();
  if (!trimmed) return undefined;
  const normalized = REASONING_EFFORT_ALIASES.get(trimmed) ?? trimmed;
  return REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}
