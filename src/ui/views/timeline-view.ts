import type { App, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_LIFE_DASHBOARD_TIMELINE, DASHBOARD_COLORS, DAY_MS } from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import { matchesFrontmatterFilter } from "../../services/outline-filter";
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
const LABEL_OVERLAP_PAD_PX = 2;
const MIN_BAND_HEIGHT_PX = 2 * LABEL_HEIGHT_PX + LABEL_OVERLAP_PAD_PX * 2;
const PADDING_PX = 20;
const BAR_BG_ALPHA = "22";

// ── Standalone rendering (used by both view and code block processor) ──

export function renderTimelineInto(container: HTMLElement, plugin: LifeDashboardPlugin): void {
  const entries = collectEntries(plugin);
  if (entries.length === 0) {
    container.createEl("p", { cls: "fmo-empty", text: "No project concerns with date ranges found." });
    return;
  }

  const minStarts = new Map<TimelineEntry, number>();
  for (const e of entries) {
    minStarts.set(e, Math.min(...e.segments.map(s => s.start.getTime())));
  }
  entries.sort((a, b) =>
    minStarts.get(a)! - minStarts.get(b)! || a.file.basename.localeCompare(b.file.basename)
  );

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayMs = now.getTime();

  const allSegments = entries.flatMap(e => e.segments);
  const regions = buildRegions(allSegments, todayMs);
  if (regions.length === 0) return;

  const lanes = packLanes(entries);
  renderTimelineDOM(container, entries, lanes, regions, plugin.app, todayMs);
}

// ── View class (thin wrapper) ──

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
    this.contentEl.empty();
    this.contentEl.addClass("frontmatter-outline-view");
    renderTimelineInto(this.contentEl, this.plugin);
  }
}

// ── Data collection ──

function collectEntries(plugin: LifeDashboardPlugin): TimelineEntry[] {
  const tasks = plugin.getTaskTreeItems();
  const results: TimelineEntry[] = [];

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(now);
  rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);

  for (const task of tasks) {
    const fm = task.frontmatter;
    if (!fm) continue;
    if (!matchesFrontmatterFilter(fm, "kind", "project")) continue;

    const starts = parseDates(fm["start"]);
    const ends = parseDates(fm["end"]);
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

function parseDates(raw: unknown): Date[] {
  if (Array.isArray(raw)) {
    const results: Date[] = [];
    for (const item of raw) {
      const d = parseSingleDate(item);
      if (d) results.push(d);
    }
    return results;
  }
  const d = parseSingleDate(raw);
  return d ? [d] : [];
}

function parseSingleDate(raw: unknown): Date | null {
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

// ── Layout computation ──

function buildRegions(segments: Array<{ start: Date; end: Date }>, todayMs: number): Region[] {
  const tsSet = new Set<number>();
  tsSet.add(todayMs);
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

  const merged: Band[] = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && !last.active && !band.active) {
      last.endMs = band.endMs;
    } else {
      merged.push({ ...band });
    }
  }

  let minGapDays = Infinity;
  let maxGapDays = -Infinity;
  for (const m of merged) {
    if (m.active) continue;
    const d = (m.endMs - m.startMs) / DAY_MS;
    if (d < minGapDays) minGapDays = d;
    if (d > maxGapDays) maxGapDays = d;
  }
  if (!isFinite(minGapDays)) minGapDays = 0;
  if (!isFinite(maxGapDays)) maxGapDays = 0;
  const gapDaysRange = maxGapDays - minGapDays;

  const regions: Region[] = [];
  let y = PADDING_PX;
  for (const m of merged) {
    const days = (m.endMs - m.startMs) / DAY_MS;
    let heightPx: number;
    if (m.active) {
      heightPx = Math.max(MIN_BAND_HEIGHT_PX, PX_PER_SQRT_DAY * Math.sqrt(days));
    } else {
      const t = gapDaysRange > 0 ? (days - minGapDays) / gapDaysRange : 0;
      heightPx = GAP_MIN_HEIGHT_PX + t * (GAP_MAX_HEIGHT_PX - GAP_MIN_HEIGHT_PX);
    }
    regions.push({ startMs: m.startMs, endMs: m.endMs, active: m.active, heightPx, yPx: y });
    y += heightPx;
  }

  return regions;
}

function dateToY(ms: number, regions: Region[]): number {
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

function packLanes(entries: TimelineEntry[]): number[] {
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

// ── DOM rendering ──

function renderTimelineDOM(
  container: HTMLElement,
  entries: TimelineEntry[],
  lanes: number[],
  regions: Region[],
  app: App,
  todayMs: number
): void {
  const lastRegion = regions[regions.length - 1];
  const totalHeight = lastRegion.yPx + lastRegion.heightPx + PADDING_PX;

  const startDates = new Set<number>();
  const endDates = new Set<number>();
  startDates.add(todayMs);
  let maxMs = -Infinity;
  for (const entry of entries) {
    for (const seg of entry.segments) {
      startDates.add(seg.start.getTime());
      endDates.add(seg.end.getTime());
      if (seg.end.getTime() > maxMs) maxMs = seg.end.getTime();
    }
  }

  const header = container.createEl("div", { cls: "fmo-timeline-header" });
  header.createEl("span", {
    text: `${formatMonthYear(new Date(todayMs))} – ${formatMonthYear(new Date(maxMs))}`
  });

  const scroll = container.createEl("div", { cls: "fmo-timeline-scroll" });
  const body = scroll.createEl("div", { cls: "fmo-timeline-body" });
  body.style.height = `${totalHeight}px`;

  const axis = body.createEl("div", { cls: "fmo-timeline-axis" });
  const lanesEl = body.createEl("div", { cls: "fmo-timeline-lanes" });

  const axisDates = [...new Set([...startDates, ...endDates])].sort((a, b) => a - b);
  const laneCount = Math.max(...lanes) + 1;
  const lanesWidthPx = laneCount * (BAR_WIDTH_PX + BAR_GAP_PX);

  const renderedBounds: Array<[number, number]> = [];

  for (const ms of axisDates) {
    const y = dateToY(ms, regions);

    const isToday = ms === todayMs;
    const line = lanesEl.createEl("div", {
      cls: isToday ? "fmo-timeline-today-line" : "fmo-timeline-grid-line"
    });
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
      ([t, b]) => visualTop < b + LABEL_OVERLAP_PAD_PX && visualBottom > t - LABEL_OVERLAP_PAD_PX
    );
    if (!overlaps) {
      const label = axis.createEl("div", { cls: `fmo-timeline-date-label ${alignCls}` });
      label.style.top = `${y}px`;
      label.textContent = isToday ? `Today` : formatShortDate(new Date(ms));
      renderedBounds.push([visualTop, visualBottom]);
    }
  }

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

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const lane = lanes[i];
    const color = DASHBOARD_COLORS[i % DASHBOARD_COLORS.length];

    for (const seg of entry.segments) {
      const yStart = dateToY(seg.start.getTime(), regions);
      const yEnd = dateToY(seg.end.getTime(), regions);
      const barHeight = Math.max(MIN_BAR_HEIGHT_PX, yEnd - yStart);

      const bar = lanesEl.createEl("div", { cls: "fmo-timeline-bar" });
      bar.style.top = `${yStart}px`;
      bar.style.height = `${barHeight}px`;
      bar.style.left = `${lane * (BAR_WIDTH_PX + BAR_GAP_PX)}px`;
      bar.style.width = `${BAR_WIDTH_PX}px`;
      bar.style.borderLeftColor = color;
      bar.style.backgroundColor = color + BAR_BG_ALPHA;

      const days = Math.round((seg.end.getTime() - seg.start.getTime()) / DAY_MS) + 1;
      bar.createEl("div", {
        cls: "fmo-timeline-bar-name",
        text: `[${days}d] ${entry.file.basename}`
      });

      bar.addEventListener("click", () => {
        void app.workspace.getLeaf("tab").openFile(entry.file);
      });
    }
  }
}

// ── Formatters ──

function formatMonthYear(d: Date): string {
  return d.toLocaleString("default", { month: "short", year: "numeric" });
}

function formatShortDate(d: Date): string {
  const month = d.toLocaleString("default", { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  return `${month} ${day}`;
}
