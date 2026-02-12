import type { FrontMatterCache, TFile } from "obsidian";

export interface TaskItem {
  file: TFile;
  parentRaw: unknown;
  frontmatter: FrontMatterCache | undefined;
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
