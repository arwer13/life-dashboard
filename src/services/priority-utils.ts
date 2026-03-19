import type { TaskItem } from "../models/types";

export type PriorityDigit = "0" | "1" | "2" | "3" | "4";

export function normalizePriorityValue(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value as string).trim().toLowerCase();
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
  const rawText = String(rawPriority as string).trim();
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

/** Keys that trigger the reparent/promote action (§ on en layout, > on ru layout — same physical key). */
export function isReparentKey(key: string): boolean {
  return key === "§" || key === ">";
}

export type PriorityHotkeyCallbacks = {
  onReparent: (path: string) => void;
  onPriorityDigit: (path: string, digit: string) => void;
  onPriorityClear: (path: string) => void;
};

export function handlePriorityHotkey(
  event: KeyboardEvent,
  hoveredPath: string | null,
  callbacks: PriorityHotkeyCallbacks
): boolean {
  if (!hoveredPath) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.repeat) return false;
  if (shouldIgnorePriorityHotkeyTarget(event.target)) return false;

  const isReparent = isReparentKey(event.key);
  if (event.shiftKey && !isReparent) return false;

  const isPriorityDigit = isPriorityDigitKey(event.key);
  const isPriorityClear = event.key === "-";
  if (!isPriorityDigit && !isPriorityClear && !isReparent) return false;

  event.preventDefault();
  event.stopPropagation();

  if (isReparent) {
    callbacks.onReparent(hoveredPath);
  } else if (isPriorityClear) {
    callbacks.onPriorityClear(hoveredPath);
  } else {
    callbacks.onPriorityDigit(hoveredPath, event.key);
  }
  return true;
}

export function shouldIgnorePriorityHotkeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/**
 * Unified priority rank for any TaskItem.
 * Lower number = higher priority. Returns 100 for unset/unknown.
 */
export function getItemPriorityRank(item: TaskItem): number {
  if (item.kind === "inline") {
    return item.priority ?? 100;
  }
  // File item: read from frontmatter priority/prio/p
  const fm = item.frontmatter;
  if (!fm) return 100;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const raw = fm.priority ?? fm.prio ?? fm.p;
  return getPriorityRankFromValue(raw);
}

/**
 * Convert a raw frontmatter priority value to a numeric rank.
 * Handles: null→100, number→value, "urgent"→0, "high"→1, "medium"/"med"→2,
 * "low"→3, /^p\d+$/→digit, numeric string→value, else→100.
 */
export function getPriorityRankFromValue(value: unknown): number {
  if (value == null) return 100;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }

  const normalized = String(value as string).trim().toLowerCase();
  if (!normalized) return 100;
  if (normalized === "urgent") return 0;
  if (normalized === "high") return 1;
  if (normalized === "medium" || normalized === "med") return 2;
  if (normalized === "low") return 3;

  const pMatch = /^p([0-9]+)$/.exec(normalized);
  if (pMatch?.[1]) {
    return Number.parseInt(pMatch[1], 10);
  }

  const parsed = Number.parseFloat(normalized);
  if (Number.isFinite(parsed)) {
    return Math.max(0, parsed);
  }

  return 100;
}

/**
 * Get a priority badge string for display, or null if no priority is set.
 */
export function getItemPriorityBadge(item: TaskItem): string | null {
  if (item.kind === "inline") {
    return item.priority != null ? "p" + item.priority : null;
  }
  return formatPriorityBadgeText(item.frontmatter?.priority);
}
