import { SearchComponent, setTooltip } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../models/types";
import { isFileItem, isInlineItem } from "../models/types";
import {
  type OutlineSortMode,
  type TaskTreeData,
  type TaskTreeBuildOptions,
  type TreeRenderState,
  OUTLINE_RANGE_OPTIONS,
  OUTLINE_SORT_OPTIONS,
  MIN_TRACKED_SECONDS_PER_PERIOD,
  CLOSED_FILTER_QUERY
} from "../models/view-types";
import type LifeDashboardPlugin from "../plugin";
import type { OutlineTimeRange } from "../plugin";
import { buildTaskTree, resolveParentPath, buildParentPathMap, collectPathsWithParents, collectScopePaths } from "../services/task-tree-builder";
import { filterTasksByQuery, withClosedFilter } from "../services/outline-filter";
import {
  getItemPriorityBadge,
  getItemPriorityRank,
  handlePriorityHotkey
} from "../services/priority-utils";
import { createTreeToggleSpacer, setTreeToggleState } from "./tree-toggle";

export type ConcernTreePanelState = {
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  showInlineTasks: boolean;
  priorityOnly: boolean;
  showClosed: boolean;
  collapsedNodePaths: Set<string>;
};

export type ConcernTreePanelConfig = {
  plugin: LifeDashboardPlugin;
  container: HTMLElement;
  state: ConcernTreePanelState;
  initialPreviewScrollTop?: number;
  customWindow?: { startMs: number; endMs: number };
  hideControls?: {
    root?: boolean;
    range?: boolean;
    sort?: boolean;
    trackedOnly?: boolean;
    showParents?: boolean;
    filter?: boolean;
  };
  onChange: (visiblePaths: Set<string>, state: ConcernTreePanelState) => void;
  onHoverChange?: (hoveredPaths: Set<string> | null) => void;
};

type TreeNodeRenderContext = {
  state: TreeRenderState;
  limit: { count: number; max: number; truncated: boolean };
  rerender: () => void;
  subtreePathsByPath: Map<string, Set<string>>;
  inlineOnlyBranches: Set<string>;
};

export class ConcernTreePanel {
  private static readonly HOVER_HIGHLIGHT_DELAY_MS = 1000;
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
  private onHoverChange: ConcernTreePanelConfig["onHoverChange"];
  private customWindow: ConcernTreePanelConfig["customWindow"];
  private pendingHoverTimer: number | null = null;
  private hoveredConcernPath: string | null = null;
  private initialPreviewScrollTop = 0;

  constructor(config: ConcernTreePanelConfig) {
    this.plugin = config.plugin;
    this.container = config.container;
    this.state = { ...config.state, collapsedNodePaths: new Set(config.state.collapsedNodePaths) };
    this.initialPreviewScrollTop = Math.max(0, config.initialPreviewScrollTop ?? 0);
    this.hideControls = config.hideControls ?? {};
    this.customWindow = config.customWindow;
    this.onChange = config.onChange;
    this.onHoverChange = config.onHoverChange;
    this.initializePriorityHotkeys();
    this.render();
  }

  render(): void {
    const previousPreviewScrollTop = this.previewEl?.scrollTop ?? this.initialPreviewScrollTop;
    this.container.empty();

    const tasks = this.plugin.getTaskTreeItems();

    this.renderControls(tasks);

    const preview = this.container.createEl("div", { cls: "fmo-tree-panel-preview" });
    this.previewEl = preview;
    let pendingInitialScrollTop: number | null = previousPreviewScrollTop;

    const rerender = (): void => {
      const currentScrollTop = pendingInitialScrollTop ?? preview.scrollTop;
      pendingInitialScrollTop = null;
      this.clearPendingHoverTimer();
      this.hoveredConcernPath = null;
      this.emitHover(null);
      preview.empty();
      this.renderTreePreview(preview, tasks, rerender);
      preview.scrollTop = currentScrollTop;
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
    if (partial.showInlineTasks !== undefined) this.state.showInlineTasks = partial.showInlineTasks;
    if (partial.priorityOnly !== undefined) this.state.priorityOnly = partial.priorityOnly;
    if (partial.showClosed !== undefined) this.state.showClosed = partial.showClosed;
    this.render();
  }

  // ── Controls ──────────────────────────────────────────────────────────

  private renderControls(tasks: TaskItem[]): void {
    const controls = this.container.createEl("div", { cls: "fmo-tree-panel-controls" });
    const tasksByName = [...tasks].filter(isFileItem).sort((a, b) =>
      a.basename.localeCompare(b.basename, undefined, { sensitivity: "base" })
    );

    if (!this.hideControls.root) {
      const rootRow = controls.createEl("label", { cls: "fmo-tree-panel-root-row" });
      rootRow.createEl("span", { cls: "fmo-tree-panel-control-label", text: "Root" });
      const rootSelect = rootRow.createEl("select", { cls: "fmo-outline-sort-select" }) as HTMLSelectElement;
      rootSelect.createEl("option", { value: "", text: "All concerns" });
      for (const task of tasksByName) {
        rootSelect.createEl("option", {
          value: task.path,
          text: task.basename
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

    const showInlineRow = flagsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
    const showInlineInput = showInlineRow.createEl("input", {
      cls: "fmo-outline-tracked-only-input",
      attr: { type: "checkbox" }
    }) as HTMLInputElement;
    showInlineInput.checked = this.state.showInlineTasks;
    showInlineRow.createEl("span", { text: "Inline tasks" });
    showInlineInput.addEventListener("change", () => {
      this.state.showInlineTasks = showInlineInput.checked;
      this.rerenderPreview?.();
    });

    const priorityOnlyRow = flagsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
    const priorityOnlyInput = priorityOnlyRow.createEl("input", {
      cls: "fmo-outline-tracked-only-input",
      attr: { type: "checkbox" }
    }) as HTMLInputElement;
    priorityOnlyInput.checked = this.state.priorityOnly;
    priorityOnlyRow.createEl("span", { text: "Priority only" });
    priorityOnlyInput.addEventListener("change", () => {
      this.state.priorityOnly = priorityOnlyInput.checked;
      this.rerenderPreview?.();
    });

    const showClosedRow = flagsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
    const showClosedInput = showClosedRow.createEl("input", {
      cls: "fmo-outline-tracked-only-input",
      attr: { type: "checkbox" }
    }) as HTMLInputElement;
    showClosedInput.checked = this.state.showClosed;
    showClosedRow.createEl("span", { text: "Show closed" });
    setTooltip(showClosedRow, `When off: ${CLOSED_FILTER_QUERY}`);
    showClosedInput.addEventListener("change", () => {
      this.state.showClosed = showClosedInput.checked;
      this.rerenderPreview?.();
    });

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
      this.emitHover(null);
      return;
    }

    const ownSecondsByPath = this.getOwnSecondsByPath(tasks, this.state.range);
    const resolveParentPathFn = (parentRaw: unknown, sourcePath: string): string | null =>
      resolveParentPath(parentRaw, sourcePath, this.plugin.app.metadataCache);
    this.parentByPath = buildParentPathMap(tasks, resolveParentPathFn);
    const parentByPath = this.parentByPath;
    const scopePaths = collectScopePaths(tasks, parentByPath, this.state.rootPath);

    const scopedTasks = tasks.filter((task) => scopePaths.has(task.path));
    const filteredTasks = this.state.showInlineTasks
      ? scopedTasks
      : scopedTasks.filter((task) => !isInlineItem(task));
    const priorityFilteredTasks = this.state.priorityOnly
      ? filteredTasks.filter((task) => getItemPriorityRank(task) < 100)
      : filteredTasks;
    const closedFilter = this.state.showClosed
      ? this.state.query
      : withClosedFilter(this.state.query);
    const queryMatched = filterTasksByQuery(priorityFilteredTasks, closedFilter);
    const matched = this.state.trackedOnly
      ? queryMatched.filter(
          (task) => (ownSecondsByPath.get(task.path) ?? 0) >= MIN_TRACKED_SECONDS_PER_PERIOD
        )
      : queryMatched;

    if (matched.length === 0) {
      containerEl.createEl("div", {
        cls: "fmo-empty",
        text: "No concerns match this tree configuration."
      });
      this.visiblePaths = new Set();
      this.displayPathMap = new Map();
      this.emitHover(null);
      return;
    }

    const matchedPaths = new Set(matched.map((task) => task.path));
    const visiblePaths = this.state.showParents
      ? collectPathsWithParents(matchedPaths, parentByPath, scopePaths)
      : matchedPaths;
    const visibleTasks = tasks.filter((task) => visiblePaths.has(task.path));
    const latestTrackedStartForPath = this.createLatestTrackedStartResolver(this.state.range);
    const taskTree = buildTaskTree(visibleTasks, resolveParentPathFn, {
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
      this.emitHover(null);
      return;
    }

    const { branchPaths, inlineOnlyBranches } = this.collectBranchPaths(roots);
    if (branchPaths.size > 0) {
      for (const path of [...this.state.collapsedNodePaths]) {
        if (!branchPaths.has(path)) {
          this.state.collapsedNodePaths.delete(path);
        }
      }
    }

    this.visiblePaths = visiblePaths;

    this.displayPathMap = this.buildDisplayPathMap(visiblePaths, roots, inlineOnlyBranches);

    const top = containerEl.createEl("div", { cls: "fmo-tree-panel-preview-top" });
    const actions = top.createEl("div", { cls: "fmo-tree-panel-preview-actions" });
    const expandAllBtn = actions.createEl("button", {
      cls: "fmo-tree-panel-preview-btn",
      text: "Expand all",
      attr: { type: "button" }
    });
    expandAllBtn.addEventListener("click", () => {
      this.state.collapsedNodePaths = new Set(inlineOnlyBranches);
      rerender();
    });

    const collapseAllBtn = actions.createEl("button", {
      cls: "fmo-tree-panel-preview-btn",
      text: "Collapse all",
      attr: { type: "button" }
    });
    collapseAllBtn.disabled = branchPaths.size === 0;
    collapseAllBtn.addEventListener("click", () => {
      const paths = new Set(branchPaths);
      for (const path of inlineOnlyBranches) paths.delete(path);
      this.state.collapsedNodePaths = paths;
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
    const nodeCtx: TreeNodeRenderContext = {
      state: {
        cumulativeSeconds: taskTree.cumulativeSeconds,
        ownSeconds: taskTree.ownSeconds,
        matchedPaths
      },
      limit: { count: 0, max: this.plugin.settings.outlineMaxRows, truncated: false },
      rerender,
      subtreePathsByPath: this.buildSubtreePathMap(roots),
      inlineOnlyBranches,
    };
    for (const root of roots) {
      this.renderTreeNode(list, root, new Set(), 0, nodeCtx);
    }

    if (nodeCtx.limit.truncated) {
      containerEl.createEl("div", {
        cls: "fmo-tree-panel-truncated",
        text: `Preview truncated at ${nodeCtx.limit.max} rows.`
      });
    }
  }

  // ── Tree node rendering ───────────────────────────────────────────────

  private renderTreeNode(
    containerEl: HTMLElement,
    node: TaskTreeNode,
    ancestry: Set<string>,
    depth: number,
    ctx: TreeNodeRenderContext
  ): void {
    if (ctx.limit.truncated) return;
    if (ancestry.has(node.path)) return;

    if (ctx.limit.count >= ctx.limit.max) {
      ctx.limit.truncated = true;
      return;
    }
    ctx.limit.count += 1;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.path);

    const isInline = isInlineItem(node.item);
    const isParentOnly = !ctx.state.matchedPaths.has(node.path);
    const li = containerEl.createEl("li", { cls: "fmo-tree-item fmo-tree-panel-tree-item" });
    const rowCls = [
      "fmo-tree-row",
      "fmo-tree-panel-tree-row",
      isParentOnly ? "fmo-tree-row-parent" : ""
    ].filter(Boolean).join(" ");
    const row = li.createEl("div", { cls: rowCls });
    row.dataset.concernPath = node.path;
    const hoveredPaths = ctx.subtreePathsByPath.get(node.path) ?? new Set([node.path]);
    row.addEventListener("mouseenter", () => {
      this.hoveredConcernPath = node.path;
      this.container.focus({ preventScroll: true });
      this.scheduleHover(hoveredPaths);
    });
    row.addEventListener("mouseleave", (evt) => this.handleRowMouseLeave(evt));
    row.style.paddingInlineStart = `${Math.min(12, depth) * 6}px`;
    const hasChildren = node.children.length > 0;
    const onlyInlineChildren = ctx.inlineOnlyBranches.has(node.path);
    if (hasChildren) {
      const isCollapsed = onlyInlineChildren
        ? !this.state.collapsedNodePaths.has(node.path)
        : this.state.collapsedNodePaths.has(node.path);
      const toggle = row.createEl("button", {
        cls: "fmo-tree-toggle",
        attr: {
          type: "button"
        }
      }) as HTMLButtonElement;
      setTreeToggleState(toggle, !isCollapsed, node.item.basename);
      toggle.addEventListener("click", () => {
        if (this.state.collapsedNodePaths.has(node.path)) {
          this.state.collapsedNodePaths.delete(node.path);
        } else {
          this.state.collapsedNodePaths.add(node.path);
        }
        ctx.rerender();
      });
    } else {
      createTreeToggleSpacer(row);
    }

    const linkCls = [
      "fmo-note-link",
      isParentOnly ? "fmo-note-link-parent" : "",
      isInline ? "fmo-note-link-inline" : ""
    ].filter(Boolean).join(" ");
    const link = row.createEl("a", {
      cls: linkCls,
      text: node.item.basename,
      href: "#"
    });
    link.addEventListener("click", (evt) => {
      evt.preventDefault();
      const inlineItem = isInlineItem(node.item) ? node.item : null;
      void this.plugin.openFile(inlineItem ? inlineItem.parentPath : node.item.path, inlineItem?.line);
    });

    if (onlyInlineChildren) {
      row.createEl("span", {
        cls: "fmo-inline-count",
        text: `(${node.children.length} inline${node.children.length === 1 ? "" : "s"})`
      });
    }

    const priorityBadge = getItemPriorityBadge(node.item);
    if (priorityBadge) {
      row.createEl("span", {
        cls: "fmo-priority-badge",
        text: priorityBadge,
        attr: { title: `Priority: ${priorityBadge}` }
      });
    }

    if (!isInline) {
      const total = ctx.state.cumulativeSeconds.get(node.path) ?? 0;
      const own = ctx.state.ownSeconds.get(node.path) ?? 0;
      row.createEl("span", {
        cls: "fmo-time-badge",
        text: this.plugin.timeData.formatShortDuration(total),
        attr: {
          title: `Own: ${this.plugin.timeData.formatShortDuration(own)} | Total (with children): ${this.plugin.timeData.formatShortDuration(total)}`
        }
      });
    }

    const effectivelyCollapsed = onlyInlineChildren
      ? !this.state.collapsedNodePaths.has(node.path)
      : this.state.collapsedNodePaths.has(node.path);
    if (!hasChildren || effectivelyCollapsed) return;

    const children = li.createEl("ul", { cls: "fmo-tree fmo-tree-panel-tree-children" });
    for (const child of node.children) {
      this.renderTreeNode(children, child, nextAncestry, depth + 1, ctx);
    }
  }

  // ── Tree data methods ─────────────────────────────────────────────────

  private getOwnSecondsByPath(tasks: TaskItem[], range: OutlineTimeRange): Map<string, number> {
    const ownSecondsByPath = new Map<string, number>();
    for (const task of tasks) {
      if (isInlineItem(task)) {
        ownSecondsByPath.set(task.path, 0);
        continue;
      }
      const seconds = this.customWindow
        ? this.plugin.timeData.getTrackedSecondsForWindow(task.path, this.customWindow)
        : this.plugin.timeData.getTrackedSecondsForRange(task.path, range);
      ownSecondsByPath.set(task.path, seconds);
    }
    return ownSecondsByPath;
  }

  private createLatestTrackedStartResolver(range: OutlineTimeRange): (path: string) => number {
    const cache = new Map<string, number>();
    return (path: string): number => {
      const existing = cache.get(path);
      if (existing != null) return existing;

      const latest = this.customWindow
        ? this.plugin.timeData.getLatestTrackedStartMsForWindow(path, this.customWindow)
        : this.plugin.timeData.getLatestTrackedStartMsForRange(path, range);
      cache.set(path, latest);
      return latest;
    };
  }


  private selectRoots(taskTree: TaskTreeData, rootPath: string): TaskTreeNode[] {
    if (!rootPath) return taskTree.roots;
    const root = taskTree.nodesByPath.get(rootPath);
    return root ? [root] : taskTree.roots;
  }

  private collectBranchPaths(
    roots: TaskTreeNode[]
  ): { branchPaths: Set<string>; inlineOnlyBranches: Set<string> } {
    const branchPaths = new Set<string>();
    const inlineOnlyBranches = new Set<string>();
    const visit = (node: TaskTreeNode, ancestry: Set<string>): void => {
      if (ancestry.has(node.path)) return;
      if (node.children.length > 0) {
        branchPaths.add(node.path);
        if (node.children.every((c) => isInlineItem(c.item))) {
          inlineOnlyBranches.add(node.path);
        }
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
    return { branchPaths, inlineOnlyBranches };
  }

  private computeDisplayedPaths(
    roots: TaskTreeNode[],
    inlineOnlyBranches: Set<string>
  ): Set<string> {
    const displayed = new Set<string>();
    const visit = (node: TaskTreeNode, ancestry: Set<string>): void => {
      if (ancestry.has(node.path)) return;
      displayed.add(node.path);
      const isCollapsed = inlineOnlyBranches.has(node.path)
        ? !this.state.collapsedNodePaths.has(node.path)
        : this.state.collapsedNodePaths.has(node.path);
      if (isCollapsed) return;
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
    roots: TaskTreeNode[],
    inlineOnlyBranches: Set<string>
  ): Map<string, string> {
    const displayedPaths = this.computeDisplayedPaths(roots, inlineOnlyBranches);
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

  private buildSubtreePathMap(roots: TaskTreeNode[]): Map<string, Set<string>> {
    const subtreePathsByPath = new Map<string, Set<string>>();
    const walk = (node: TaskTreeNode, ancestry: Set<string>): Set<string> => {
      if (ancestry.has(node.path)) return new Set();

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(node.path);

      const paths = new Set<string>([node.path]);
      for (const child of node.children) {
        const childPaths = walk(child, nextAncestry);
        for (const path of childPaths) {
          paths.add(path);
        }
      }
      subtreePathsByPath.set(node.path, paths);
      return paths;
    };

    for (const root of roots) {
      walk(root, new Set());
    }

    return subtreePathsByPath;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private fireChange(): void {
    this.onChange(this.getVisiblePaths(), this.getState());
  }

  private emitHover(paths: Set<string> | null): void {
    if (!this.onHoverChange) return;
    this.onHoverChange(paths ? new Set(paths) : null);
  }

  private scheduleHover(paths: Set<string>): void {
    this.clearPendingHoverTimer();
    this.pendingHoverTimer = window.setTimeout(() => {
      this.pendingHoverTimer = null;
      this.emitHover(paths);
    }, ConcernTreePanel.HOVER_HIGHLIGHT_DELAY_MS);
  }

  private handleRowMouseLeave(evt: MouseEvent): void {
    const row = evt.currentTarget instanceof HTMLElement ? evt.currentTarget : null;
    if (row?.dataset.concernPath && this.hoveredConcernPath === row.dataset.concernPath) {
      this.hoveredConcernPath = null;
    }
    const next = evt.relatedTarget instanceof Element ? evt.relatedTarget : null;
    if (next?.closest(".fmo-tree-panel-tree-row")) {
      return;
    }
    this.clearPendingHoverTimer();
    this.emitHover(null);
  }

  private clearPendingHoverTimer(): void {
    if (this.pendingHoverTimer == null) return;
    window.clearTimeout(this.pendingHoverTimer);
    this.pendingHoverTimer = null;
  }

  private initializePriorityHotkeys(): void {
    this.container.tabIndex = -1;
    this.container.addEventListener("keydown", (event) => {
      handlePriorityHotkey(event, this.hoveredConcernPath, {
        onReparent: (path) => this.plugin.reparentConcernInteractive(path),
        onPriorityDigit: (path, digit) => void this.applyHoveredPriorityValue(path, digit),
        onPriorityClear: (path) => void this.applyHoveredPriorityClear(path),
      });
    });
  }

  private async applyHoveredPriorityValue(path: string, digit: string): Promise<void> {
    const changed = await this.plugin.setPriorityForPath(path, digit);
    if (!changed) return;
    this.rerenderPreview?.();
  }

  private async applyHoveredPriorityClear(path: string): Promise<void> {
    const changed = await this.plugin.clearPriorityForPath(path);
    if (!changed) return;
    this.rerenderPreview?.();
  }
}
