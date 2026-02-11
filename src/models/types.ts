import type { TFile } from "obsidian";

export interface TaskItem {
  file: TFile;
  parentRaw: unknown;
}

export interface TaskTreeNode {
  item: TaskItem;
  path: string;
  children: TaskTreeNode[];
  parentPath: string | null;
}

export type TimeLogByNoteId = Record<string, string[]>;
