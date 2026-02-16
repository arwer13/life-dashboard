export type PriorityDigit = "0" | "1" | "2" | "3" | "4";

export function normalizePriorityValue(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;

  if (isPriorityDigitKey(normalized)) return `p${normalized}`;

  const pMatch = /^p([0-4])$/.exec(normalized);
  if (pMatch?.[1] && isPriorityDigitKey(pMatch[1])) {
    return `p${pMatch[1]}`;
  }

  return null;
}

export function formatPriorityBadgeText(rawPriority: unknown): string | null {
  if (rawPriority == null) return null;
  const rawText = String(rawPriority).trim();
  if (!rawText) return null;

  const normalized = rawText.toLowerCase();
  if (/^p[0-9]+$/.test(normalized)) return normalized;
  if (/^[0-9]+$/.test(normalized)) return `p${normalized}`;

  const compact = rawText.replace(/\s+/g, " ");
  return compact.slice(0, 10);
}

export function isPriorityDigitKey(key: string): key is PriorityDigit {
  return key === "0" || key === "1" || key === "2" || key === "3" || key === "4";
}

export function shouldIgnorePriorityHotkeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
