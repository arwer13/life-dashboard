import type { TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_LIFE_DASHBOARD_TIMELINE } from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";

type TimelineEntry = {
  file: TFile;
  name: string;
  segments: Array<{ start: Date; end: Date }>;
};

type Region = {
  startMs: number;
  endMs: number;
  active: boolean;
  heightPx: number;
  yPx: number;
};

const TIMELINE_COLORS = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
  "#9c755f", "#bab0ac"
];

const MIN_REGION_HEIGHT_PX = 40;
const PX_PER_SQRT_DAY = 15;
const GAP_HEIGHT_PX = 72;
const MIN_BAR_HEIGHT_PX = 32;
const BAR_WIDTH_PX = 180;
const BAR_GAP_PX = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

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

    entries.sort((a, b) => {
      const aMin = Math.min(...a.segments.map(s => s.start.getTime()));
      const bMin = Math.min(...b.segments.map(s => s.start.getTime()));
      return aMin - bMin || a.name.localeCompare(b.name);
    });

    const allSegments = entries.flatMap(e => e.segments);
    const regions = this.buildRegions(allSegments);
    if (regions.length === 0) {
      contentEl.createEl("p", { cls: "fmo-empty", text: "No project concerns with date ranges found." });
      return;
    }

    const lanes = this.packLanes(entries);
    this.renderTimeline(contentEl, entries, lanes, regions);
  }

  private collectEntries(): TimelineEntry[] {
    const tasks = this.plugin.getTaskTreeItems();
    const results: TimelineEntry[] = [];

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(now);
    rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);

    for (const task of tasks) {
      const fm = task.frontmatter;
      if (!fm) continue;
      if (!this.matchesFrontmatterFilter(fm, "kind", "project")) continue;

      const starts = this.parseDates(fm["start"]);
      const ends = this.parseDates(fm["end"]);
      if (starts.length === 0 || ends.length === 0 || starts.length !== ends.length) continue;

      const segments: Array<{ start: Date; end: Date }> = [];
      for (let i = 0; i < starts.length; i++) {
        if (ends[i] > starts[i] && starts[i] <= rangeEnd && ends[i] >= now) {
          segments.push({ start: starts[i], end: ends[i] });
        }
      }
      if (segments.length === 0) continue;

      results.push({ file: task.file, name: task.file.basename, segments });
    }

    return results;
  }

  private parseDates(raw: unknown): Date[] {
    if (Array.isArray(raw)) {
      const results: Date[] = [];
      for (const item of raw) {
        const d = this.parseSingleDate(item);
        if (d) results.push(d);
      }
      return results;
    }
    const d = this.parseSingleDate(raw);
    return d ? [d] : [];
  }

  private parseSingleDate(raw: unknown): Date | null {
    if (raw instanceof Date) {
      return isNaN(raw.getTime()) ? null : raw;
    }
    if (typeof raw === "string") {
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  private buildRegions(segments: Array<{ start: Date; end: Date }>): Region[] {
    const tsSet = new Set<number>();
    for (const s of segments) {
      tsSet.add(s.start.getTime());
      tsSet.add(s.end.getTime());
    }
    const sorted = [...tsSet].sort((a, b) => a - b);
    if (sorted.length < 2) return [];

    type Band = { startMs: number; endMs: number; active: boolean };
    const bands: Band[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const bStart = sorted[i];
      const bEnd = sorted[i + 1];
      const active = segments.some(
        s => s.start.getTime() < bEnd && s.end.getTime() > bStart
      );
      bands.push({ startMs: bStart, endMs: bEnd, active });
    }

    // Merge consecutive bands of same type
    const merged: Band[] = [];
    for (const band of bands) {
      const last = merged[merged.length - 1];
      if (last && last.active === band.active) {
        last.endMs = band.endMs;
      } else {
        merged.push({ ...band });
      }
    }

    const regions: Region[] = [];
    let y = 0;
    for (const m of merged) {
      const days = (m.endMs - m.startMs) / DAY_MS;
      const heightPx = m.active
        ? Math.max(MIN_REGION_HEIGHT_PX, PX_PER_SQRT_DAY * Math.sqrt(days))
        : GAP_HEIGHT_PX;
      regions.push({ startMs: m.startMs, endMs: m.endMs, active: m.active, heightPx, yPx: y });
      y += heightPx;
    }

    return regions;
  }

  private dateToY(ms: number, regions: Region[]): number {
    for (const r of regions) {
      if (ms <= r.startMs) return r.yPx;
      if (ms <= r.endMs) {
        const frac = (ms - r.startMs) / (r.endMs - r.startMs);
        return r.yPx + frac * r.heightPx;
      }
    }
    const last = regions[regions.length - 1];
    return last.yPx + last.heightPx;
  }

  private packLanes(entries: TimelineEntry[]): number[] {
    const laneSegments: Array<Array<{ start: number; end: number }>> = [];
    const assignment: number[] = [];

    for (const entry of entries) {
      let placed = false;
      for (let laneIdx = 0; laneIdx < laneSegments.length; laneIdx++) {
        const laneSegs = laneSegments[laneIdx];
        const overlaps = entry.segments.some(es =>
          laneSegs.some(ls => es.start.getTime() < ls.end && es.end.getTime() > ls.start)
        );
        if (!overlaps) {
          for (const seg of entry.segments) {
            laneSegs.push({ start: seg.start.getTime(), end: seg.end.getTime() });
          }
          assignment.push(laneIdx);
          placed = true;
          break;
        }
      }
      if (!placed) {
        laneSegments.push(
          entry.segments.map(s => ({ start: s.start.getTime(), end: s.end.getTime() }))
        );
        assignment.push(laneSegments.length - 1);
      }
    }

    return assignment;
  }

  private renderTimeline(
    container: HTMLElement,
    entries: TimelineEntry[],
    lanes: number[],
    regions: Region[]
  ): void {
    const lastRegion = regions[regions.length - 1];
    const totalHeight = lastRegion.yPx + lastRegion.heightPx;

    // Header
    const allDates = entries.flatMap(e => e.segments.flatMap(s => [s.start, s.end]));
    const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));

    const header = container.createEl("div", { cls: "fmo-timeline-header" });
    header.createEl("span", {
      text: `${this.formatMonthYear(minDate)} – ${this.formatMonthYear(maxDate)}`
    });

    // Scrollable wrapper
    const scroll = container.createEl("div", { cls: "fmo-timeline-scroll" });
    const body = scroll.createEl("div", { cls: "fmo-timeline-body" });
    body.style.height = `${totalHeight}px`;

    const axis = body.createEl("div", { cls: "fmo-timeline-axis" });
    const lanesEl = body.createEl("div", { cls: "fmo-timeline-lanes" });

    // Axis labels and grid lines at event boundaries
    const axisDateSet = new Set<number>();
    for (const entry of entries) {
      for (const seg of entry.segments) {
        axisDateSet.add(seg.start.getTime());
        axisDateSet.add(seg.end.getTime());
      }
    }
    const axisDates = [...axisDateSet].sort((a, b) => a - b);

    const MIN_LABEL_GAP_PX = 16;
    let lastLabelY = -Infinity;

    for (const ms of axisDates) {
      const y = this.dateToY(ms, regions);

      const line = lanesEl.createEl("div", { cls: "fmo-timeline-grid-line" });
      line.style.top = `${y}px`;

      if (y - lastLabelY >= MIN_LABEL_GAP_PX) {
        const label = axis.createEl("div", { cls: "fmo-timeline-date-label" });
        label.style.top = `${y}px`;
        label.textContent = this.formatShortDate(new Date(ms));
        lastLabelY = y;
      }
    }

    // Gap indicators on axis
    for (const region of regions) {
      if (!region.active) {
        const gap = axis.createEl("div", { cls: "fmo-timeline-gap" });
        gap.style.top = `${region.yPx}px`;
        gap.style.height = `${region.heightPx}px`;
      }
    }

    // Bars
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const lane = lanes[i];
      const color = TIMELINE_COLORS[i % TIMELINE_COLORS.length];

      for (const seg of entry.segments) {
        const yStart = this.dateToY(seg.start.getTime(), regions);
        const yEnd = this.dateToY(seg.end.getTime(), regions);
        const barHeight = Math.max(MIN_BAR_HEIGHT_PX, yEnd - yStart);

        const bar = lanesEl.createEl("div", { cls: "fmo-timeline-bar" });
        bar.style.top = `${yStart}px`;
        bar.style.height = `${barHeight}px`;
        bar.style.left = `${lane * (BAR_WIDTH_PX + BAR_GAP_PX)}px`;
        bar.style.width = `${BAR_WIDTH_PX}px`;
        bar.style.borderLeftColor = color;
        bar.style.backgroundColor = color + "22";

        bar.createEl("div", {
          cls: "fmo-timeline-bar-name",
          text: entry.name
        });

        bar.addEventListener("click", () => {
          void this.app.workspace.getLeaf("tab").openFile(entry.file);
        });
      }
    }
  }

  private formatMonthYear(d: Date): string {
    return d.toLocaleString("default", { month: "short", year: "numeric" });
  }

  private formatShortDate(d: Date): string {
    const month = d.toLocaleString("default", { month: "short" });
    const day = String(d.getDate()).padStart(2, "0");
    return `${month} ${day}`;
  }

}
