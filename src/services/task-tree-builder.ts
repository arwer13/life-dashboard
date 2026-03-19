import type { MetadataCache } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../models/types";
import { isInlineItem } from "../models/types";
import type { TaskTreeData, TaskTreeBuildOptions, OutlineSortMode } from "../models/view-types";
import { getItemPriorityRank } from "./priority-utils";

export function buildTaskTree(
  tasks: TaskItem[],
  resolveParentPathFn: (parentRaw: unknown, sourcePath: string) => string | null,
  options: TaskTreeBuildOptions = {}
): TaskTreeData {
  const resolveOwnSeconds =
    options.ownSecondsForPath ?? ((_path: string) => 0);
  const sortMode = options.sortMode ?? "recent";
  const resolveLatestTrackedStart =
    options.latestTrackedStartForPath ??
    ((_path: string) => 0);
  const nodesByPath = new Map<string, TaskTreeNode>();

  for (const item of tasks) {
    nodesByPath.set(item.path, {
      item,
      path: item.path,
      children: [],
      parentPath: null
    });
  }

  for (const node of nodesByPath.values()) {
    let parentPath: string | null;
    if (node.item.kind === "inline") {
      parentPath = node.item.parentPath;
    } else {
      parentPath = resolveParentPathFn(node.item.parentRaw, node.item.path);
    }
    if (!parentPath || parentPath === node.path || !nodesByPath.has(parentPath)) continue;
    node.parentPath = parentPath;
    nodesByPath.get(parentPath)?.children.push(node);
  }

  const roots = Array.from(nodesByPath.values()).filter((node) => !node.parentPath);
  const subtreeLatestByPath = new Map<string, number>();
  const visiting = new Set<string>();
  for (const root of roots) {
    computeSubtreeLatestStartMs(root, resolveLatestTrackedStart, subtreeLatestByPath, visiting);
  }

  const sortNodes = (nodes: TaskTreeNode[]): void => {
    nodes.sort((a, b) => compareNodes(a, b, sortMode, subtreeLatestByPath));
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };

  sortNodes(roots);

  const ownSeconds = new Map<string, number>();
  const cumulativeSeconds = new Map<string, number>();
  const computeCumulative = (node: TaskTreeNode, ancestry: Set<string>): number => {
    if (cumulativeSeconds.has(node.path)) return cumulativeSeconds.get(node.path) ?? 0;
    const own = ownSeconds.get(node.path) ?? resolveOwnSeconds(node.path);
    ownSeconds.set(node.path, own);
    if (ancestry.has(node.path)) return own;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.path);

    let total = own;
    for (const child of node.children) {
      total += computeCumulative(child, nextAncestry);
    }

    cumulativeSeconds.set(node.path, total);
    return total;
  };

  for (const root of roots) {
    computeCumulative(root, new Set());
  }

  return { roots, cumulativeSeconds, ownSeconds, nodesByPath };
}

export function resolveParentPath(
  parentRaw: unknown,
  sourcePath: string,
  metadataCache: MetadataCache
): string | null {
  for (const candidate of extractParentCandidates(parentRaw)) {
    const file = metadataCache.getFirstLinkpathDest(candidate, sourcePath);
    if (file) return file.path;
  }
  return null;
}

export function buildParentPathMap(
  tasks: TaskItem[],
  resolveParent: (parentRaw: unknown, sourcePath: string) => string | null
): Map<string, string> {
  const allPaths = new Set(tasks.map((task) => task.path));
  const parentByPath = new Map<string, string>();
  for (const task of tasks) {
    if (isInlineItem(task)) {
      if (allPaths.has(task.parentPath) && task.parentPath !== task.path) {
        parentByPath.set(task.path, task.parentPath);
      }
      continue;
    }
    const parentPath = resolveParent(task.parentRaw, task.path);
    if (!parentPath || !allPaths.has(parentPath) || parentPath === task.path) continue;
    parentByPath.set(task.path, parentPath);
  }
  return parentByPath;
}

export function collectPathsWithParents(
  matchedPaths: Set<string>,
  parentByPath: Map<string, string>,
  scopedPaths?: Set<string>
): Set<string> {
  const output = new Set<string>(matchedPaths);
  for (const path of matchedPaths) {
    let cursor = parentByPath.get(path);
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor) && (!scopedPaths || scopedPaths.has(cursor))) {
      seen.add(cursor);
      output.add(cursor);
      cursor = parentByPath.get(cursor);
    }
  }
  return output;
}

export function collectScopePaths(
  tasks: TaskItem[],
  parentByPath: Map<string, string>,
  rootPath: string
): Set<string> {
  const allPaths = new Set(tasks.map((task) => task.path));
  if (!rootPath || !allPaths.has(rootPath)) return allPaths;

  const childrenByPath = new Map<string, string[]>();
  for (const [childPath, parentPath] of parentByPath.entries()) {
    const siblings = childrenByPath.get(parentPath);
    if (siblings) {
      siblings.push(childPath);
    } else {
      childrenByPath.set(parentPath, [childPath]);
    }
  }

  const scoped = new Set<string>();
  const stack = [rootPath];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || scoped.has(next)) continue;
    scoped.add(next);
    for (const childPath of childrenByPath.get(next) ?? []) {
      stack.push(childPath);
    }
  }
  return scoped;
}

function compareNodes(
  a: TaskTreeNode,
  b: TaskTreeNode,
  sortMode: OutlineSortMode,
  subtreeLatestByPath: Map<string, number>
): number {
  if (sortMode === "priority") {
    const priorityCmp = getItemPriorityRank(a.item) - getItemPriorityRank(b.item);
    if (priorityCmp !== 0) return priorityCmp;
  }

  const latestA = subtreeLatestByPath.get(a.path) ?? 0;
  const latestB = subtreeLatestByPath.get(b.path) ?? 0;
  if (latestA !== latestB) {
    return latestB - latestA;
  }

  return a.path.localeCompare(b.path);
}

function computeSubtreeLatestStartMs(
  node: TaskTreeNode,
  latestTrackedStartForPath: (path: string) => number,
  memo: Map<string, number>,
  visiting: Set<string>
): number {
  const cached = memo.get(node.path);
  if (cached != null) return cached;
  if (visiting.has(node.path)) {
    const own = latestTrackedStartForPath(node.path);
    memo.set(node.path, own);
    return own;
  }

  visiting.add(node.path);
  let latest = latestTrackedStartForPath(node.path);
  for (const child of node.children) {
    const childLatest = computeSubtreeLatestStartMs(
      child,
      latestTrackedStartForPath,
      memo,
      visiting
    );
    if (childLatest > latest) {
      latest = childLatest;
    }
  }
  visiting.delete(node.path);
  memo.set(node.path, latest);
  return latest;
}

function extractParentCandidates(value: unknown): string[] {
  const candidates: string[] = [];

  const addCandidate = (raw: string): void => {
    let ref = raw.trim();
    if (!ref) return;

    if (ref.startsWith("[[") && ref.endsWith("]]")) {
      ref = ref.slice(2, -2).trim();
    }
    if (ref.includes("|")) {
      ref = ref.split("|")[0]?.trim() ?? "";
    }
    if (ref.includes("#")) {
      ref = ref.split("#")[0]?.trim() ?? "";
    }

    ref = ref.replace(/^\/+/, "").trim();
    if (!ref) return;
    candidates.push(ref);
  };

  const visit = (next: unknown): void => {
    if (Array.isArray(next)) {
      for (const entry of next) {
        visit(entry);
      }
      return;
    }
    if (next == null) return;
    addCandidate(String(next as string));
  };

  visit(value);
  return Array.from(new Set(candidates));
}
