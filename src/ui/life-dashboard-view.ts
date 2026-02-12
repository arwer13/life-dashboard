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
import type { TaskTreeNode, TaskItem } from "../models/types";
import { TaskSelectModal } from "./task-select-modal";
import type LifeDashboardPlugin from "../plugin";
import type { OutlineTimeRange } from "../plugin";

export const VIEW_TYPE_LIFE_DASHBOARD = "life-dashboard-view";
type TaskTreeData = {
  roots: TaskTreeNode[];
  cumulativeSeconds: Map<string, number>;
  ownSeconds: Map<string, number>;
  nodesByPath: Map<string, TaskTreeNode>;
};
type OutlineFilterToken =
  | { key: "any" | "path" | "file"; value: string; negated: boolean }
  | { key: "prop"; prop: string; value: string | null; negated: boolean };
const MIN_TRACKED_SECONDS_PER_PERIOD = 60;
const OUTLINE_RANGE_OPTIONS: Array<{ value: OutlineTimeRange; label: string }> = [
  { value: "today", label: "today" },
  { value: "week", label: "this week" },
  { value: "month", label: "this month" },
  { value: "all", label: "all time" }
];
const TRACKING_ADJUST_MINUTES = 5;

export class LifeDashboardView extends ItemView {
  private readonly plugin: LifeDashboardPlugin;
  private liveTimerEl: HTMLElement | null = null;
  private outlineExpandAll = false;
  private outlineStatusDoneFilterEnabled = false;
  private outlineTimeRange: OutlineTimeRange = "all";
  private outlineShowOnlyTrackedThisPeriod = false;

  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD;
  }

  getDisplayText(): string {
    return "Life Dashboard";
  }

  getIcon(): string {
    return "list-tree";
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
    this.renderOutline(contentEl, tasks);

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
      const fallback = block.createEl("div", { cls: "fmo-selected-card" });
      const row = fallback.createEl("div", { cls: "fmo-selected-main" });
      row.createEl("span", { cls: "fmo-dot", text: "" });
      const label = row.createEl("a", { cls: "fmo-note-link", href: "#", text: activeTaskFile.basename });
      label.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.plugin.openFile(activeTaskFile.path);
      });
      fallback.createEl("div", { cls: "fmo-selected-sub", text: activeTaskFile.path });
      fallback.createEl("div", {
        cls: "fmo-selected-sub",
        text: "Task is outside current filter."
      });
      this.renderChangeTaskButton(fallback, tasks);
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

  private buildTrackedContextChain(
    node: TaskTreeNode,
    nodesByPath: Map<string, TaskTreeNode>
  ): TaskTreeNode[] {
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

    const trackedOnlyRow = header.createEl("label", { cls: "fmo-outline-tracked-only-row" });
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
    setTooltip(
      toggleDoneFilterBtn,
      this.getDoneFilterTooltip()
    );

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

    header.createEl("div", {
      cls: "fmo-subheader",
      text: value.length > 0 ? `Filter: ${prop} = ${value}` : `Filter: has property \"${prop}\"`
    });

    const outlineBody = contentEl.createEl("div", { cls: "fmo-outline-body" });
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
      const filtered = this.outlineShowOnlyTrackedThisPeriod
        ? textFiltered.filter(
            (item) => (ownSecondsByPath.get(item.file.path) ?? 0) >= MIN_TRACKED_SECONDS_PER_PERIOD
          )
        : textFiltered;

      if (!filtered.length) {
        outlineBody.createEl("p", {
          cls: "fmo-empty",
          text: "No matching concerns found for current filter."
        });
        return;
      }

      const tree = this.buildTaskTree(filtered, (path) => ownSecondsByPath.get(path) ?? 0);
      const rootList = outlineBody.createEl("ul", { cls: "fmo-tree" });
      for (const root of tree.roots) {
        this.renderTreeNode(
          rootList,
          root,
          tree.cumulativeSeconds,
          tree.ownSeconds,
          new Set(),
          this.outlineExpandAll
        );
      }
    };

    toggleExpandBtn.addEventListener("click", () => {
      this.outlineExpandAll = !this.outlineExpandAll;
      toggleExpandBtn.setText(this.outlineExpandAll ? "−" : "+");
      toggleExpandBtn.setAttribute(
        "aria-label",
        this.getExpandAllTooltip()
      );
      setTooltip(toggleExpandBtn, this.getExpandAllTooltip());
      renderFilteredOutline(filter.getValue());
    });

    toggleDoneFilterBtn.addEventListener("click", () => {
      this.outlineStatusDoneFilterEnabled = !this.outlineStatusDoneFilterEnabled;
      toggleDoneFilterBtn.toggleClass("fmo-outline-filter-btn-active", this.outlineStatusDoneFilterEnabled);
      setTooltip(
        toggleDoneFilterBtn,
        this.getDoneFilterTooltip()
      );
      renderFilteredOutline(filter.getValue());
    });

    trackedOnlyInput.addEventListener("change", () => {
      this.outlineShowOnlyTrackedThisPeriod = trackedOnlyInput.checked;
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

  private getOwnSecondsByPath(
    tasks: TaskItem[],
    range: OutlineTimeRange
  ): Map<string, number> {
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
    const tokens = this.parseOutlineFilterTokens(query);
    if (tokens.length === 0) return tasks;

    return tasks.filter((item) => this.taskMatchesOutlineFilter(item, tokens));
  }

  private parseOutlineFilterTokens(query: string): OutlineFilterToken[] {
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

  private taskMatchesOutlineFilter(
    task: TaskItem,
    tokens: OutlineFilterToken[]
  ): boolean {
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

  private buildTaskTree(tasks: TaskItem[], ownSecondsForPath?: (path: string) => number): TaskTreeData {
    const resolveOwnSeconds = ownSecondsForPath ?? ((path: string) => this.plugin.getTrackedSeconds(path));
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

    const sortNodes = (nodes: TaskTreeNode[]): void => {
      nodes.sort((a, b) => a.item.file.path.localeCompare(b.item.file.path));
      for (const node of nodes) {
        sortNodes(node.children);
      }
    };

    const roots = Array.from(nodesByPath.values()).filter((node) => !node.parentPath);
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
      const file = this.app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
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

  private renderTreeNode(
    containerEl: HTMLElement,
    node: TaskTreeNode,
    cumulativeSeconds: Map<string, number>,
    ownSeconds: Map<string, number>,
    ancestry: Set<string>,
    expandAll: boolean
  ): void {
    if (ancestry.has(node.path)) return;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.path);

    const li = containerEl.createEl("li", { cls: "fmo-tree-item" });
    const row = li.createEl("div", { cls: "fmo-tree-row" });

    const total = cumulativeSeconds.get(node.path) ?? 0;
    const own = ownSeconds.get(node.path) ?? 0;

    let childrenList: HTMLElement | null = null;
    if (node.children.length > 0) {
      const isExpanded = expandAll;
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
      cls: "fmo-note-link",
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
        this.renderTreeNode(childrenList, child, cumulativeSeconds, ownSeconds, nextAncestry, expandAll);
      }
    }
  }
}
