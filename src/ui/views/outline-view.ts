import {
  Modal,
  SearchComponent,
  setTooltip
} from "obsidian";
import { DISPLAY_VERSION } from "../../version";
import type { TaskItem, TaskTreeNode } from "../../models/types";
import { isInlineItem } from "../../models/types";
import { buildParentPathMap, collectPathsWithParents } from "../../services/task-tree-builder";
import {
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  OUTLINE_RANGE_OPTIONS,
  OUTLINE_SORT_OPTIONS,
  MIN_TRACKED_SECONDS_PER_PERIOD,
  CLOSED_FILTER_QUERY,
  type OutlineSortMode,
  type TreeRenderState
} from "../../models/view-types";
import type { OutlineTimeRange } from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";
import {
  getItemPriorityBadge,
  handlePriorityHotkey
} from "../../services/priority-utils";
import {
  createTreeToggleSpacer,
  isTreeToggleExpanded,
  setTreeToggleState
} from "../tree-toggle";

type RecencySection = { label: string; matchedPaths: Set<string> };

export class LifeDashboardOutlineView extends LifeDashboardBaseView {
  private outlineExpandAll = true;
  private outlineStatusDoneFilterEnabled = false;
  private outlineShowClosed = false;
  private outlineTimeRange: OutlineTimeRange = "todayYesterday";
  private outlineShowOnlyTrackedThisPeriod = true;
  private outlineSortMode: OutlineSortMode = "recent";
  private outlineShowParents = true;
  private hoveredConcernPath: string | null = null;
  private keydownRegistered = false;

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_OUTLINE;
  }

  getDisplayText(): string {
    return "Concerns outline";
  }

  getIcon(): string {
    return "list-tree";
  }

  async onOpen(): Promise<void> {
    this.ensurePriorityHotkeyListener();
    await this.render();
  }

  async onClose(): Promise<void> {
    this.hoveredConcernPath = null;
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    const scrollEl = this.getOutlineScrollContainer();
    const scrollTop = scrollEl?.scrollTop ?? 0;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const tasks = this.plugin.getTaskTreeItems();
    this.renderOutline(contentEl, tasks);
    if (scrollEl) {
      scrollEl.scrollTop = scrollTop;
    }
  }

  private renderOutline(contentEl: HTMLElement, tasks: TaskItem[]): void {
    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const prop = this.plugin.settings.propertyName.trim();
    const value = this.plugin.settings.propertyValue.trim();
    const persistedFilter = this.plugin.getOutlineFilterQuery();

    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concerns outline" });
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
    });
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
    });
    showParentsInput.checked = this.outlineShowParents;
    showParentsRow.createEl("span", { text: "Show parents" });
    setTooltip(showParentsRow, "Include matching concerns' parents and group siblings under shared parents.");

    const showClosedRow = controlsRow.createEl("label", { cls: "fmo-outline-tracked-only-row" });
    const showClosedInput = showClosedRow.createEl("input", {
      cls: "fmo-outline-tracked-only-input",
      attr: { type: "checkbox" }
    });
    showClosedInput.checked = this.outlineShowClosed;
    showClosedRow.createEl("span", { text: "Show closed" });
    setTooltip(showClosedRow, `When off: ${CLOSED_FILTER_QUERY}`);

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
      text: "Done",
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
    const parentByPath = buildParentPathMap(tasks, (raw, src) => this.resolveParentPath(raw, src));
    const renderFilteredOutline = (query: string): void => {
      outlineBody.empty();
      this.hoveredConcernPath = null;

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
            (item) => (ownSecondsByPath.get(item.path) ?? 0) >= MIN_TRACKED_SECONDS_PER_PERIOD
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
          item.path,
          latestTrackedStartForPath(item.path)
        );
      }
      const sections = this.groupMatchedPathsByRecencyBucket(matched, latestMatchedStartByPath);
      for (const section of sections) {
        if (section.matchedPaths.size === 0) continue;

        const visiblePaths = this.outlineShowParents
          ? collectPathsWithParents(section.matchedPaths, parentByPath)
          : section.matchedPaths;
        const visibleTasks = tasks.filter((item) => visiblePaths.has(item.path));
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

    showClosedInput.addEventListener("change", () => {
      this.outlineShowClosed = showClosedInput.checked;
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
      setTooltip(button, this.plugin.timeData.getTimeRangeDescription(option.value));

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
      if (isInlineItem(item)) {
        ownSecondsByPath.set(item.path, 0);
        continue;
      }
      ownSecondsByPath.set(
        item.path,
        this.plugin.timeData.getTrackedSecondsForRange(item.path, range)
      );
    }
    return ownSecondsByPath;
  }

  private withButtonFilters(query: string): string {
    let result = query.trim();
    if (this.outlineStatusDoneFilterEnabled) {
      result = result.length > 0 ? `${result} prop:status=done` : "prop:status=done";
    }
    if (!this.outlineShowClosed) {
      result = result.length > 0 ? `${result} ${CLOSED_FILTER_QUERY}` : CLOSED_FILTER_QUERY;
    }
    return result;
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

      const latest = this.plugin.timeData.getLatestTrackedStartMsForRange(path, range);
      cached.set(path, latest);
      return latest;
    };
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
    const todayStart = this.plugin.timeData.getDayStart(now).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
    const weekStart = this.plugin.timeData.getWeekStart(now).getTime();

    for (const item of matched) {
      const latest = latestMatchedStartByPath.get(item.path) ?? 0;
      if (latest >= todayStart) {
        groups[0].matchedPaths.add(item.path);
      } else if (latest >= yesterdayStart) {
        groups[1].matchedPaths.add(item.path);
      } else if (latest >= weekStart) {
        groups[2].matchedPaths.add(item.path);
      } else {
        groups[3].matchedPaths.add(item.path);
      }
    }

    return groups;
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
    modal.setTitle("Outline filter format");

    const body = modal.contentEl.createEl("div", { cls: "fmo-filter-help" });
    // eslint-disable-next-line obsidianmd/ui/sentence-case
    body.createEl("p", { text: "Terms are combined with AND (all terms must match)." });

    const list = body.createEl("ul");
    /* eslint-disable obsidianmd/ui/sentence-case -- filter syntax examples */
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
    /* eslint-enable obsidianmd/ui/sentence-case */

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

    const isInline = isInlineItem(node.item);
    const li = containerEl.createEl("li", { cls: "fmo-tree-item" });
    const isParentOnly = !state.matchedPaths.has(node.path);
    const rowCls = [
      "fmo-tree-row",
      isParentOnly ? "fmo-tree-row-parent" : ""
    ].filter(Boolean).join(" ");
    const row = li.createEl("div", { cls: rowCls });
    row.addEventListener("mouseenter", () => {
      this.hoveredConcernPath = node.path;
    });
    row.addEventListener("mouseleave", () => {
      if (this.hoveredConcernPath === node.path) {
        this.hoveredConcernPath = null;
      }
    });

    const total = state.cumulativeSeconds.get(node.path) ?? 0;
    const own = state.ownSeconds.get(node.path) ?? 0;

    let childrenList: HTMLElement | null = null;
    const onlyInlineChildren = node.children.length > 0
      && node.children.every((child) => isInlineItem(child.item));
    if (node.children.length > 0) {
      const isExpanded = onlyInlineChildren ? false : Boolean(state.expandAll);
      const toggle = row.createEl("button", {
        cls: "fmo-tree-toggle",
        attr: {
          type: "button"
        }
      });
      setTreeToggleState(toggle, isExpanded, node.item.basename);

      toggle.addEventListener("click", () => {
        const next = !isTreeToggleExpanded(toggle);
        setTreeToggleState(toggle, next, node.item.basename);
        if (childrenList) {
          childrenList.hidden = !next;
        }
      });

      childrenList = li.createEl("ul", { cls: "fmo-tree fmo-tree-children" });
      childrenList.hidden = !isExpanded;
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
        attr: {
          title: `Priority: ${priorityBadge}`
        }
      });
    }

    if (!isInline) {
      row.createEl("span", {
        cls: "fmo-time-badge",
        text: this.plugin.timeData.formatShortDuration(total),
        attr: {
          title: `Own: ${this.plugin.timeData.formatShortDuration(own)} | Total (with children): ${this.plugin.timeData.formatShortDuration(total)}`
        }
      });
    }

    if (childrenList) {
      for (const child of node.children) {
        this.renderTreeNode(childrenList, child, state, nextAncestry);
      }
    }
  }

  private ensurePriorityHotkeyListener(): void {
    if (this.keydownRegistered) return;
    this.keydownRegistered = true;
    this.registerDomEvent(document, "keydown", (event) => {
      handlePriorityHotkey(event, this.hoveredConcernPath, {
        onReparent: (path) => this.plugin.reparentConcernInteractive(path),
        onPriorityDigit: (path, digit) => void this.applyHoveredPriority(path, digit),
        onPriorityClear: (path) => void this.clearHoveredPriority(path),
      });
    });
  }

  private async applyHoveredPriority(path: string, digit: string): Promise<void> {
    const changed = await this.plugin.setPriorityForPath(path, digit);
    if (!changed) return;
    await this.render();
  }

  private async clearHoveredPriority(path: string): Promise<void> {
    const changed = await this.plugin.clearPriorityForPath(path);
    if (!changed) return;
    await this.render();
  }

  private getOutlineScrollContainer(): HTMLElement | null {
    return this.contentEl.closest(".view-content");
  }
}
