import { SearchComponent, setTooltip, prepareSimpleSearch } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../models/types";
import type LifeDashboardPlugin from "../plugin";
import type { OutlineTimeRange } from "../plugin";
import {
  type OutlineFilterToken,
  type OutlineSortMode,
  OUTLINE_RANGE_OPTIONS,
  OUTLINE_SORT_OPTIONS,
  MIN_TRACKED_SECONDS_PER_PERIOD
} from "./life-dashboard-view";

type TaskTreeData = {
  roots: TaskTreeNode[];
  cumulativeSeconds: Map<string, number>;
  ownSeconds: Map<string, number>;
  nodesByPath: Map<string, TaskTreeNode>;
};

type TaskTreeBuildOptions = {
  ownSecondsForPath?: (path: string) => number;
  sortMode?: OutlineSortMode;
  latestTrackedStartForPath?: (path: string) => number;
};

type TreeRenderState = {
  cumulativeSeconds: Map<string, number>;
  ownSeconds: Map<string, number>;
  matchedPaths: Set<string>;
};

export type ConcernTreePanelState = {
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  collapsedNodePaths: Set<string>;
};

export type ConcernTreePanelConfig = {
  plugin: LifeDashboardPlugin;
  container: HTMLElement;
  state: ConcernTreePanelState;
  hideControls?: {
    root?: boolean;
    range?: boolean;
    sort?: boolean;
    trackedOnly?: boolean;
    showParents?: boolean;
    filter?: boolean;
  };
  onChange: (visiblePaths: Set<string>, state: ConcernTreePanelState) => void;
};

export class ConcernTreePanel {
  private plugin: LifeDashboardPlugin;
  private container: HTMLElement;
  private state: ConcernTreePanelState;
  private hideControls: NonNullable<ConcernTreePanelConfig["hideControls"]>;
  private onChange: ConcernTreePanelConfig["onChange"];
  private visiblePaths: Set<string> = new Set();
  private parentByPath: Map<string, string> = new Map();
  private displayPathMap: Map<string, string> = new Map();
  private previewEl: HTMLElement | null = null;
  private rerenderPreview: (() => void) | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(config: ConcernTreePanelConfig) {
    this.plugin = config.plugin;
    this.container = config.container;
    this.state = { ...config.state, collapsedNodePaths: new Set(config.state.collapsedNodePaths) };
    this.hideControls = config.hideControls ?? {};
    this.onChange = config.onChange;
    this.render();
  }

  render(): void {
    this.container.empty();

    const tasks = this.plugin.getTaskTreeItems();

    this.renderControls(tasks);

    const preview = this.container.createEl("div", { cls: "fmo-tree-panel-preview" });
    this.previewEl = preview;

    const rerender = (): void => {
      preview.empty();
      this.renderTreePreview(preview, tasks, rerender);
      this.fireChange();
    };
    this.rerenderPreview = rerender;

    rerender();
  }

  getVisiblePaths(): Set<string> {
    return new Set(this.visiblePaths);
  }

  getDisplayPathMap(): Map<string, string> {
    return new Map(this.displayPathMap);
  }

  setStatusText(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  getState(): ConcernTreePanelState {
    return {
      ...this.state,
      collapsedNodePaths: new Set(this.state.collapsedNodePaths)
    };
  }

  setState(partial: Partial<ConcernTreePanelState>): void {
    if (partial.collapsedNodePaths !== undefined) {
      this.state.collapsedNodePaths = new Set(partial.collapsedNodePaths);
    }
    if (partial.rootPath !== undefined) this.state.rootPath = partial.rootPath;
    if (partial.query !== undefined) this.state.query = partial.query;
    if (partial.sortMode !== undefined) this.state.sortMode = partial.sortMode;
    if (partial.range !== undefined) this.state.range = partial.range;
    if (partial.trackedOnly !== undefined) this.state.trackedOnly = partial.trackedOnly;
    if (partial.showParents !== undefined) this.state.showParents = partial.showParents;
    this.render();
  }

  // ── Controls ──────────────────────────────────────────────────────────

  private renderControls(tasks: TaskItem[]): void {
    const controls = this.container.createEl("div", { cls: "fmo-tree-panel-controls" });
    const tasksByName = [...tasks].sort((a, b) =>
      a.file.basename.localeCompare(b.file.basename, undefined, { sensitivity: "base" })
    );

    if (!this.hideControls.root) {
      const rootRow = controls.createEl("label", { cls: "fmo-tree-panel-root-row" });
      rootRow.createEl("span", { cls: "fmo-tree-panel-control-label", text: "Root" });
      const rootSelect = rootRow.createEl("select", { cls: "fmo-outline-sort-select" }) as HTMLSelectElement;
      rootSelect.createEl("option", { value: "", text: "All concerns" });
      for (const task of tasksByName) {
        rootSelect.createEl("option", {
          value: task.file.path,
          text: task.file.basename
        });
      }
      rootSelect.value = this.state.rootPath;
      rootSelect.addEventListener("change", () => {
        this.state.rootPath = rootSelect.value;
        this.rerenderPreview?.();
      });
    }

    const optionsGrid = controls.createEl("div", { cls: "fmo-tree-panel-options-grid" });

    if (!this.hideControls.range) {
      const rangeRow = optionsGrid.createEl("label", { cls: "fmo-tree-panel-option" });
      rangeRow.createEl("span", { cls: "fmo-tree-panel-control-label", text: "Range" });
      const rangeSelect = rangeRow.createEl("select", {
        cls: "fmo-outline-sort-select"
      }) as HTMLSelectElement;
      for (const option of OUTLINE_RANGE_OPTIONS) {
        rangeSelect.createEl("option", { value: option.value, text: option.label });
      }
      rangeSelect.value = this.state.range;
      rangeSelect.addEventListener("change", () => {
        this.state.range = rangeSelect.value as OutlineTimeRange;
        this.rerenderPreview?.();
      });
    }

    if (!this.hideControls.sort) {
      const sortRow = optionsGrid.createEl("label", { cls: "fmo-tree-panel-option" });
      sortRow.createEl("span", { cls: "fmo-tree-panel-control-label", text: "Sort" });
      const sortSelect = sortRow.createEl("select", {
        cls: "fmo-outline-sort-select"
      }) as HTMLSelectElement;
      for (const option of OUTLINE_SORT_OPTIONS) {
        sortSelect.createEl("option", { value: option.value, text: option.label });
      }
      sortSelect.value = this.state.sortMode;
      sortSelect.addEventListener("change", () => {
        this.state.sortMode = sortSelect.value as OutlineSortMode;
        this.rerenderPreview?.();
      });
    }

    const flagsRow = controls.createEl("div", { cls: "fmo-tree-panel-flags" });

    if (!this.hideControls.trackedOnly) {
      const trackedOnlyRow = flagsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
      const trackedOnlyInput = trackedOnlyRow.createEl("input", {
        cls: "fmo-outline-tracked-only-input",
        attr: { type: "checkbox" }
      }) as HTMLInputElement;
      trackedOnlyInput.checked = this.state.trackedOnly;
      trackedOnlyRow.createEl("span", { text: "Tracked only" });
      trackedOnlyInput.addEventListener("change", () => {
        this.state.trackedOnly = trackedOnlyInput.checked;
        this.rerenderPreview?.();
      });
    }

    if (!this.hideControls.showParents) {
      const showParentsRow = flagsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
      const showParentsInput = showParentsRow.createEl("input", {
        cls: "fmo-outline-tracked-only-input",
        attr: { type: "checkbox" }
      }) as HTMLInputElement;
      showParentsInput.checked = this.state.showParents;
      showParentsRow.createEl("span", { text: "Parents" });
      showParentsInput.addEventListener("change", () => {
        this.state.showParents = showParentsInput.checked;
        this.rerenderPreview?.();
      });
    }

    if (!this.hideControls.filter) {
      const filterRow = controls.createEl("div", { cls: "fmo-tree-panel-filter" });
      const filterSearch = new SearchComponent(filterRow);
      filterSearch.setPlaceholder("Filter (path:, file:, prop:key=value)");
      filterSearch.setValue(this.state.query);
      filterSearch.onChange((query) => {
        this.state.query = query;
        this.rerenderPreview?.();
      });
    }
  }

  // ── Tree preview ──────────────────────────────────────────────────────

  private renderTreePreview(
    containerEl: HTMLElement,
    tasks: TaskItem[],
    rerender: () => void
  ): void {
    if (tasks.length === 0) {
      containerEl.createEl("div", {
        cls: "fmo-empty",
        text: "No concerns match your plugin filter settings."
      });
      this.visiblePaths = new Set();
      this.displayPathMap = new Map();
      return;
    }

    const ownSecondsByPath = this.getOwnSecondsByPath(tasks, this.state.range);
    this.parentByPath = this.buildParentPathMap(tasks);
    const parentByPath = this.parentByPath;
    const scopePaths = this.collectScopePaths(tasks, parentByPath, this.state.rootPath);

    const scopedTasks = tasks.filter((task) => scopePaths.has(task.file.path));
    const queryMatched = this.filterTasks(scopedTasks, this.state.query);
    const matched = this.state.trackedOnly
      ? queryMatched.filter(
          (task) => (ownSecondsByPath.get(task.file.path) ?? 0) >= MIN_TRACKED_SECONDS_PER_PERIOD
        )
      : queryMatched;

    if (matched.length === 0) {
      containerEl.createEl("div", {
        cls: "fmo-empty",
        text: "No concerns match this tree configuration."
      });
      this.visiblePaths = new Set();
      this.displayPathMap = new Map();
      return;
    }

    const matchedPaths = new Set(matched.map((task) => task.file.path));
    const visiblePaths = this.state.showParents
      ? this.collectPathsWithParents(matchedPaths, parentByPath, scopePaths)
      : matchedPaths;
    const visibleTasks = tasks.filter((task) => visiblePaths.has(task.file.path));
    const latestTrackedStartForPath = this.createLatestTrackedStartResolver(this.state.range);
    const taskTree = this.buildTaskTree(visibleTasks, {
      ownSecondsForPath: (path) => ownSecondsByPath.get(path) ?? 0,
      sortMode: this.state.sortMode,
      latestTrackedStartForPath
    });

    const roots = this.selectRoots(taskTree, this.state.rootPath);
    if (roots.length === 0) {
      containerEl.createEl("div", {
        cls: "fmo-empty",
        text: "Selected root has no visible descendants with current filters."
      });
      this.visiblePaths = new Set();
      this.displayPathMap = new Map();
      return;
    }

    const branchPaths = this.collectBranchPaths(roots);
    if (branchPaths.size > 0) {
      for (const path of [...this.state.collapsedNodePaths]) {
        if (!branchPaths.has(path)) {
          this.state.collapsedNodePaths.delete(path);
        }
      }
    }

    this.visiblePaths = visiblePaths;

    this.displayPathMap = this.buildDisplayPathMap(visiblePaths, roots);

    const top = containerEl.createEl("div", { cls: "fmo-tree-panel-preview-top" });
    const actions = top.createEl("div", { cls: "fmo-tree-panel-preview-actions" });
    const expandAllBtn = actions.createEl("button", {
      cls: "fmo-tree-panel-preview-btn",
      text: "Expand all",
      attr: { type: "button" }
    });
    expandAllBtn.disabled = this.state.collapsedNodePaths.size === 0;
    expandAllBtn.addEventListener("click", () => {
      this.state.collapsedNodePaths.clear();
      rerender();
    });

    const collapseAllBtn = actions.createEl("button", {
      cls: "fmo-tree-panel-preview-btn",
      text: "Collapse all",
      attr: { type: "button" }
    });
    collapseAllBtn.disabled = branchPaths.size === 0;
    collapseAllBtn.addEventListener("click", () => {
      this.state.collapsedNodePaths = new Set(branchPaths);
      rerender();
    });

    const meta = top.createEl("div", { cls: "fmo-tree-panel-preview-meta" });
    meta.createEl("span", {
      text: `${matchedPaths.size} / ${visiblePaths.size}`
    });
    if (!this.hideControls.range) {
      meta.createEl("span", {
        text: `range: ${OUTLINE_RANGE_OPTIONS.find((option) => option.value === this.state.range)?.label ?? this.state.range}`
      });
    }
    this.statusEl = meta.createEl("span");

    const list = containerEl.createEl("ul", { cls: "fmo-tree fmo-tree-panel-tree" });
    const renderState: TreeRenderState = {
      cumulativeSeconds: taskTree.cumulativeSeconds,
      ownSeconds: taskTree.ownSeconds,
      matchedPaths
    };
    const limitState = { count: 0, truncated: false };
    for (const root of roots) {
      this.renderTreeNode(list, root, renderState, new Set(), 0, limitState, rerender);
    }

    if (limitState.truncated) {
      containerEl.createEl("div", {
        cls: "fmo-tree-panel-truncated",
        text: "Preview truncated at 160 rows."
      });
    }
  }

  // ── Tree node rendering ───────────────────────────────────────────────

  private renderTreeNode(
    containerEl: HTMLElement,
    node: TaskTreeNode,
    state: TreeRenderState,
    ancestry: Set<string>,
    depth: number,
    limit: { count: number; truncated: boolean },
    rerender: () => void
  ): void {
    if (limit.truncated) return;
    if (ancestry.has(node.path)) return;

    if (limit.count >= 160) {
      limit.truncated = true;
      return;
    }
    limit.count += 1;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.path);

    const isParentOnly = !state.matchedPaths.has(node.path);
    const li = containerEl.createEl("li", { cls: "fmo-tree-item fmo-tree-panel-tree-item" });
    const row = li.createEl("div", {
      cls: isParentOnly
        ? "fmo-tree-row fmo-tree-row-parent fmo-tree-panel-tree-row"
        : "fmo-tree-row fmo-tree-panel-tree-row"
    });
    row.style.paddingInlineStart = `${Math.min(12, depth) * 11}px`;
    const hasChildren = node.children.length > 0;
    if (hasChildren) {
      const isCollapsed = this.state.collapsedNodePaths.has(node.path);
      const toggle = row.createEl("button", {
        cls: "fmo-tree-panel-node-toggle",
        text: isCollapsed ? "○" : "●",
        attr: {
          type: "button",
          "aria-expanded": String(!isCollapsed),
          "aria-label": `${isCollapsed ? "Expand" : "Collapse"} ${node.item.file.basename}`
        }
      });
      toggle.addEventListener("click", () => {
        if (this.state.collapsedNodePaths.has(node.path)) {
          this.state.collapsedNodePaths.delete(node.path);
        } else {
          this.state.collapsedNodePaths.add(node.path);
        }
        rerender();
      });
    } else {
      row.createEl("span", {
        cls: "fmo-tree-panel-node-marker",
        text: "•"
      });
    }

    const link = row.createEl("a", {
      cls: isParentOnly ? "fmo-note-link fmo-note-link-parent" : "fmo-note-link",
      text: node.item.file.basename,
      href: "#"
    });
    link.addEventListener("click", (evt) => {
      evt.preventDefault();
      void this.plugin.openFile(node.item.file.path);
    });

    const total = state.cumulativeSeconds.get(node.path) ?? 0;
    const own = state.ownSeconds.get(node.path) ?? 0;
    row.createEl("span", {
      cls: "fmo-time-badge",
      text: this.plugin.formatShortDuration(total),
      attr: {
        title: `Own: ${this.plugin.formatShortDuration(own)} | Total (with children): ${this.plugin.formatShortDuration(total)}`
      }
    });

    if (!hasChildren || this.state.collapsedNodePaths.has(node.path)) return;

    const children = li.createEl("ul", { cls: "fmo-tree fmo-tree-panel-tree-children" });
    for (const child of node.children) {
      this.renderTreeNode(children, child, state, nextAncestry, depth + 1, limit, rerender);
    }
  }

  // ── Tree data methods ─────────────────────────────────────────────────

  private getOwnSecondsByPath(tasks: TaskItem[], range: OutlineTimeRange): Map<string, number> {
    const ownSecondsByPath = new Map<string, number>();
    for (const task of tasks) {
      ownSecondsByPath.set(
        task.file.path,
        this.plugin.getTrackedSecondsForRange(task.file.path, range)
      );
    }
    return ownSecondsByPath;
  }

  private createLatestTrackedStartResolver(range: OutlineTimeRange): (path: string) => number {
    const cache = new Map<string, number>();
    return (path: string): number => {
      const existing = cache.get(path);
      if (existing != null) return existing;

      const latest = this.plugin.getLatestTrackedStartMsForRange(path, range);
      cache.set(path, latest);
      return latest;
    };
  }

  private buildParentPathMap(tasks: TaskItem[]): Map<string, string> {
    const allPaths = new Set(tasks.map((task) => task.file.path));
    const parentByPath = new Map<string, string>();
    for (const task of tasks) {
      const parentPath = this.resolveParentPath(task.parentRaw, task.file.path);
      if (!parentPath || !allPaths.has(parentPath) || parentPath === task.file.path) continue;
      parentByPath.set(task.file.path, parentPath);
    }
    return parentByPath;
  }

  private collectScopePaths(
    tasks: TaskItem[],
    parentByPath: Map<string, string>,
    rootPath: string
  ): Set<string> {
    const allPaths = new Set(tasks.map((task) => task.file.path));
    if (!rootPath || !allPaths.has(rootPath)) {
      return allPaths;
    }

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

  private collectPathsWithParents(
    matchedPaths: Set<string>,
    parentByPath: Map<string, string>,
    scopedPaths: Set<string>
  ): Set<string> {
    const output = new Set<string>(matchedPaths);
    for (const path of matchedPaths) {
      let cursor = parentByPath.get(path);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor) && scopedPaths.has(cursor)) {
        seen.add(cursor);
        output.add(cursor);
        cursor = parentByPath.get(cursor);
      }
    }
    return output;
  }

  private selectRoots(taskTree: TaskTreeData, rootPath: string): TaskTreeNode[] {
    if (!rootPath) return taskTree.roots;
    const root = taskTree.nodesByPath.get(rootPath);
    return root ? [root] : taskTree.roots;
  }

  private collectBranchPaths(roots: TaskTreeNode[]): Set<string> {
    const branchPaths = new Set<string>();
    const visit = (node: TaskTreeNode, ancestry: Set<string>): void => {
      if (ancestry.has(node.path)) return;
      if (node.children.length > 0) {
        branchPaths.add(node.path);
      }

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(node.path);
      for (const child of node.children) {
        visit(child, nextAncestry);
      }
    };

    for (const root of roots) {
      visit(root, new Set());
    }

    return branchPaths;
  }

  private computeDisplayedPaths(roots: TaskTreeNode[]): Set<string> {
    const displayed = new Set<string>();
    const visit = (node: TaskTreeNode, ancestry: Set<string>): void => {
      if (ancestry.has(node.path)) return;
      displayed.add(node.path);
      if (this.state.collapsedNodePaths.has(node.path)) return;
      const nextAncestry = new Set(ancestry);
      nextAncestry.add(node.path);
      for (const child of node.children) {
        visit(child, nextAncestry);
      }
    };
    for (const root of roots) {
      visit(root, new Set());
    }
    return displayed;
  }

  private buildDisplayPathMap(
    visiblePaths: Set<string>,
    roots: TaskTreeNode[]
  ): Map<string, string> {
    const displayedPaths = this.computeDisplayedPaths(roots);
    const map = new Map<string, string>();
    for (const path of visiblePaths) {
      if (displayedPaths.has(path)) {
        map.set(path, path);
        continue;
      }
      let cursor = this.parentByPath.get(path);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (displayedPaths.has(cursor)) {
          map.set(path, cursor);
          break;
        }
        seen.add(cursor);
        cursor = this.parentByPath.get(cursor);
      }
    }
    return map;
  }

  // ── Tree building (ported from base class) ────────────────────────────

  private buildTaskTree(tasks: TaskItem[], options: TaskTreeBuildOptions = {}): TaskTreeData {
    const resolveOwnSeconds =
      options.ownSecondsForPath ?? ((path: string) => this.plugin.getTrackedSeconds(path));
    const sortMode = options.sortMode ?? "recent";
    const resolveLatestTrackedStart =
      options.latestTrackedStartForPath ??
      ((path: string) => this.plugin.getLatestTrackedStartMsForRange(path, "all"));
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
      const parentPath = this.resolveParentPath(node.item.parentRaw, node.item.file.path);
      if (!parentPath || parentPath === node.path || !nodesByPath.has(parentPath)) continue;
      node.parentPath = parentPath;
      nodesByPath.get(parentPath)?.children.push(node);
    }

    const roots = Array.from(nodesByPath.values()).filter((node) => !node.parentPath);
    const subtreeLatestByPath = new Map<string, number>();
    const visiting = new Set<string>();
    for (const root of roots) {
      this.computeSubtreeLatestStartMs(root, resolveLatestTrackedStart, subtreeLatestByPath, visiting);
    }

    const sortNodes = (nodes: TaskTreeNode[]): void => {
      nodes.sort((a, b) => this.compareNodes(a, b, sortMode, subtreeLatestByPath));
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

  private resolveParentPath(parentRaw: unknown, sourcePath: string): string | null {
    for (const candidate of this.extractParentCandidates(parentRaw)) {
      const file = this.plugin.app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
      if (file) return file.path;
    }
    return null;
  }

  private extractParentCandidates(value: unknown): string[] {
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

  private computeSubtreeLatestStartMs(
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
      const childLatest = this.computeSubtreeLatestStartMs(
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

  private compareNodes(
    a: TaskTreeNode,
    b: TaskTreeNode,
    sortMode: OutlineSortMode,
    subtreeLatestByPath: Map<string, number>
  ): number {
    if (sortMode === "priority") {
      const priorityCmp = this.comparePriorityValues(
        this.readPriorityValue(a.item.frontmatter),
        this.readPriorityValue(b.item.frontmatter)
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

  private readPriorityValue(frontmatter: TaskItem["frontmatter"]): unknown {
    if (!frontmatter) return null;
    return frontmatter.priority ?? frontmatter.prio ?? frontmatter.p;
  }

  private comparePriorityValues(a: unknown, b: unknown): number {
    const rankA = this.getPriorityRank(a);
    const rankB = this.getPriorityRank(b);
    return rankA - rankB;
  }

  private getPriorityRank(value: unknown): number {
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

  // ── Filter methods (ported from base class) ───────────────────────────

  private filterTasks(tasks: TaskItem[], query: string): TaskItem[] {
    return this.filterTasksByQuery(tasks, query);
  }

  private filterTasksByQuery(tasks: TaskItem[], query: string): TaskItem[] {
    const tokens = this.parseFilterTokens(query);
    if (tokens.length === 0) return tasks;
    return tasks.filter((task) => this.taskMatchesFilter(task, tokens));
  }

  private parseFilterTokens(query: string): OutlineFilterToken[] {
    const out: OutlineFilterToken[] = [];
    const pattern = /"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(query)) !== null) {
      const raw = (match[1] ?? match[2] ?? "").trim();
      if (!raw) continue;

      let token = raw;
      let negated = false;
      if (token.startsWith("-") && token.length > 1) {
        negated = true;
        token = token.slice(1);
      }

      const propertyQualifier = /^(?:prop|fm):([^=:\s]+)(?:=(.+))?$/i.exec(token);
      if (propertyQualifier) {
        const prop = propertyQualifier[1]?.trim();
        const rawValue = propertyQualifier[2]?.trim();
        if (!prop) continue;

        out.push({
          key: "prop",
          prop,
          value: rawValue ? rawValue.replace(/^['"]|['"]$/g, "") : null,
          negated
        });
        continue;
      }

      const qualifier = /^(path|file):(.*)$/i.exec(token);
      const key = (qualifier?.[1]?.toLowerCase() as "path" | "file" | undefined) ?? "any";
      const value = (qualifier ? qualifier[2] : token).trim();
      if (!value) continue;

      out.push({ key, value, negated });
    }

    return out;
  }

  private taskMatchesFilter(task: TaskItem, tokens: OutlineFilterToken[]): boolean {
    const pathText = task.file.path.toLowerCase();
    const fileText = `${task.file.basename} ${task.file.name}`.toLowerCase();
    const anyText = `${task.file.basename} ${task.file.path}`.toLowerCase();

    for (const token of tokens) {
      if (token.key === "prop") {
        const matches = this.matchesFrontmatterFilter(task.frontmatter, token.prop, token.value);
        if (token.negated ? matches : !matches) {
          return false;
        }
        continue;
      }

      const matcher = prepareSimpleSearch(token.value.toLowerCase());
      const target = token.key === "path" ? pathText : token.key === "file" ? fileText : anyText;
      const matches = matcher(target) !== null;
      if (token.negated ? matches : !matches) {
        return false;
      }
    }

    return true;
  }

  private matchesFrontmatterFilter(
    frontmatter: TaskItem["frontmatter"],
    key: string,
    expectedValue: string | null
  ): boolean {
    if (!frontmatter || !(key in frontmatter)) {
      return false;
    }

    if (expectedValue == null) {
      return true;
    }

    const expected = expectedValue.toLowerCase();
    const values = this.flattenFrontmatterValues(frontmatter[key]);
    return values.some((value) => value.toLowerCase() === expected);
  }

  private flattenFrontmatterValues(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => this.flattenFrontmatterValues(entry));
    }

    if (value == null) {
      return [""];
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [String(value).trim()];
    }

    try {
      return [JSON.stringify(value)];
    } catch {
      return [String(value)];
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private fireChange(): void {
    this.onChange(this.getVisiblePaths(), this.getState());
  }
}
