import type { TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_LIFE_DASHBOARD_TIMELINE, DASHBOARD_COLORS, DAY_MS } from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";

type TimelineEntry = {
  file: TFile;
  segments: Array<{ start: Date; end: Date }>;
};

type Region = {
  startMs: number;
  endMs: number;
  active: boolean;
  heightPx: number;
  yPx: number;
};

const PX_PER_SQRT_DAY = 15;
const GAP_MIN_HEIGHT_PX = 40;
const GAP_MAX_HEIGHT_PX = GAP_MIN_HEIGHT_PX * 3;
const MIN_BAR_HEIGHT_PX = 32;
const BAR_WIDTH_PX = 180;
const BAR_GAP_PX = 6;
const LABEL_HEIGHT_PX = 16;
const PADDING_PX = 20;

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

    // Precompute sort keys
    const minStarts = new Map<TimelineEntry, number>();
    for (const e of entries) {
      minStarts.set(e, Math.min(...e.segments.map(s => s.start.getTime())));
    }
    entries.sort((a, b) =>
      minStarts.get(a)! - minStarts.get(b)! || a.file.basename.localeCompare(b.file.basename)
    );

    const allSegments = entries.flatMap(e => e.segments);
    const regions = this.buildRegions(allSegments);
    if (regions.length === 0) return;

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

      results.push({ file: task.file, segments });
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

    // Merge only consecutive INACTIVE bands; keep active bands fine-grained
    const merged: Band[] = [];
    for (const band of bands) {
      const last = merged[merged.length - 1];
      if (last && !last.active && !band.active) {
        last.endMs = band.endMs;
      } else {
        merged.push({ ...band });
      }
    }

    // Compute proportional gap heights
    const gapDays = merged.filter(m => !m.active).map(m => (m.endMs - m.startMs) / DAY_MS);
    const minGapDays = gapDays.length > 0 ? Math.min(...gapDays) : 0;
    const maxGapDays = gapDays.length > 0 ? Math.max(...gapDays) : 0;
    const gapDaysRange = maxGapDays - minGapDays;

    const regions: Region[] = [];
    let y = PADDING_PX;
    for (const m of merged) {
      const days = (m.endMs - m.startMs) / DAY_MS;
      let heightPx: number;
      if (m.active) {
        heightPx = Math.max(2 * LABEL_HEIGHT_PX + 4, PX_PER_SQRT_DAY * Math.sqrt(days));
      } else {
        const t = gapDaysRange > 0 ? (days - minGapDays) / gapDaysRange : 0;
        heightPx = GAP_MIN_HEIGHT_PX + t * (GAP_MAX_HEIGHT_PX - GAP_MIN_HEIGHT_PX);
      }
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
    const totalHeight = lastRegion.yPx + lastRegion.heightPx + PADDING_PX;

    // Single pass: collect min/max dates and start/end sets
    const startDates = new Set<number>();
    const endDates = new Set<number>();
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const entry of entries) {
      for (const seg of entry.segments) {
        const sMs = seg.start.getTime();
        const eMs = seg.end.getTime();
        startDates.add(sMs);
        endDates.add(eMs);
        if (sMs < minMs) minMs = sMs;
        if (eMs > maxMs) maxMs = eMs;
      }
    }

    // Header
    const header = container.createEl("div", { cls: "fmo-timeline-header" });
    header.createEl("span", {
      text: `${this.formatMonthYear(new Date(minMs))} – ${this.formatMonthYear(new Date(maxMs))}`
    });

    // Scrollable wrapper
    const scroll = container.createEl("div", { cls: "fmo-timeline-scroll" });
    const body = scroll.createEl("div", { cls: "fmo-timeline-body" });
    body.style.height = `${totalHeight}px`;

    const axis = body.createEl("div", { cls: "fmo-timeline-axis" });
    const lanesEl = body.createEl("div", { cls: "fmo-timeline-lanes" });

    // Axis labels and grid lines
    const axisDates = [...new Set([...startDates, ...endDates])].sort((a, b) => a - b);
    const laneCount = Math.max(...lanes) + 1;
    const lanesWidthPx = laneCount * (BAR_WIDTH_PX + BAR_GAP_PX);

    const renderedBounds: Array<[number, number]> = [];

    for (const ms of axisDates) {
      const y = this.dateToY(ms, regions);

      const line = lanesEl.createEl("div", { cls: "fmo-timeline-grid-line" });
      line.style.top = `${y}px`;
      line.style.width = `${lanesWidthPx}px`;

      const isStart = startDates.has(ms);
      const isEnd = endDates.has(ms);

      let visualTop: number;
      let visualBottom: number;
      let alignCls: string;
      if (isStart && isEnd) {
        alignCls = "fmo-timeline-date-label-mid";
        visualTop = y - LABEL_HEIGHT_PX / 2;
        visualBottom = y + LABEL_HEIGHT_PX / 2;
      } else if (isEnd) {
        alignCls = "fmo-timeline-date-label-end";
        visualTop = y - LABEL_HEIGHT_PX;
        visualBottom = y;
      } else {
        alignCls = "fmo-timeline-date-label-start";
        visualTop = y;
        visualBottom = y + LABEL_HEIGHT_PX;
      }

      const overlaps = renderedBounds.some(
        ([t, b]) => visualTop < b + 2 && visualBottom > t - 2
      );
      if (!overlaps) {
        const label = axis.createEl("div", { cls: `fmo-timeline-date-label ${alignCls}` });
        label.style.top = `${y}px`;
        label.textContent = this.formatShortDate(new Date(ms));
        renderedBounds.push([visualTop, visualBottom]);
      }
    }

    // Gap indicators — "..." on axis, day count in lanes area
    for (const region of regions) {
      if (!region.active) {
        const skippedDays = Math.round((region.endMs - region.startMs) / DAY_MS);

        const axisGap = axis.createEl("div", { cls: "fmo-timeline-gap" });
        axisGap.style.top = `${region.yPx}px`;
        axisGap.style.height = `${region.heightPx}px`;
        axisGap.textContent = "···";

        const laneGap = lanesEl.createEl("div", { cls: "fmo-timeline-gap-label" });
        laneGap.style.top = `${region.yPx}px`;
        laneGap.style.height = `${region.heightPx}px`;
        laneGap.style.width = `${lanesWidthPx}px`;
        laneGap.textContent = `${skippedDays}d`;
      }
    }

    // Bars
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const lane = lanes[i];
      const color = DASHBOARD_COLORS[i % DASHBOARD_COLORS.length];

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

        const days = Math.round((seg.end.getTime() - seg.start.getTime()) / DAY_MS) + 1;
        bar.createEl("div", {
          cls: "fmo-timeline-bar-name",
          text: `[${days}d] ${entry.file.basename}`
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
