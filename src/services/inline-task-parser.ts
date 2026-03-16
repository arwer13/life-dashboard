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

const TASKS_HEADING_RE = /^(#{1,2})\s+tasks\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s/;
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
    const line = lines[i]!.trimEnd();

    // Check for any heading
    const headingMatch = ANY_HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;

      // Check if this is a Tasks heading
      const tasksMatch = TASKS_HEADING_RE.exec(line);
      if (tasksMatch) {
        insideTasksSection = true;
        sectionHeadingLevel = tasksMatch[1]!.length;
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

    const rawText = checkboxMatch[1]!.trim();
    const { displayText, priority } = extractPriority(rawText);
    if (!displayText) continue;

    items.push({
      kind: "inline",
      path: `${parentPath}#checkbox:${i}`,
      basename: displayText,
      parentPath,
      text: rawText,
      line: i,
      priority,
    });
  }

  return items;
}

function extractPriority(text: string): { displayText: string; priority: number | null } {
  let priority: number | null = null;

  // Find the first priority emoji
  for (const [emoji, rank] of PRIORITY_EMOJI_MAP) {
    if (text.includes(emoji)) {
      priority = rank;
      break;
    }
  }

  // Strip all priority emojis from display text
  const displayText = text.replace(PRIORITY_EMOJI_PATTERN, "").replace(/\s{2,}/g, " ").trim();

  return { displayText, priority };
}
