import type { FrontMatterCache, TFile } from "obsidian";

export interface FileTaskItem {
  kind: "file";
  file: TFile;
  path: string;        // file.path (denormalized for uniform access)
  basename: string;    // file.basename
  parentRaw: unknown;
  frontmatter: FrontMatterCache | undefined;
}

export interface InlineTaskItem {
  kind: "inline";
  path: string;        // synthetic key: "${parentPath}#checkbox:${line}"
  basename: string;    // display text (stripped of priority emoji and inline ID)
  parentPath: string;  // concern file containing the checkbox
  text: string;        // raw checkbox text (with priority emoji, with inline ID)
  line: number;        // 0-based line number in the source file
  priority: number | null;  // numeric rank (0=highest..4=lowest), null if unset
  inlineId: string;    // base62 ID suffix (without $), or "" if none
}

export type TaskItem = FileTaskItem | InlineTaskItem;

export function isFileItem(item: TaskItem): item is FileTaskItem {
  return item.kind === "file";
}

export function isInlineItem(item: TaskItem): item is InlineTaskItem {
  return item.kind === "inline";
}

export interface TaskTreeNode {
  item: TaskItem;
  path: string;
  children: TaskTreeNode[];
  parentPath: string | null;
}

export type TimeLogByNoteId = Record<string, string[]>;

export interface TimeLogEntry {
  startMs: number;
  durationMinutes: number;
}

export interface TimeLogSnapshot {
  totals: Map<string, number>;
  entriesByNoteId: Map<string, TimeLogEntry[]>;
}

export type ListEntry = {
  text: string;
  textLower: string;
  line: number;
};
