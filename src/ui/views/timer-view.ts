import { TFile, setTooltip } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../../models/types";
import { VIEW_TYPE_LIFE_DASHBOARD_TIMER, type TaskTreeData } from "../../models/view-types";
import { LifeDashboardBaseView } from "./base-view";

const TRACKING_ADJUST_MINUTES = 5;

export class LifeDashboardTimerView extends LifeDashboardBaseView {
  private liveTimerEl: HTMLElement | null = null;

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_TIMER;
  }

  getDisplayText(): string {
    return "Life timer";
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
    this.liveTimerEl.setText(this.plugin.timeData.formatClockDuration(this.plugin.getCurrentElapsedSeconds()));
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
      text: this.plugin.timeData.formatClockDuration(this.plugin.getCurrentElapsedSeconds())
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
    const summary = this.plugin.timeData.getConcernPeriodSummary(taskPath);
    const box = containerEl.createEl("div", { cls: "fmo-today-entries" });

    const totals = box.createEl("div", { cls: "fmo-period-totals" });
    this.renderPeriodTotalRow(totals, "This week", summary.weekSeconds, "week");
    this.renderPeriodTotalRow(totals, "Yesterday", summary.yesterdaySeconds, "yesterday");

    const todayTitle = box.createEl("div", {
      cls: "fmo-today-entries-title",
      text: `Today (${this.plugin.timeData.formatShortDuration(summary.todaySeconds)}):`
    });
    setTooltip(todayTitle, this.plugin.timeData.getTimeRangeDescription("today"));

    if (summary.todayEntries.length > 0) {
      const list = box.createEl("div", { cls: "fmo-today-entries-list" });
      for (const entry of summary.todayEntries) {
        const entryEl = list.createEl("div", {
          cls: "fmo-today-entry fmo-today-entry-clickable",
          text: entry.label
        });
        entryEl.addEventListener("click", () => {
          this.plugin.highlightedTimeLogStartMs = entry.startMs;
          void this.plugin.activateTimeLogView();
        });
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
      text: this.plugin.timeData.formatShortDuration(seconds)
    });
    setTooltip(row, this.plugin.timeData.getTimeRangeDescription(range));
  }

  private renderTrackedContext(panel: HTMLElement, tasks: TaskItem[], tree: TaskTreeData): void {
    const block = panel.createEl("div", { cls: "fmo-context-block" });

    const activeTaskPath = this.plugin.getActiveTaskPath();
    if (!activeTaskPath) {
      block.createEl("div", { cls: "fmo-selected-sub", text: "No task selected" });
      this.renderChangeTaskButton(block);
      return;
    }

    const activeTaskFile = this.plugin.app.vault.getAbstractFileByPath(activeTaskPath);
    if (!(activeTaskFile instanceof TFile)) {
      block.createEl("div", { cls: "fmo-selected-sub", text: "Selected task note was not found" });
      this.renderChangeTaskButton(block);
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
          this.renderChangeTaskButton(row);
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
        text: node.item.basename,
        href: "#"
      });
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.plugin.openFile(node.item.path);
      });

      if (isTracked) {
        this.renderChangeTaskButton(row);
      }

      const total = tree.cumulativeSeconds.get(node.path) ?? 0;
      const own = tree.ownSeconds.get(node.path) ?? 0;
      row.createEl("span", {
        cls: "fmo-time-badge fmo-context-time-badge",
        text: this.plugin.timeData.formatShortDuration(total),
        attr: {
          title: `Own: ${this.plugin.timeData.formatShortDuration(own)} | Total (with children): ${this.plugin.timeData.formatShortDuration(total)}`
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
        console.error("[life-dashboard] Parent cycle detected while building task context:", current.path);
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
        console.error("[life-dashboard] Parent cycle detected while building fallback task context:", current.path);
        break;
      }

      visited.add(current.path);
      chain.push(current);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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

  private renderChangeTaskButton(containerEl: HTMLElement): void {
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
      this.plugin.openConcernQuickSearch({
        onChoose: (file) => {
          void this.plugin.setSelectedTaskPath(file.path);
        }
      });
    });
  }
}
