import type { TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_LIFE_DASHBOARD_TIMELINE } from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";

type TimelineEntry = {
  file: TFile;
  name: string;
  start: Date;
  end: Date;
};

const TIMELINE_COLORS = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
  "#9c755f", "#bab0ac"
];

export class LifeDashboardTimelineView extends LifeDashboardBaseView {
  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_TIMELINE;
  }

  getDisplayText(): string {
    return "Timeline";
  }

  getIcon(): string {
    return "gantt-chart";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const entries = this.collectEntries();
    if (entries.length === 0) {
      contentEl.createEl("p", { cls: "fmo-empty", text: "No project concerns with date ranges found." });
      return;
    }

    const rangeStart = new Date();
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);

    const visible = entries.filter(
      (e) => e.start <= rangeEnd && e.end >= rangeStart
    );

    if (visible.length === 0) {
      contentEl.createEl("p", { cls: "fmo-empty", text: "No project concerns in the next year." });
      return;
    }

    visible.sort((a, b) => a.start.getTime() - b.start.getTime() || a.name.localeCompare(b.name));

    const lanes = this.packLanes(visible);
    this.renderTimeline(contentEl, visible, lanes, rangeStart, rangeEnd);
  }

  private collectEntries(): TimelineEntry[] {
    const tasks = this.plugin.getTaskTreeItems();
    const results: TimelineEntry[] = [];

    for (const task of tasks) {
      const fm = task.frontmatter;
      if (!fm) continue;
      if (!this.matchesFrontmatterFilter(fm, "kind", "project")) continue;

      const startRaw = fm["start"];
      const endRaw = fm["end"];
      if (typeof startRaw !== "string" || typeof endRaw !== "string") continue;

      const start = this.parseDate(startRaw);
      const end = this.parseDate(endRaw);
      if (!start || !end || end <= start) continue;

      results.push({ file: task.file, name: task.file.basename, start, end });
    }

    return results;
  }

  private parseDate(raw: string): Date | null {
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (isNaN(d.getTime())) return null;
    return d;
  }

  private packLanes(entries: TimelineEntry[]): number[] {
    const laneEnds: number[] = [];
    const assignment: number[] = [];

    for (const entry of entries) {
      let placed = false;
      for (let i = 0; i < laneEnds.length; i++) {
        if (entry.start.getTime() >= laneEnds[i]) {
          laneEnds[i] = entry.end.getTime();
          assignment.push(i);
          placed = true;
          break;
        }
      }
      if (!placed) {
        laneEnds.push(entry.end.getTime());
        assignment.push(laneEnds.length - 1);
      }
    }

    return assignment;
  }

  private renderTimeline(
    container: HTMLElement,
    entries: TimelineEntry[],
    lanes: number[],
    rangeStart: Date,
    rangeEnd: Date
  ): void {
    const totalMs = rangeEnd.getTime() - rangeStart.getTime();
    const laneCount = Math.max(...lanes) + 1;

    // Header
    const header = container.createEl("div", { cls: "fmo-timeline-header" });
    header.createEl("span", {
      text: `${this.formatMonthYear(rangeStart)} – ${this.formatMonthYear(rangeEnd)}`
    });

    // Body: axis + lanes
    const body = container.createEl("div", { cls: "fmo-timeline-body" });

    // Month axis
    const axis = body.createEl("div", { cls: "fmo-timeline-axis" });

    // Lanes container
    const lanesEl = body.createEl("div", { cls: "fmo-timeline-lanes" });

    // Render month grid lines and axis labels
    const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
    while (cursor <= rangeEnd) {
      const pct = ((cursor.getTime() - rangeStart.getTime()) / totalMs) * 100;

      if (pct >= 0 && pct <= 100) {
        // Axis label
        const label = axis.createEl("div", { cls: "fmo-timeline-month-label" });
        label.style.top = `${pct}%`;
        label.textContent = cursor.toLocaleString("default", { month: "short" });

        // Grid line
        const line = lanesEl.createEl("div", { cls: "fmo-timeline-grid-line" });
        line.style.top = `${pct}%`;
      }

      cursor.setMonth(cursor.getMonth() + 1);
    }

    // Render bars
    const laneWidthPct = 100 / laneCount;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const lane = lanes[i];
      const color = TIMELINE_COLORS[i % TIMELINE_COLORS.length];

      const clampedStart = Math.max(entry.start.getTime(), rangeStart.getTime());
      const clampedEnd = Math.min(entry.end.getTime(), rangeEnd.getTime());

      const topPct = ((clampedStart - rangeStart.getTime()) / totalMs) * 100;
      const heightPct = ((clampedEnd - clampedStart) / totalMs) * 100;

      const bar = lanesEl.createEl("div", { cls: "fmo-timeline-bar" });
      bar.style.top = `${topPct}%`;
      bar.style.height = `${heightPct}%`;
      bar.style.left = `${lane * laneWidthPct}%`;
      bar.style.width = `${laneWidthPct}%`;
      bar.style.borderLeftColor = color;
      bar.style.backgroundColor = color + "22";

      bar.createEl("div", {
        cls: "fmo-timeline-bar-date",
        text: this.formatDate(entry.start)
      });
      bar.createEl("div", {
        cls: "fmo-timeline-bar-name",
        text: entry.name
      });
      bar.createEl("div", {
        cls: "fmo-timeline-bar-date fmo-timeline-bar-date-end",
        text: this.formatDate(entry.end)
      });

      bar.addEventListener("click", () => {
        void this.app.workspace.getLeaf("tab").openFile(entry.file);
      });
    }
  }

  private formatMonthYear(d: Date): string {
    return d.toLocaleString("default", { month: "short", year: "numeric" });
  }

  private formatDate(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }
}
