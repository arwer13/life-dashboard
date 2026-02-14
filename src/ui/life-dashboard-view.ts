import {
  ItemView,
  Modal,
  SearchComponent,
  TFile,
  prepareSimpleSearch,
  setTooltip,
  type WorkspaceLeaf
} from "obsidian";
import { DISPLAY_VERSION } from "../version";
import type { TaskTreeNode, TaskItem, TimeLogEntry } from "../models/types";
import { TaskSelectModal } from "./task-select-modal";
import type LifeDashboardPlugin from "../plugin";
import type { OutlineTimeRange } from "../plugin";
import { ConcernTreePanel } from "./concern-tree-panel";

export const VIEW_TYPE_LIFE_DASHBOARD_TIMER = "life-dashboard-timer-view";
export const VIEW_TYPE_LIFE_DASHBOARD_OUTLINE = "life-dashboard-outline-view";
export const VIEW_TYPE_LIFE_DASHBOARD_CANVAS = "life-dashboard-canvas-view";
export const VIEW_TYPE_LIFE_DASHBOARD_CALENDAR = "life-dashboard-calendar-view";

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
  expandAll: boolean;
};

type RecencySection = { label: string; matchedPaths: Set<string> };

type CanvasTreeDraft = {
  id: string;
  title: string;
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsedNodePaths: Set<string>;
};

type PersistedCanvasTreeDraft = {
  id: string;
  title: string;
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsedNodePaths: string[];
};

type PersistedCanvasDraftState = {
  version: 1;
  nextTreeOrdinal: number;
  trees: PersistedCanvasTreeDraft[];
};

export type OutlineFilterToken =
  | { key: "any" | "path" | "file"; value: string; negated: boolean }
  | { key: "prop"; prop: string; value: string | null; negated: boolean };

export type OutlineSortMode = "recent" | "priority";

export const MIN_TRACKED_SECONDS_PER_PERIOD = 60;
const TRACKING_ADJUST_MINUTES = 5;
const CANVAS_STAGE_WIDTH = 3600;
const CANVAS_STAGE_HEIGHT = 2400;
const CANVAS_CARD_DEFAULT_WIDTH = 380;
const CANVAS_CARD_DEFAULT_HEIGHT = 560;
const CANVAS_CARD_MIN_WIDTH = 320;
const CANVAS_CARD_MIN_HEIGHT = 280;
const CANVAS_DRAFT_VERSION = 1;

export const OUTLINE_RANGE_OPTIONS: Array<{ value: OutlineTimeRange; label: string }> = [
  { value: "today", label: "today" },
  { value: "todayYesterday", label: "today+yesterday" },
  { value: "week", label: "this week" },
  { value: "month", label: "this month" },
  { value: "all", label: "all time" }
];

export const OUTLINE_SORT_OPTIONS: Array<{ value: OutlineSortMode; label: string }> = [
  { value: "recent", label: "recent tracked" },
  { value: "priority", label: "priority" }
];

abstract class LifeDashboardBaseView extends ItemView {
  protected readonly plugin: LifeDashboardPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  protected buildTaskTree(tasks: TaskItem[], options: TaskTreeBuildOptions = {}): TaskTreeData {
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

  protected resolveParentPath(parentRaw: unknown, sourcePath: string): string | null {
    for (const candidate of this.extractParentCandidates(parentRaw)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
      if (file) return file.path;
    }
    return null;
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

  protected filterTasksByQuery(tasks: TaskItem[], query: string): TaskItem[] {
    const tokens = this.parseFilterTokens(query);
    if (tokens.length === 0) return tasks;
    return tasks.filter((task) => this.taskMatchesFilter(task, tokens));
  }

  protected parseFilterTokens(query: string): OutlineFilterToken[] {
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

  protected taskMatchesFilter(task: TaskItem, tokens: OutlineFilterToken[]): boolean {
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

  protected matchesFrontmatterFilter(
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

  protected flattenFrontmatterValues(value: unknown): string[] {
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
}

export class LifeDashboardTimerView extends LifeDashboardBaseView {
  private liveTimerEl: HTMLElement | null = null;

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_TIMER;
  }

  getDisplayText(): string {
    return "Life Timer";
  }

  getIcon(): string {
    return "timer";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.liveTimerEl = null;
  }

  updateLiveTimer(): void {
    if (!this.liveTimerEl) return;
    this.liveTimerEl.setText(this.plugin.formatClockDuration(this.plugin.getCurrentElapsedSeconds()));
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const tasks = this.plugin.getTaskTreeItems();
    const contextTree = this.buildTaskTree(tasks);
    this.renderTrackerPanel(contentEl, tasks, contextTree);

    this.updateLiveTimer();
  }

  private renderTrackerPanel(contentEl: HTMLElement, tasks: TaskItem[], tree: TaskTreeData): void {
    const panel = contentEl.createEl("div", { cls: "fmo-tracker" });
    const top = panel.createEl("div", { cls: "fmo-tracker-top" });

    const timerRing = top.createEl("div", { cls: "fmo-ring" });
    const isTracking = Boolean(this.plugin.settings.activeTrackingStart);
    if (isTracking) this.renderTimerMetaRow(timerRing);

    this.liveTimerEl = timerRing.createEl("div", {
      cls: "fmo-timer-value",
      text: this.plugin.formatClockDuration(this.plugin.getCurrentElapsedSeconds())
    });

    const toggleBtn = timerRing.createEl("button", {
      cls: "fmo-main-toggle",
      text: isTracking ? "Stop" : "Start"
    });
    toggleBtn.addEventListener("click", () => {
      void (isTracking ? this.plugin.stopTracking() : this.plugin.startTracking());
    });

    const activeTaskPath = this.plugin.getActiveTaskPath();
    if (activeTaskPath) {
      this.renderConcernPeriodSummary(top, activeTaskPath);
    }

    this.renderTrackedContext(panel, tasks, tree);
  }

  private renderTimerMetaRow(timerRing: HTMLElement): void {
    const metaRow = timerRing.createEl("div", { cls: "fmo-timer-meta" });
    metaRow.createEl("span", {
      cls: "fmo-timer-start-time",
      text: this.getActiveTrackingStartTimeLabel()
    });

    const plusBtn = metaRow.createEl("button", {
      cls: "fmo-main-adjust",
      text: `+${TRACKING_ADJUST_MINUTES}m`,
      attr: {
        type: "button",
        "aria-label": `Add ${TRACKING_ADJUST_MINUTES} minutes`
      }
    });

    const canExtend = this.plugin.getExtendTrackingBySecondsAvailable() > 0;
    plusBtn.disabled = !canExtend;
    setTooltip(
      plusBtn,
      canExtend
        ? `Move timer start ${TRACKING_ADJUST_MINUTES} minutes earlier.`
        : "Cannot add more time without intersecting the latest saved time entry."
    );

    plusBtn.addEventListener("click", () => {
      void this.plugin.extendActiveTrackingByMinutes(TRACKING_ADJUST_MINUTES);
    });
  }

  private getActiveTrackingStartTimeLabel(): string {
    const start = Number(this.plugin.settings.activeTrackingStart);
    if (!Number.isFinite(start) || start <= 0) return "--:--";
    const date = new Date(start);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private renderConcernPeriodSummary(containerEl: HTMLElement, taskPath: string): void {
    const summary = this.plugin.getConcernPeriodSummary(taskPath);
    const box = containerEl.createEl("div", { cls: "fmo-today-entries" });

    const totals = box.createEl("div", { cls: "fmo-period-totals" });
    this.renderPeriodTotalRow(totals, "This week", summary.weekSeconds, "week");
    this.renderPeriodTotalRow(totals, "Yesterday", summary.yesterdaySeconds, "yesterday");

    const todayTitle = box.createEl("div", {
      cls: "fmo-today-entries-title",
      text: `Today (${this.plugin.formatShortDuration(summary.todaySeconds)}):`
    });
    setTooltip(todayTitle, this.plugin.getTimeRangeDescription("today"));

    if (summary.todayEntries.length > 0) {
      const list = box.createEl("div", { cls: "fmo-today-entries-list" });
      for (const label of summary.todayEntries) {
        list.createEl("div", { cls: "fmo-today-entry", text: label });
      }
    }
  }

  private renderPeriodTotalRow(
    containerEl: HTMLElement,
    label: string,
    seconds: number,
    range: "today" | "yesterday" | "week"
  ): void {
    const row = containerEl.createEl("div", { cls: "fmo-period-row" });
    row.createEl("span", { cls: "fmo-period-row-label", text: `${label}:` });
    row.createEl("span", {
      cls: "fmo-period-row-value",
      text: this.plugin.formatShortDuration(seconds)
    });
    setTooltip(row, this.plugin.getTimeRangeDescription(range));
  }

  private renderTrackedContext(panel: HTMLElement, tasks: TaskItem[], tree: TaskTreeData): void {
    const block = panel.createEl("div", { cls: "fmo-context-block" });

    const activeTaskPath = this.plugin.getActiveTaskPath();
    if (!activeTaskPath) {
      block.createEl("div", { cls: "fmo-selected-sub", text: "No task selected" });
      this.renderChangeTaskButton(block, tasks);
      return;
    }

    const activeTaskFile = this.plugin.app.vault.getAbstractFileByPath(activeTaskPath);
    if (!(activeTaskFile instanceof TFile)) {
      block.createEl("div", { cls: "fmo-selected-sub", text: "Selected task note was not found" });
      this.renderChangeTaskButton(block, tasks);
      return;
    }

    const activeNode = tree.nodesByPath.get(activeTaskPath);
    if (!activeNode) {
      const chain = this.buildTrackedContextChainFromFile(activeTaskFile);
      const card = block.createEl("div", { cls: "fmo-context-card" });
      const chainEl = card.createEl("div", { cls: "fmo-context-chain" });
      for (let i = 0; i < chain.length; i += 1) {
        const file = chain[i];
        if (!file) continue;

        const isTracked = i === 0;
        const item = chainEl.createEl("div", {
          cls: isTracked ? "fmo-context-item fmo-context-item-tracked" : "fmo-context-item fmo-context-item-parent"
        });
        const row = item.createEl("div", { cls: "fmo-context-row" });
        row.createEl("span", {
          cls: "fmo-context-prefix",
          text: this.getContextPrefix(i)
        });
        const link = row.createEl("a", {
          cls: isTracked ? "fmo-note-link fmo-context-link-tracked" : "fmo-note-link",
          text: file.basename,
          href: "#"
        });
        link.addEventListener("click", (evt) => {
          evt.preventDefault();
          void this.plugin.openFile(file.path);
        });

        if (isTracked) {
          this.renderChangeTaskButton(row, tasks);
        }
      }
      return;
    }

    const chain = this.buildTrackedContextChain(activeNode, tree.nodesByPath);
    const card = block.createEl("div", { cls: "fmo-context-card" });
    const chainEl = card.createEl("div", { cls: "fmo-context-chain" });

    for (let i = 0; i < chain.length; i += 1) {
      const node = chain[i];
      if (!node) continue;

      const isTracked = i === 0;
      const item = chainEl.createEl("div", {
        cls: isTracked ? "fmo-context-item fmo-context-item-tracked" : "fmo-context-item fmo-context-item-parent"
      });

      const row = item.createEl("div", { cls: "fmo-context-row" });
      row.createEl("span", {
        cls: "fmo-context-prefix",
        text: this.getContextPrefix(i)
      });
      const link = row.createEl("a", {
        cls: isTracked ? "fmo-note-link fmo-context-link-tracked" : "fmo-note-link",
        text: node.item.file.basename,
        href: "#"
      });
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.plugin.openFile(node.item.file.path);
      });

      if (isTracked) {
        this.renderChangeTaskButton(row, tasks);
      }

      const total = tree.cumulativeSeconds.get(node.path) ?? 0;
      const own = tree.ownSeconds.get(node.path) ?? 0;
      row.createEl("span", {
        cls: "fmo-time-badge fmo-context-time-badge",
        text: this.plugin.formatShortDuration(total),
        attr: {
          title: `Own: ${this.plugin.formatShortDuration(own)} | Total (with children): ${this.plugin.formatShortDuration(total)}`
        }
      });
    }
  }

  private buildTrackedContextChain(node: TaskTreeNode, nodesByPath: Map<string, TaskTreeNode>): TaskTreeNode[] {
    const chain: TaskTreeNode[] = [];
    const visited = new Set<string>();
    let current: TaskTreeNode | undefined = node;

    while (current) {
      if (visited.has(current.path)) {
        console.warn("[life-dashboard] Parent cycle detected while building task context:", current.path);
        break;
      }

      visited.add(current.path);
      chain.push(current);
      current = current.parentPath ? nodesByPath.get(current.parentPath) : undefined;
    }

    return chain;
  }

  private buildTrackedContextChainFromFile(file: TFile): TFile[] {
    const chain: TFile[] = [];
    const visited = new Set<string>();
    let current: TFile | null = file;

    while (current) {
      if (visited.has(current.path)) {
        console.warn("[life-dashboard] Parent cycle detected while building fallback task context:", current.path);
        break;
      }

      visited.add(current.path);
      chain.push(current);

      const parentRaw = this.app.metadataCache.getFileCache(current)?.frontmatter?.parent;
      const parentPath = this.resolveParentPath(parentRaw, current.path);
      if (!parentPath) break;

      const parentFile = this.app.vault.getAbstractFileByPath(parentPath);
      if (!(parentFile instanceof TFile)) break;
      current = parentFile;
    }

    return chain;
  }

  private getContextPrefix(depth: number): string {
    if (depth <= 0) return "● ";
    return `${"  ".repeat(Math.max(0, depth - 1))}└─ `;
  }

  private renderChangeTaskButton(containerEl: HTMLElement, tasks: TaskItem[]): void {
    const button = containerEl.createEl("button", {
      cls: "fmo-context-change-btn",
      text: "🔁",
      attr: {
        type: "button",
        "aria-label": "Change task",
        title: "Change task"
      }
    });
    button.addEventListener("click", () => {
      const taskFiles = tasks.map((item) => item.file);
      const modal = new TaskSelectModal(this.app, taskFiles, (file) => {
        void this.plugin.setSelectedTaskPath(file.path);
      });
      modal.open();
    });
  }
}

export class LifeDashboardOutlineView extends LifeDashboardBaseView {
  private outlineExpandAll = true;
  private outlineStatusDoneFilterEnabled = false;
  private outlineTimeRange: OutlineTimeRange = "todayYesterday";
  private outlineShowOnlyTrackedThisPeriod = true;
  private outlineSortMode: OutlineSortMode = "recent";
  private outlineShowParents = true;

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_OUTLINE;
  }

  getDisplayText(): string {
    return "Concerns Outline";
  }

  getIcon(): string {
    return "list-tree";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const tasks = this.plugin.getTaskTreeItems();
    this.renderOutline(contentEl, tasks);
  }

  private renderOutline(contentEl: HTMLElement, tasks: TaskItem[]): void {
    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const prop = this.plugin.settings.propertyName.trim();
    const value = this.plugin.settings.propertyValue.trim();
    const persistedFilter = this.plugin.getOutlineFilterQuery();

    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concerns Outline" });
    headerTop.createEl("span", { cls: "fmo-version", text: `v${DISPLAY_VERSION}` });

    const rangeRow = header.createEl("div", { cls: "fmo-outline-range-row" });
    this.renderOutlineRangeSelector(rangeRow);

    const controlsRow = header.createEl("div", { cls: "fmo-outline-controls-row" });

    const trackedOnlyRow = controlsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
    const trackedOnlyInput = trackedOnlyRow.createEl("input", {
      cls: "fmo-outline-tracked-only-input",
      attr: {
        type: "checkbox"
      }
    }) as HTMLInputElement;
    trackedOnlyInput.checked = this.outlineShowOnlyTrackedThisPeriod;
    trackedOnlyRow.createEl("span", { text: "Show only tracked this period" });
    setTooltip(
      trackedOnlyRow,
      "Hide concerns with less than 1 minute tracked in the selected period."
    );

    const showParentsRow = controlsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
    const showParentsInput = showParentsRow.createEl("input", {
      cls: "fmo-outline-tracked-only-input",
      attr: {
        type: "checkbox"
      }
    }) as HTMLInputElement;
    showParentsInput.checked = this.outlineShowParents;
    showParentsRow.createEl("span", { text: "Show parents" });
    setTooltip(showParentsRow, "Include matching concerns' parents and group siblings under shared parents.");

    const sortRow = controlsRow.createEl("label", { cls: "fmo-outline-sort-row" });
    sortRow.createEl("span", { cls: "fmo-outline-sort-label", text: "Sort" });
    const sortSelect = sortRow.createEl("select", {
      cls: "fmo-outline-sort-select",
      attr: { "aria-label": "Outline sort mode" }
    });
    for (const option of OUTLINE_SORT_OPTIONS) {
      const optionEl = sortSelect.createEl("option", {
        value: option.value,
        text: option.label
      });
      optionEl.selected = option.value === this.outlineSortMode;
    }

    const filterRow = header.createEl("div", { cls: "fmo-outline-filter-row" });
    const filterInput = filterRow.createEl("div", { cls: "fmo-outline-filter" });
    const filter = new SearchComponent(filterInput);
    filter.setPlaceholder("Filter (path:, file:, prop:key=value, -term, \"phrase\")");
    filter.setValue(persistedFilter);

    const actions = filterRow.createEl("div", { cls: "fmo-outline-filter-actions" });
    const toggleExpandBtn = actions.createEl("button", {
      cls: "fmo-outline-filter-btn",
      text: this.outlineExpandAll ? "−" : "+",
      attr: {
        type: "button",
        "aria-label": this.getExpandAllTooltip()
      }
    });
    setTooltip(toggleExpandBtn, this.getExpandAllTooltip());

    const toggleDoneFilterBtn = actions.createEl("button", {
      cls: this.outlineStatusDoneFilterEnabled
        ? "fmo-outline-filter-btn fmo-outline-filter-btn-active"
        : "fmo-outline-filter-btn",
      text: "done",
      attr: {
        type: "button",
        "aria-label": "Toggle status done filter"
      }
    });
    setTooltip(toggleDoneFilterBtn, this.getDoneFilterTooltip());

    const helpBtn = actions.createEl("button", {
      cls: "fmo-outline-filter-btn fmo-outline-filter-help",
      text: "?",
      attr: {
        type: "button",
        "aria-label": "Outline filter format help"
      }
    });
    setTooltip(helpBtn, "Filter format help");
    helpBtn.addEventListener("click", () => {
      this.openOutlineFilterHelp();
    });

    const subheader = header.createEl("div", {
      cls: "fmo-subheader",
      text: this.getCumulativeFilterLabel(prop, value, "")
    });

    const outlineBody = contentEl.createEl("div", { cls: "fmo-outline-body" });
    const latestTrackedStartForPath = this.createLatestTrackedStartResolver(this.outlineTimeRange);
    const parentByPath = this.buildParentPathMap(tasks);
    const renderFilteredOutline = (query: string): void => {
      outlineBody.empty();

      if (!prop) {
        outlineBody.createEl("p", {
          cls: "fmo-empty",
          text: "Set a task frontmatter property in plugin settings."
        });
        return;
      }

      const queryWithButtonFilters = this.withButtonFilters(query);
      const textFiltered = this.filterTasksForOutline(tasks, queryWithButtonFilters);
      const ownSecondsByPath = this.getOwnSecondsByPath(textFiltered, this.outlineTimeRange);
      const matched = this.outlineShowOnlyTrackedThisPeriod
        ? textFiltered.filter(
            (item) => (ownSecondsByPath.get(item.file.path) ?? 0) >= MIN_TRACKED_SECONDS_PER_PERIOD
          )
        : textFiltered;
      subheader.setText(this.getCumulativeFilterLabel(prop, value, queryWithButtonFilters));

      if (!matched.length) {
        outlineBody.createEl("p", {
          cls: "fmo-empty",
          text: "No matching concerns found for current filter."
        });
        return;
      }

      const latestMatchedStartByPath = new Map<string, number>();
      for (const item of matched) {
        latestMatchedStartByPath.set(
          item.file.path,
          latestTrackedStartForPath(item.file.path)
        );
      }
      const sections = this.groupMatchedPathsByRecencyBucket(matched, latestMatchedStartByPath);
      for (const section of sections) {
        if (section.matchedPaths.size === 0) continue;

        const visiblePaths = this.outlineShowParents
          ? this.collectPathsWithParents(section.matchedPaths, parentByPath)
          : section.matchedPaths;
        const visibleTasks = tasks.filter((item) => visiblePaths.has(item.file.path));
        const tree = this.buildTaskTree(visibleTasks, {
          ownSecondsForPath: (path) => ownSecondsByPath.get(path) ?? 0,
          sortMode: this.outlineSortMode,
          latestTrackedStartForPath
        });

        outlineBody.createEl("div", {
          cls: "fmo-outline-section-label",
          text: section.label
        });
        const rootList = outlineBody.createEl("ul", { cls: "fmo-tree fmo-tree-section" });
        const renderState: TreeRenderState = {
          cumulativeSeconds: tree.cumulativeSeconds,
          ownSeconds: tree.ownSeconds,
          matchedPaths: section.matchedPaths,
          expandAll: this.outlineExpandAll
        };
        for (const root of tree.roots) {
          this.renderTreeNode(rootList, root, renderState, new Set());
        }
      }
    };

    toggleExpandBtn.addEventListener("click", () => {
      this.outlineExpandAll = !this.outlineExpandAll;
      toggleExpandBtn.setText(this.outlineExpandAll ? "−" : "+");
      toggleExpandBtn.setAttribute("aria-label", this.getExpandAllTooltip());
      setTooltip(toggleExpandBtn, this.getExpandAllTooltip());
      renderFilteredOutline(filter.getValue());
    });

    toggleDoneFilterBtn.addEventListener("click", () => {
      this.outlineStatusDoneFilterEnabled = !this.outlineStatusDoneFilterEnabled;
      toggleDoneFilterBtn.toggleClass("fmo-outline-filter-btn-active", this.outlineStatusDoneFilterEnabled);
      setTooltip(toggleDoneFilterBtn, this.getDoneFilterTooltip());
      renderFilteredOutline(filter.getValue());
    });

    trackedOnlyInput.addEventListener("change", () => {
      this.outlineShowOnlyTrackedThisPeriod = trackedOnlyInput.checked;
      renderFilteredOutline(filter.getValue());
    });

    showParentsInput.addEventListener("change", () => {
      this.outlineShowParents = showParentsInput.checked;
      renderFilteredOutline(filter.getValue());
    });

    sortSelect.addEventListener("change", () => {
      const selected = sortSelect.value as OutlineSortMode;
      this.outlineSortMode = OUTLINE_SORT_OPTIONS.some((option) => option.value === selected)
        ? selected
        : "recent";
      renderFilteredOutline(filter.getValue());
    });

    filter.onChange((query) => {
      this.plugin.setOutlineFilterQuery(query);
      renderFilteredOutline(query);
    });

    renderFilteredOutline(persistedFilter);
  }

  private renderOutlineRangeSelector(containerEl: HTMLElement): void {
    for (const option of OUTLINE_RANGE_OPTIONS) {
      const button = containerEl.createEl("button", {
        cls:
          this.outlineTimeRange === option.value
            ? "fmo-outline-range-btn fmo-outline-range-btn-active"
            : "fmo-outline-range-btn",
        text: option.label,
        attr: {
          type: "button",
          "aria-pressed": String(this.outlineTimeRange === option.value)
        }
      });
      setTooltip(button, this.plugin.getTimeRangeDescription(option.value));

      button.addEventListener("click", () => {
        if (this.outlineTimeRange === option.value) return;
        this.outlineTimeRange = option.value;
        void this.render();
      });
    }
  }

  private getOwnSecondsByPath(tasks: TaskItem[], range: OutlineTimeRange): Map<string, number> {
    const ownSecondsByPath = new Map<string, number>();
    for (const item of tasks) {
      ownSecondsByPath.set(
        item.file.path,
        this.plugin.getTrackedSecondsForRange(item.file.path, range)
      );
    }
    return ownSecondsByPath;
  }

  private withButtonFilters(query: string): string {
    if (!this.outlineStatusDoneFilterEnabled) return query;
    const base = query.trim();
    return base.length > 0 ? `${base} prop:status=done` : "prop:status=done";
  }

  private getCumulativeFilterLabel(
    prop: string,
    value: string,
    queryWithButtonFilters: string
  ): string {
    const clauses: string[] = [];
    clauses.push(value.length > 0 ? `prop:${prop}=${value}` : `prop:${prop}`);

    const query = queryWithButtonFilters.trim();
    if (query.length > 0) {
      clauses.push(query);
    }

    if (this.outlineShowOnlyTrackedThisPeriod) {
      clauses.push(`tracked>=1m (${this.outlineTimeRange})`);
    }

    if (!this.outlineShowParents) {
      clauses.push("parents:hidden");
    }

    return `Filter: ${clauses.join(" AND ")}`;
  }

  private createLatestTrackedStartResolver(range: OutlineTimeRange): (path: string) => number {
    const cached = new Map<string, number>();
    return (path: string): number => {
      const existing = cached.get(path);
      if (existing != null) return existing;

      const latest = this.plugin.getLatestTrackedStartMsForRange(path, range);
      cached.set(path, latest);
      return latest;
    };
  }

  private buildParentPathMap(tasks: TaskItem[]): Map<string, string> {
    const allPaths = new Set(tasks.map((item) => item.file.path));
    const parentByPath = new Map<string, string>();

    for (const item of tasks) {
      const parentPath = this.resolveParentPath(item.parentRaw, item.file.path);
      if (!parentPath || !allPaths.has(parentPath) || parentPath === item.file.path) continue;
      parentByPath.set(item.file.path, parentPath);
    }

    return parentByPath;
  }

  private collectPathsWithParents(
    matchedPaths: Set<string>,
    parentByPath: Map<string, string>
  ): Set<string> {
    const output = new Set<string>(matchedPaths);
    for (const path of matchedPaths) {
      let cursor = parentByPath.get(path);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        output.add(cursor);
        cursor = parentByPath.get(cursor);
      }
    }

    return output;
  }

  private groupMatchedPathsByRecencyBucket(
    matched: TaskItem[],
    latestMatchedStartByPath: Map<string, number>
  ): RecencySection[] {
    const groups: RecencySection[] = [
      { label: "Today", matchedPaths: new Set<string>() },
      { label: "Yesterday", matchedPaths: new Set<string>() },
      { label: "This week", matchedPaths: new Set<string>() },
      { label: "Earlier", matchedPaths: new Set<string>() }
    ];

    const now = new Date();
    const todayStart = this.getDayStart(now).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
    const weekStart = this.getWeekStart(now).getTime();

    for (const item of matched) {
      const latest = latestMatchedStartByPath.get(item.file.path) ?? 0;
      if (latest >= todayStart) {
        groups[0].matchedPaths.add(item.file.path);
      } else if (latest >= yesterdayStart) {
        groups[1].matchedPaths.add(item.file.path);
      } else if (latest >= weekStart) {
        groups[2].matchedPaths.add(item.file.path);
      } else {
        groups[3].matchedPaths.add(item.file.path);
      }
    }

    return groups;
  }

  private getWeekStart(now: Date): Date {
    const start = this.getDayStart(now);
    const day = start.getDay();
    const weekStartsOn = this.plugin.settings.weekStartsOn === "sunday" ? 0 : 1;
    const offset = (day - weekStartsOn + 7) % 7;
    start.setDate(start.getDate() - offset);
    return start;
  }

  private getDayStart(value: Date): Date {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
  }

  private getExpandAllTooltip(): string {
    return this.outlineExpandAll ? "Collapse all concerns" : "Expand all concerns";
  }

  private getDoneFilterTooltip(): string {
    return this.outlineStatusDoneFilterEnabled
      ? "Done filter ON: prop:status=done"
      : "Done filter OFF (click to enable prop:status=done)";
  }

  private openOutlineFilterHelp(): void {
    const modal = new Modal(this.app);
    modal.setTitle("Outline Filter Format");

    const body = modal.contentEl.createEl("div", { cls: "fmo-filter-help" });
    body.createEl("p", { text: "Terms are combined with AND (all terms must match)." });

    const list = body.createEl("ul");
    list.createEl("li", { text: "term -> match in file name or path" });
    list.createEl("li", { text: "\"quoted phrase\" -> phrase match in file name or path" });
    list.createEl("li", { text: "file:term -> match only file name" });
    list.createEl("li", { text: "path:term -> match only full path" });
    list.createEl("li", { text: "prop:key -> frontmatter key exists" });
    list.createEl("li", { text: "prop:key=value (or fm:key=value) -> frontmatter key equals value" });
    list.createEl("li", { text: "-term / -file:term / -path:term -> exclude matches" });
    list.createEl("li", { text: "-prop:key / -prop:key=value -> negate property match" });

    body.createEl("p", { text: "Examples:" });
    const examples = body.createEl("ul");
    examples.createEl("li", { text: "qq path:GTD/Graph" });
    examples.createEl("li", { text: "\"qq wrapper\" -path:Archive" });
    examples.createEl("li", { text: "file:wrapper -file:old" });
    examples.createEl("li", { text: "prop:type=concern -prop:status=done" });

    modal.open();
  }

  private filterTasksForOutline(tasks: TaskItem[], query: string): TaskItem[] {
    return this.filterTasksByQuery(tasks, query);
  }

  private renderTreeNode(
    containerEl: HTMLElement,
    node: TaskTreeNode,
    state: TreeRenderState,
    ancestry: Set<string>
  ): void {
    if (ancestry.has(node.path)) return;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.path);

    const li = containerEl.createEl("li", { cls: "fmo-tree-item" });
    const isParentOnly = !state.matchedPaths.has(node.path);
    const row = li.createEl("div", {
      cls: isParentOnly ? "fmo-tree-row fmo-tree-row-parent" : "fmo-tree-row"
    });

    const total = state.cumulativeSeconds.get(node.path) ?? 0;
    const own = state.ownSeconds.get(node.path) ?? 0;

    let childrenList: HTMLElement | null = null;
    if (node.children.length > 0) {
      const isExpanded = state.expandAll;
      const toggle = row.createEl("button", {
        cls: "fmo-toggle",
        attr: {
          type: "button",
          "aria-expanded": String(isExpanded),
          "aria-label": `Expand ${node.item.file.basename}`
        }
      });
      toggle.setText(isExpanded ? "▾" : "▸");

      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        const next = !expanded;
        toggle.setAttribute("aria-expanded", String(next));
        toggle.setText(next ? "▾" : "▸");
        if (childrenList) {
          childrenList.hidden = !next;
        }
      });

      childrenList = li.createEl("ul", { cls: "fmo-tree fmo-tree-children" });
      childrenList.hidden = !isExpanded;
    } else {
      row.createEl("span", { cls: "fmo-toggle-spacer", text: "" });
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

    row.createEl("span", {
      cls: "fmo-time-badge",
      text: this.plugin.formatShortDuration(total),
      attr: {
        title: `Own: ${this.plugin.formatShortDuration(own)} | Total (with children): ${this.plugin.formatShortDuration(total)}`
      }
    });

    if (childrenList) {
      for (const child of node.children) {
        this.renderTreeNode(childrenList, child, state, nextAncestry);
      }
    }
  }
}

export class LifeDashboardConcernCanvasView extends LifeDashboardBaseView {
  private canvasTrees: CanvasTreeDraft[] = [];
  private nextCanvasTreeOrdinal = 1;
  private canvasTreesLoaded = false;

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_CANVAS;
  }

  getDisplayText(): string {
    return "Concerns Canvas";
  }

  getIcon(): string {
    return "layout-grid";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");
    contentEl.addClass("fmo-canvas-view");

    const tasks = this.plugin.getTaskTreeItems();
    this.ensureCanvasTrees(tasks);

    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concerns Canvas (draft)" });
    headerTop.createEl("span", { cls: "fmo-version", text: `v${DISPLAY_VERSION}` });

    const toolbar = header.createEl("div", { cls: "fmo-canvas-toolbar" });
    const addBtn = toolbar.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Add tree",
      attr: { type: "button" }
    });
    setTooltip(addBtn, "Create another concern tree card that you can drag anywhere.");
    addBtn.addEventListener("click", () => {
      const slot = this.canvasTrees.length;
      this.canvasTrees.push(
        this.createCanvasTreeDraft({
          x: 56 + (slot % 4) * 420,
          y: 70 + Math.floor(slot / 4) * 290
        })
      );
      this.persistCanvasTrees();
      void this.render();
    });

    const resetBtn = toolbar.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Reset layout",
      attr: { type: "button" }
    });
    setTooltip(resetBtn, "Repack all trees into a readable grid layout.");
    resetBtn.addEventListener("click", () => {
      this.canvasTrees.forEach((tree, index) => {
        tree.x = 56 + (index % 4) * 420;
        tree.y = 70 + Math.floor(index / 4) * 290;
      });
      this.persistCanvasTrees();
      void this.render();
    });

    toolbar.createEl("span", {
      cls: "fmo-subheader fmo-canvas-toolbar-meta",
      text: `${this.canvasTrees.length} tree${this.canvasTrees.length === 1 ? "" : "s"}`
    });

    const note = header.createEl("div", {
      cls: "fmo-subheader",
      text: "Drag cards, pick any root, then tune filter/sort per tree."
    });
    setTooltip(
      note,
      "Canvas layout and per-tree controls are saved between reopenings."
    );

    const viewport = contentEl.createEl("div", { cls: "fmo-canvas-viewport" });
    const stage = viewport.createEl("div", { cls: "fmo-canvas-stage" });
    stage.style.width = `${CANVAS_STAGE_WIDTH}px`;
    stage.style.height = `${CANVAS_STAGE_HEIGHT}px`;

    for (const tree of this.canvasTrees) {
      this.renderCanvasTreeCard(stage, tree, tasks);
    }
  }

  private ensureCanvasTrees(tasks: TaskItem[]): void {
    if (!this.canvasTreesLoaded) {
      this.loadPersistedCanvasTrees();
      this.canvasTreesLoaded = true;
    }

    const validPaths = new Set(tasks.map((task) => task.file.path));
    let changed = false;
    this.canvasTrees = this.canvasTrees.map((tree) => {
      const normalizedRootPath =
        tree.rootPath.length > 0 && validPaths.has(tree.rootPath) ? tree.rootPath : "";
      if (normalizedRootPath !== tree.rootPath) {
        changed = true;
        tree.rootPath = normalizedRootPath;
      }
      return tree;
    });

    if (this.canvasTrees.length === 0) {
      this.canvasTrees = this.createInitialCanvasTrees(tasks);
      changed = true;
    }

    if (changed) {
      this.persistCanvasTrees();
    }
  }

  private loadPersistedCanvasTrees(): void {
    const raw = this.plugin.getCanvasDraftState().trim();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!this.isPersistedCanvasDraftState(parsed)) {
      return;
    }

    const trees = parsed.trees.map((tree) => this.hydratePersistedCanvasTree(tree));
    if (trees.length === 0) return;

    this.canvasTrees = trees;
    const inferredNext = this.inferNextCanvasTreeOrdinal(this.canvasTrees);
    const savedNext = Math.max(1, Math.floor(parsed.nextTreeOrdinal));
    this.nextCanvasTreeOrdinal = Math.max(savedNext, inferredNext, this.nextCanvasTreeOrdinal);
  }

  private persistCanvasTrees(): void {
    const state: PersistedCanvasDraftState = {
      version: CANVAS_DRAFT_VERSION,
      nextTreeOrdinal: this.nextCanvasTreeOrdinal,
      trees: this.canvasTrees.map((tree) => this.serializeCanvasTreeDraft(tree))
    };
    this.plugin.setCanvasDraftState(JSON.stringify(state));
  }

  private isPersistedCanvasDraftState(value: unknown): value is PersistedCanvasDraftState {
    if (!this.isRecord(value)) return false;
    if (value.version !== CANVAS_DRAFT_VERSION) return false;
    if (typeof value.nextTreeOrdinal !== "number" || !Number.isFinite(value.nextTreeOrdinal)) {
      return false;
    }
    if (!Array.isArray(value.trees)) return false;
    return value.trees.every((tree) => this.isPersistedCanvasTreeDraft(tree));
  }

  private isPersistedCanvasTreeDraft(value: unknown): value is PersistedCanvasTreeDraft {
    if (!this.isRecord(value)) return false;
    if (typeof value.id !== "string") return false;
    if (typeof value.title !== "string") return false;
    if (typeof value.rootPath !== "string") return false;
    if (typeof value.query !== "string") return false;
    if (value.sortMode !== "recent" && value.sortMode !== "priority") return false;
    if (!OUTLINE_RANGE_OPTIONS.some((option) => option.value === value.range)) return false;
    if (typeof value.trackedOnly !== "boolean") return false;
    if (typeof value.showParents !== "boolean") return false;
    if (typeof value.collapsed !== "boolean") return false;
    if (typeof value.x !== "number" || !Number.isFinite(value.x)) return false;
    if (typeof value.y !== "number" || !Number.isFinite(value.y)) return false;
    if (typeof value.width !== "number" || !Number.isFinite(value.width)) return false;
    if (typeof value.height !== "number" || !Number.isFinite(value.height)) return false;
    if (!Array.isArray(value.collapsedNodePaths)) return false;
    return value.collapsedNodePaths.every((path) => typeof path === "string");
  }

  private hydratePersistedCanvasTree(tree: PersistedCanvasTreeDraft): CanvasTreeDraft {
    const draft = this.createCanvasTreeDraft();
    const id = tree.id.trim();
    draft.id = id.length > 0 ? id : draft.id;
    draft.title = tree.title.trim() || draft.title;
    draft.rootPath = tree.rootPath.trim();
    draft.query = tree.query;
    draft.sortMode = tree.sortMode;
    draft.range = tree.range;
    draft.trackedOnly = tree.trackedOnly;
    draft.showParents = tree.showParents;
    draft.collapsed = tree.collapsed;
    draft.x = this.clamp(Math.floor(tree.x), 16, CANVAS_STAGE_WIDTH - CANVAS_CARD_MIN_WIDTH - 16);
    draft.y = this.clamp(Math.floor(tree.y), 16, CANVAS_STAGE_HEIGHT - CANVAS_CARD_MIN_HEIGHT - 16);
    draft.width = this.clamp(
      Math.floor(tree.width),
      CANVAS_CARD_MIN_WIDTH,
      CANVAS_STAGE_WIDTH - draft.x - 16
    );
    draft.height = this.clamp(
      Math.floor(tree.height),
      CANVAS_CARD_MIN_HEIGHT,
      CANVAS_STAGE_HEIGHT - draft.y - 16
    );
    draft.collapsedNodePaths = new Set(
      tree.collapsedNodePaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
    );
    return draft;
  }

  private serializeCanvasTreeDraft(tree: CanvasTreeDraft): PersistedCanvasTreeDraft {
    return {
      id: tree.id,
      title: tree.title,
      rootPath: tree.rootPath,
      query: tree.query,
      sortMode: tree.sortMode,
      range: tree.range,
      trackedOnly: tree.trackedOnly,
      showParents: tree.showParents,
      collapsed: tree.collapsed,
      x: Math.round(tree.x),
      y: Math.round(tree.y),
      width: Math.round(tree.width),
      height: Math.round(tree.height),
      collapsedNodePaths: [...tree.collapsedNodePaths]
    };
  }

  private inferNextCanvasTreeOrdinal(trees: CanvasTreeDraft[]): number {
    let next = 1;
    for (const tree of trees) {
      const match = /^tree-(\d+)$/.exec(tree.id);
      if (!match?.[1]) continue;
      const ordinal = Number.parseInt(match[1], 10);
      if (Number.isFinite(ordinal) && ordinal + 1 > next) {
        next = ordinal + 1;
      }
    }
    return next;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private createInitialCanvasTrees(tasks: TaskItem[]): CanvasTreeDraft[] {
    const preferredRoot = this.getPreferredRootPath(tasks);
    const trees: CanvasTreeDraft[] = [
      this.createCanvasTreeDraft({
        title: "Focus now",
        rootPath: preferredRoot,
        trackedOnly: true,
        range: "todayYesterday",
        x: 72,
        y: 72
      }),
      this.createCanvasTreeDraft({
        title: "Priority map",
        sortMode: "priority",
        range: "all",
        trackedOnly: false,
        x: 520,
        y: 210
      })
    ];
    return trees;
  }

  private getPreferredRootPath(tasks: TaskItem[]): string {
    const selectedPath = this.plugin.settings.selectedTaskPath.trim();
    if (selectedPath.length > 0 && tasks.some((task) => task.file.path === selectedPath)) {
      return selectedPath;
    }

    let bestPath = "";
    let bestSeconds = -1;
    for (const task of tasks) {
      const seconds = this.plugin.getTrackedSeconds(task.file.path);
      if (seconds > bestSeconds) {
        bestSeconds = seconds;
        bestPath = task.file.path;
      }
    }
    return bestPath;
  }

  private createCanvasTreeDraft(overrides: Partial<CanvasTreeDraft> = {}): CanvasTreeDraft {
    const id = `tree-${this.nextCanvasTreeOrdinal}`;
    this.nextCanvasTreeOrdinal += 1;
    const draft: CanvasTreeDraft = {
      id,
      title: "Concern tree",
      rootPath: "",
      query: "",
      sortMode: "recent",
      range: "todayYesterday",
      trackedOnly: true,
      showParents: true,
      collapsed: false,
      x: 64,
      y: 64,
      width: CANVAS_CARD_DEFAULT_WIDTH,
      height: CANVAS_CARD_DEFAULT_HEIGHT,
      collapsedNodePaths: new Set<string>()
    };

    const merged: CanvasTreeDraft = { ...draft, ...overrides };
    merged.collapsedNodePaths = overrides.collapsedNodePaths
      ? new Set(overrides.collapsedNodePaths)
      : new Set(draft.collapsedNodePaths);

    return merged;
  }

  private renderCanvasTreeCard(stageEl: HTMLElement, tree: CanvasTreeDraft, tasks: TaskItem[]): void {
    const card = stageEl.createEl("section", { cls: "fmo-canvas-card" });
    card.classList.toggle("fmo-canvas-card-collapsed", tree.collapsed);
    card.style.left = `${tree.x}px`;
    card.style.top = `${tree.y}px`;
    card.style.width = `${tree.width}px`;
    if (!tree.collapsed) {
      card.style.height = `${tree.height}px`;
    }

    const header = card.createEl("div", { cls: "fmo-canvas-card-header" });
    const dragHandle = header.createEl("button", {
      cls: "fmo-canvas-drag-handle",
      text: "⠿",
      attr: {
        type: "button",
        "aria-label": `Move ${tree.title}`
      }
    }) as HTMLButtonElement;
    setTooltip(dragHandle, "Drag tree card");

    const titleInput = header.createEl("input", {
      cls: "fmo-canvas-title",
      attr: {
        type: "text",
        "aria-label": "Tree title"
      }
    }) as HTMLInputElement;
    titleInput.value = tree.title;
    titleInput.addEventListener("change", () => {
      tree.title = titleInput.value.trim() || "Concern tree";
      titleInput.value = tree.title;
      setTooltip(dragHandle, `Drag ${tree.title}`);
      this.persistCanvasTrees();
    });

    const headerActions = header.createEl("div", { cls: "fmo-canvas-card-actions" });
    const collapseBtn = headerActions.createEl("button", {
      cls: "fmo-canvas-card-btn",
      text: tree.collapsed ? "▸" : "▾",
      attr: {
        type: "button",
        "aria-label": tree.collapsed ? "Expand tree card" : "Collapse tree card"
      }
    });
    collapseBtn.addEventListener("click", () => {
      tree.collapsed = !tree.collapsed;
      this.persistCanvasTrees();
      void this.render();
    });

    const removeBtn = headerActions.createEl("button", {
      cls: "fmo-canvas-card-btn",
      text: "×",
      attr: {
        type: "button",
        "aria-label": "Remove tree card"
      }
    });
    removeBtn.disabled = this.canvasTrees.length <= 1;
    removeBtn.addEventListener("click", () => {
      if (this.canvasTrees.length <= 1) return;
      this.canvasTrees = this.canvasTrees.filter((entry) => entry.id !== tree.id);
      this.persistCanvasTrees();
      void this.render();
    });

    this.attachCanvasCardDragging(dragHandle, card, tree);
    if (!tree.collapsed) {
      this.attachCanvasCardResizing(card, tree);
    }

    if (tree.collapsed) return;

    const panelContainer = card.createEl("div", { cls: "fmo-canvas-card-body" });

    new ConcernTreePanel({
      plugin: this.plugin,
      container: panelContainer,
      state: {
        rootPath: tree.rootPath,
        query: tree.query,
        sortMode: tree.sortMode,
        range: tree.range,
        trackedOnly: tree.trackedOnly,
        showParents: tree.showParents,
        collapsedNodePaths: tree.collapsedNodePaths,
      },
      onChange: (_visiblePaths, newState) => {
        tree.rootPath = newState.rootPath;
        tree.query = newState.query;
        tree.sortMode = newState.sortMode;
        tree.range = newState.range;
        tree.trackedOnly = newState.trackedOnly;
        tree.showParents = newState.showParents;
        tree.collapsedNodePaths = newState.collapsedNodePaths;
        this.persistCanvasTrees();
      },
    });
  }

  private attachCanvasCardDragging(
    handleEl: HTMLButtonElement,
    cardEl: HTMLElement,
    tree: CanvasTreeDraft
  ): void {
    handleEl.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      evt.preventDefault();

      const startX = evt.clientX;
      const startY = evt.clientY;
      const startLeft = tree.x;
      const startTop = tree.y;

      const onMove = (moveEvt: PointerEvent): void => {
        const nextX = startLeft + (moveEvt.clientX - startX);
        const nextY = startTop + (moveEvt.clientY - startY);
        const maxX = Math.max(16, CANVAS_STAGE_WIDTH - tree.width - 16);
        const currentHeight = tree.collapsed
          ? Math.round(cardEl.getBoundingClientRect().height)
          : tree.height;
        const maxY = Math.max(16, CANVAS_STAGE_HEIGHT - currentHeight - 16);

        tree.x = this.clamp(nextX, 16, maxX);
        tree.y = this.clamp(nextY, 16, maxY);
        cardEl.style.left = `${tree.x}px`;
        cardEl.style.top = `${tree.y}px`;
      };

      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        this.persistCanvasTrees();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });
  }

  private attachCanvasCardResizing(cardEl: HTMLElement, tree: CanvasTreeDraft): void {
    const resizeHandle = cardEl.createEl("button", {
      cls: "fmo-canvas-resize-handle",
      text: "◢",
      attr: {
        type: "button",
        "aria-label": `Resize ${tree.title}`
      }
    }) as HTMLButtonElement;
    setTooltip(resizeHandle, "Resize tree card");

    resizeHandle.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      evt.stopPropagation();

      const startX = evt.clientX;
      const startY = evt.clientY;
      const startWidth = tree.width;
      const startHeight = tree.height;

      const onMove = (moveEvt: PointerEvent): void => {
        const nextWidth = startWidth + (moveEvt.clientX - startX);
        const nextHeight = startHeight + (moveEvt.clientY - startY);
        const maxWidth = Math.max(
          CANVAS_CARD_MIN_WIDTH,
          CANVAS_STAGE_WIDTH - tree.x - 16
        );
        const maxHeight = Math.max(
          CANVAS_CARD_MIN_HEIGHT,
          CANVAS_STAGE_HEIGHT - tree.y - 16
        );

        tree.width = this.clamp(nextWidth, CANVAS_CARD_MIN_WIDTH, maxWidth);
        tree.height = this.clamp(nextHeight, CANVAS_CARD_MIN_HEIGHT, maxHeight);
        cardEl.style.width = `${tree.width}px`;
        cardEl.style.height = `${tree.height}px`;
      };

      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        this.persistCanvasTrees();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}

type CalendarPeriod = "today" | "week";

type CalendarEntry = {
  path: string;
  basename: string;
  entry: TimeLogEntry;
};

type HourRange = { minHour: number; maxHour: number };

const CALENDAR_COLORS = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
  "#9c755f", "#bab0ac"
];

const DAY_TIMELINE_PX_PER_HOUR = 60;
const WEEK_GRID_PX_PER_HOUR = 40;
const BLOCK_MIN_HEIGHT_PX = 3;

const pad2 = (n: number): string => String(n).padStart(2, "0");

export class LifeDashboardCalendarView extends LifeDashboardBaseView {
  private get period(): CalendarPeriod {
    return this.plugin.settings.calendarPeriod === "week" ? "week" : "today";
  }

  private set period(value: CalendarPeriod) {
    if (this.plugin.settings.calendarPeriod === value) return;
    this.plugin.settings.calendarPeriod = value;
    void this.plugin.saveSettings();
  }

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_CALENDAR;
  }

  getDisplayText(): string {
    return "Concerns Calendar";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concerns Calendar" });

    const rangeRow = header.createEl("div", { cls: "fmo-outline-range-row" });
    for (const option of [
      { value: "today" as CalendarPeriod, label: "Today" },
      { value: "week" as CalendarPeriod, label: "This Week" }
    ]) {
      const button = rangeRow.createEl("button", {
        cls: this.period === option.value
          ? "fmo-outline-range-btn fmo-outline-range-btn-active"
          : "fmo-outline-range-btn",
        text: option.label,
        attr: { type: "button", "aria-pressed": String(this.period === option.value) }
      });
      button.addEventListener("click", () => {
        if (this.period === option.value) return;
        this.period = option.value;
        void this.render();
      });
    }

    const entries = this.gatherCalendarEntries();
    if (entries.length === 0) {
      contentEl.createEl("p", { cls: "fmo-empty", text: "No tracked time in this period." });
      return;
    }

    const colorMap = this.buildColorMap(entries);
    if (this.period === "today") {
      this.renderDayTimeline(contentEl, entries, colorMap);
    } else {
      this.renderWeekGrid(contentEl, entries, colorMap);
    }
    this.renderSummaryTable(contentEl, entries, colorMap);
  }

  private gatherCalendarEntries(): CalendarEntry[] {
    const now = new Date();
    const window = this.plugin.getWindowForRange(this.period === "today" ? "today" : "week", now);
    const result: CalendarEntry[] = [];

    for (const task of this.plugin.getTaskTreeItems()) {
      for (const entry of this.plugin.getEntriesForPath(task.file.path)) {
        if (entry.startMs >= window.startMs && entry.startMs < window.endMs) {
          result.push({ path: task.file.path, basename: task.file.basename, entry });
        }
      }
    }

    return result.sort((a, b) => a.entry.startMs - b.entry.startMs);
  }

  private buildColorMap(entries: CalendarEntry[]): Map<string, string> {
    const pathBasenames = new Map<string, string>();
    for (const e of entries) pathBasenames.set(e.path, e.basename);

    const sorted = [...pathBasenames.entries()].sort((a, b) =>
      a[1].localeCompare(b[1], undefined, { sensitivity: "base" })
    );

    const colorMap = new Map<string, string>();
    for (let i = 0; i < sorted.length; i++) {
      colorMap.set(sorted[i][0], CALENDAR_COLORS[i % CALENDAR_COLORS.length]);
    }
    return colorMap;
  }

  private computeHourRange(entries: CalendarEntry[]): HourRange {
    let minHour = 23;
    let maxHour = 0;
    for (const e of entries) {
      const startH = new Date(e.entry.startMs).getHours();
      const endMs = e.entry.startMs + e.entry.durationMinutes * 60 * 1000;
      const endDate = new Date(endMs);
      const endH = endDate.getHours() + (endDate.getMinutes() > 0 ? 1 : 0);
      if (startH < minHour) minHour = startH;
      if (endH > maxHour) maxHour = endH;
    }
    minHour = Math.max(0, minHour - 1);
    maxHour = Math.min(24, maxHour + 1);
    if (maxHour <= minHour) maxHour = minHour + 1;
    return { minHour, maxHour };
  }

  private renderHourLabelsAndGridlines(
    container: HTMLElement,
    { minHour, maxHour }: HourRange,
    pxPerHour: number,
    labelCls: string
  ): void {
    for (let h = minHour; h <= maxHour; h++) {
      const y = (h - minHour) * pxPerHour;
      const label = container.createEl("div", { cls: labelCls });
      label.style.top = `${y}px`;
      label.setText(`${pad2(h)}:00`);

      const line = container.createEl("div", { cls: "fmo-calendar-gridline" });
      line.style.top = `${y}px`;
    }
  }

  private renderEntryBlock(
    container: HTMLElement,
    e: CalendarEntry,
    colorMap: Map<string, string>,
    minHour: number,
    pxPerHour: number,
    dayStartMs: number
  ): void {
    const startFrac = (e.entry.startMs - dayStartMs) / (60 * 60 * 1000);
    const durationHours = e.entry.durationMinutes / 60;
    const top = (startFrac - minHour) * pxPerHour;
    const height = Math.max(BLOCK_MIN_HEIGHT_PX, durationHours * pxPerHour);

    const startDate = new Date(e.entry.startMs);
    const timeLabel = `${pad2(startDate.getHours())}:${pad2(startDate.getMinutes())}`;
    const durationLabel = this.plugin.formatShortDuration(e.entry.durationMinutes * 60);
    const tooltip = `${e.basename} ${timeLabel} (${durationLabel})`;

    const block = container.createEl("div", { cls: "fmo-calendar-block" });
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.backgroundColor = colorMap.get(e.path) ?? CALENDAR_COLORS[0];
    block.title = tooltip;
    if (height >= 12) block.setText(height >= 20 ? tooltip : e.basename);

    block.addEventListener("click", () => { void this.plugin.openFile(e.path); });
  }

  private renderDayTimeline(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>
  ): void {
    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * DAY_TIMELINE_PX_PER_HOUR;
    const dayStartMs = this.plugin.getDayStart(new Date()).getTime();

    const timeline = containerEl.createEl("div", { cls: "fmo-calendar-timeline" });
    timeline.style.height = `${gridHeight}px`;

    this.renderHourLabelsAndGridlines(timeline, hourRange, DAY_TIMELINE_PX_PER_HOUR, "fmo-calendar-hour-label");

    for (const e of entries) {
      this.renderEntryBlock(timeline, e, colorMap, hourRange.minHour, DAY_TIMELINE_PX_PER_HOUR, dayStartMs);
    }
  }

  private renderWeekGrid(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>
  ): void {
    const now = new Date();
    const weekStart = this.plugin.getWeekStart(now);
    const dayNames = this.plugin.settings.weekStartsOn === "sunday"
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    const dayEntries: CalendarEntry[][] = Array.from({ length: 7 }, () => []);
    for (const e of entries) {
      const dayIndex = Math.floor(
        (this.plugin.getDayStart(new Date(e.entry.startMs)).getTime() - weekStart.getTime()) /
        (24 * 60 * 60 * 1000)
      );
      if (dayIndex >= 0 && dayIndex < 7) dayEntries[dayIndex].push(e);
    }

    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * WEEK_GRID_PX_PER_HOUR;
    const todayMs = this.plugin.getDayStart(now).getTime();

    const wrapper = containerEl.createEl("div", { cls: "fmo-calendar-week-wrapper" });

    // Hour axis
    const hourAxis = wrapper.createEl("div", { cls: "fmo-calendar-week-hour-axis" });
    hourAxis.style.height = `${gridHeight}px`;
    this.renderHourLabelsAndGridlines(hourAxis, hourRange, WEEK_GRID_PX_PER_HOUR, "fmo-calendar-hour-label");

    // Day columns
    const grid = wrapper.createEl("div", { cls: "fmo-calendar-week-grid" });

    for (let d = 0; d < 7; d++) {
      const dayMs = weekStart.getTime() + d * 24 * 60 * 60 * 1000;
      const isToday = dayMs === todayMs;

      const col = grid.createEl("div", { cls: "fmo-calendar-week-col" });

      const dayLabel = col.createEl("div", {
        cls: isToday ? "fmo-calendar-day-label fmo-calendar-day-today" : "fmo-calendar-day-label",
        text: `${dayNames[d] ?? ""} ${pad2(new Date(dayMs).getDate())}`
      });

      const dayCol = col.createEl("div", { cls: "fmo-calendar-day-bar" });
      dayCol.style.height = `${gridHeight}px`;

      // Gridlines
      for (let h = hourRange.minHour; h <= hourRange.maxHour; h++) {
        const line = dayCol.createEl("div", { cls: "fmo-calendar-gridline" });
        line.style.top = `${(h - hourRange.minHour) * WEEK_GRID_PX_PER_HOUR}px`;
      }

      // Entry blocks
      for (const e of dayEntries[d]) {
        this.renderEntryBlock(dayCol, e, colorMap, hourRange.minHour, WEEK_GRID_PX_PER_HOUR, dayMs);
      }

      // Day total
      const total = dayEntries[d].reduce((s, e) => s + e.entry.durationMinutes * 60, 0);
      col.createEl("div", {
        cls: "fmo-calendar-day-total",
        text: total > 0 ? this.plugin.formatShortDuration(total) : ""
      });
    }
  }

  private renderSummaryTable(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>
  ): void {
    const secondsByPath = new Map<string, number>();
    const basenameByPath = new Map<string, string>();
    let grandTotal = 0;

    for (const e of entries) {
      const seconds = e.entry.durationMinutes * 60;
      secondsByPath.set(e.path, (secondsByPath.get(e.path) ?? 0) + seconds);
      basenameByPath.set(e.path, e.basename);
      grandTotal += seconds;
    }

    const sorted = [...secondsByPath.entries()].sort((a, b) => b[1] - a[1]);
    const table = containerEl.createEl("div", { cls: "fmo-calendar-summary" });

    for (const [path, seconds] of sorted) {
      const row = table.createEl("div", { cls: "fmo-calendar-summary-row" });
      const dot = row.createEl("span", { cls: "fmo-calendar-color-dot" });
      dot.style.backgroundColor = colorMap.get(path) ?? CALENDAR_COLORS[0];

      const link = row.createEl("a", {
        cls: "fmo-note-link",
        text: basenameByPath.get(path) ?? path,
        href: "#"
      });
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.plugin.openFile(path);
      });

      row.createEl("span", { cls: "fmo-time-badge", text: this.plugin.formatShortDuration(seconds) });
    }

    const totalRow = table.createEl("div", { cls: "fmo-calendar-summary-row fmo-calendar-summary-total" });
    totalRow.createEl("span", { cls: "fmo-calendar-color-dot" });
    totalRow.createEl("span", { cls: "fmo-calendar-summary-label", text: "Total" });
    totalRow.createEl("span", { cls: "fmo-time-badge", text: this.plugin.formatShortDuration(grandTotal) });
  }
}
