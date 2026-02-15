import {
  Modal,
  SearchComponent,
  setTooltip,
  type WorkspaceLeaf
} from "obsidian";
import { DISPLAY_VERSION } from "../../version";
import type { TaskItem, TaskTreeNode } from "../../models/types";
import {
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  OUTLINE_RANGE_OPTIONS,
  OUTLINE_SORT_OPTIONS,
  MIN_TRACKED_SECONDS_PER_PERIOD,
  type OutlineSortMode,
  type TreeRenderState
} from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import type { OutlineTimeRange } from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";

type RecencySection = { label: string; matchedPaths: Set<string> };

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
