import type { MetadataCache } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../models/types";
import type { TaskTreeData, TaskTreeBuildOptions, OutlineSortMode } from "../models/view-types";

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
    nodesByPath.set(item.file.path, {
      item,
      path: item.file.path,
      children: [],
      parentPath: null
    });
  }

  for (const node of nodesByPath.values()) {
    const parentPath = resolveParentPathFn(node.item.parentRaw, node.item.file.path);
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

function compareNodes(
  a: TaskTreeNode,
  b: TaskTreeNode,
  sortMode: OutlineSortMode,
  subtreeLatestByPath: Map<string, number>
): number {
  if (sortMode === "priority") {
    const priorityCmp = comparePriorityValues(
      readPriorityValue(a.item.frontmatter),
      readPriorityValue(b.item.frontmatter)
    );
    if (priorityCmp !== 0) return priorityCmp;
  }

  const latestA = subtreeLatestByPath.get(a.path) ?? 0;
  const latestB = subtreeLatestByPath.get(b.path) ?? 0;
  if (latestA !== latestB) {
    return latestB - latestA;
  }

  return a.item.file.path.localeCompare(b.item.file.path);
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

function readPriorityValue(frontmatter: TaskItem["frontmatter"]): unknown {
  if (!frontmatter) return null;
  return frontmatter.priority ?? frontmatter.prio ?? frontmatter.p;
}

function comparePriorityValues(a: unknown, b: unknown): number {
  const rankA = getPriorityRank(a);
  const rankB = getPriorityRank(b);
  return rankA - rankB;
}

function getPriorityRank(value: unknown): number {
  if (value == null) return 100;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }

  const normalized = String(value).trim().toLowerCase();
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
    addCandidate(String(next));
  };

  visit(value);
  return Array.from(new Set(candidates));
}
