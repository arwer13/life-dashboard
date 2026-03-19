import type { InlineTaskItem } from "../models/types";

/**
 * Priority emoji mapping (Tasks-plugin convention):
 * 🔺 (U+1F53A) → 0 (highest)
 * ⏫ (U+23EB)  → 1 (high)
 * 🔼 (U+1F53C) → 2 (medium)
 * 🔽 (U+1F53D) → 3 (low)
 * ⏬ (U+23EC)  → 4 (lowest)
 */
const PRIORITY_EMOJI_MAP = new Map<string, number>([
  ["\u{1F53A}", 0], // 🔺 highest
  ["\u23EB", 1],    // ⏫ high
  ["\u{1F53C}", 2], // 🔼 medium
  ["\u{1F53D}", 3], // 🔽 low
  ["\u23EC", 4],    // ⏬ lowest
]);

const PRIORITY_EMOJI_PATTERN = /[\u{1F53A}\u{1F53C}\u{1F53D}\u23EB\u23EC]/gu;

/** Digit (0-4) → priority emoji for writing back to checkbox lines. */
export const PRIORITY_DIGIT_TO_EMOJI = new Map<string, string>(
  [...PRIORITY_EMOJI_MAP].map(([emoji, rank]) => [String(rank), emoji])
);

/** Strip all Tasks-plugin priority emojis from text, collapsing leftover whitespace. */
export function stripPriorityEmojis(text: string): string {
  return text.replace(PRIORITY_EMOJI_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

/** Extract the priority rank (0-4) from text containing a Tasks-plugin emoji, or null if none. */
export function parsePriorityFromText(text: string): number | null {
  for (const [emoji, rank] of PRIORITY_EMOJI_MAP) {
    if (text.includes(emoji)) return rank;
  }
  return null;
}

/** Synthetic path separator for inline checkbox items. */
export const INLINE_CHECKBOX_PATH_SEP = "#checkbox:";

/** Parse a synthetic inline checkbox path back into file path + line number. */
export function parseInlinePath(inlinePath: string): { filePath: string; line: number } | null {
  const sepIdx = inlinePath.indexOf(INLINE_CHECKBOX_PATH_SEP);
  if (sepIdx < 0) return null;
  const line = Number.parseInt(inlinePath.slice(sepIdx + INLINE_CHECKBOX_PATH_SEP.length), 10);
  if (!Number.isFinite(line)) return null;
  return { filePath: inlinePath.slice(0, sepIdx), line };
}

export const TASKS_HEADING_RE = /^(#{1,2})\s+tasks\s*$/i;
export const ANY_HEADING_RE = /^(#{1,6})\s/;
const UNCHECKED_CHECKBOX_RE = /^[-*]\s+\[ \]\s+(.+)$/;

/**
 * Parse a concern file's content for inline checkbox subtasks under `# Tasks` or `## Tasks` headings.
 *
 * Returns InlineTaskItem[] for each unchecked `- [ ] text` line found within those sections.
 */
export function parseInlineTasksForFile(parentPath: string, content: string): InlineTaskItem[] {
  const lines = content.split("\n");
  const items: InlineTaskItem[] = [];

  let insideTasksSection = false;
  let sectionHeadingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    // Check for any heading
    const headingMatch = ANY_HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;

      // Check if this is a Tasks heading
      const tasksMatch = TASKS_HEADING_RE.exec(line);
      if (tasksMatch) {
        insideTasksSection = true;
        sectionHeadingLevel = tasksMatch[1].length;
        continue;
      }

      // If we're in a tasks section and hit a heading of same or higher level, exit
      if (insideTasksSection && level <= sectionHeadingLevel) {
        insideTasksSection = false;
      }
      continue;
    }

    if (!insideTasksSection) continue;

    // Try to match unchecked checkbox
    const trimmed = line.replace(/^\s+/, "");
    const checkboxMatch = UNCHECKED_CHECKBOX_RE.exec(trimmed);
    if (!checkboxMatch) continue;

    const rawText = checkboxMatch[1].trim();
    const displayText = stripPriorityEmojis(rawText);
    if (!displayText) continue;

    const priority = parsePriorityFromText(rawText);

    items.push({
      kind: "inline",
      path: `${parentPath}${INLINE_CHECKBOX_PATH_SEP}${i}`,
      basename: displayText,
      parentPath,
      text: rawText,
      line: i,
      priority,
    });
  }

  return items;
}
