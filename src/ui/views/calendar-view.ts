import { Notice, type WorkspaceLeaf } from "obsidian";
import type { TaskItem, TimeLogEntry } from "../../models/types";
import {
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  type OutlineSortMode
} from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import type { OutlineTimeRange } from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";
import { ConcernTreePanel, type ConcernTreePanelState } from "../concern-tree-panel";
import { TaskSelectModal } from "../task-select-modal";

type CalendarPeriod = "today" | "week" | "previousWeek";

type CalendarEntry = {
  path: string;
  basename: string;
  entry: TimeLogEntry;
};

type HourRange = { minHour: number; maxHour: number };

type BlockRenderContext = {
  colorMap: Map<string, string>;
  minHour: number;
  pxPerHour: number;
  dayStartMs: number;
  highlightedPaths: Set<string> | null;
};

type CalendarGridSpec = {
  dayStartMs: number;
  minHour: number;
  maxHour: number;
  pxPerHour: number;
};

const CALENDAR_COLORS = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
  "#9c755f", "#bab0ac"
];

const BASE_DAY_PX_PER_HOUR = 60;
const BASE_WEEK_PX_PER_HOUR = 40;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCK_MIN_HEIGHT_PX = 3;
const BLOCK_LABEL_MIN_FONT_PX = 10;
const BLOCK_LABEL_MAX_FONT_PX = 20;
const BLOCK_LABEL_SCALE_START_HEIGHT_PX = 12;
const BLOCK_LABEL_SCALE_END_HEIGHT_PX = 48;
const CALENDAR_PERIOD_OPTIONS: Array<{ value: CalendarPeriod; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "previousWeek", label: "Previous Week" }
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

function computeBlockFontSizePx(heightPx: number): number {
  const clampedHeight = Math.max(
    BLOCK_LABEL_SCALE_START_HEIGHT_PX,
    Math.min(BLOCK_LABEL_SCALE_END_HEIGHT_PX, heightPx)
  );
  const progress =
    (clampedHeight - BLOCK_LABEL_SCALE_START_HEIGHT_PX) /
    (BLOCK_LABEL_SCALE_END_HEIGHT_PX - BLOCK_LABEL_SCALE_START_HEIGHT_PX);
  const size =
    BLOCK_LABEL_MIN_FONT_PX +
    progress * (BLOCK_LABEL_MAX_FONT_PX - BLOCK_LABEL_MIN_FONT_PX);
  return Math.round(size * 10) / 10;
}

export class LifeDashboardCalendarView extends LifeDashboardBaseView {
  private calendarTreePanel: ConcernTreePanel | null = null;
  private calendarTreePanelScrollTop = 0;
  private calendarTreeState: ConcernTreePanelState = {
    rootPath: "",
    query: "",
    sortMode: "recent" as OutlineSortMode,
    range: "today" as OutlineTimeRange,
    trackedOnly: false,
    showParents: true,
    collapsedNodePaths: new Set(),
  };
  private calendarTreeStateLoaded = false;
  private calendarColorMap: Map<string, string> = new Map();
  private currentVisiblePaths: Set<string> | null = null;
  private hoveredPaths: Set<string> | null = null;
  private activeDragCleanup: (() => void) | null = null;
  private pendingDraftBlock: HTMLElement | null = null;
  private concernPickerOpen = false;

  private get period(): CalendarPeriod {
    const value = this.plugin.settings.calendarPeriod;
    return (value === "week" || value === "previousWeek") ? value : "today";
  }

  private set period(value: CalendarPeriod) {
    if (this.plugin.settings.calendarPeriod === value) return;
    this.plugin.settings.calendarPeriod = value;
    void this.plugin.saveSettings();
  }

  private get zoom(): number {
    const z = this.plugin.settings.calendarZoom;
    return (z >= MIN_ZOOM && z <= MAX_ZOOM) ? z : 1;
  }

  private set zoom(value: number) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
    if (this.plugin.settings.calendarZoom === clamped) return;
    this.plugin.settings.calendarZoom = clamped;
    void this.plugin.saveSettings();
  }

  private get pxPerHour(): number {
    const base = this.period === "today" ? BASE_DAY_PX_PER_HOUR : BASE_WEEK_PX_PER_HOUR;
    return base * this.zoom;
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

  async onClose(): Promise<void> {
    this.clearCalendarCreateState();
  }

  private loadTreePanelState(): void {
    if (this.calendarTreeStateLoaded) return;
    this.calendarTreeStateLoaded = true;

    const raw = this.plugin.getCalendarTreePanelState().trim();
    if (!raw) return;

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!parsed || typeof parsed !== "object") return;

    const obj = parsed as Record<string, unknown>;
    if (typeof obj.rootPath === "string") this.calendarTreeState.rootPath = obj.rootPath;
    if (typeof obj.query === "string") this.calendarTreeState.query = obj.query;
    if (obj.sortMode === "recent" || obj.sortMode === "priority") this.calendarTreeState.sortMode = obj.sortMode;
    if (typeof obj.showParents === "boolean") this.calendarTreeState.showParents = obj.showParents;
    if (Array.isArray(obj.collapsedNodePaths)) {
      this.calendarTreeState.collapsedNodePaths = new Set(
        (obj.collapsedNodePaths as unknown[]).filter((p): p is string => typeof p === "string")
      );
    }
  }

  private persistTreePanelState(): void {
    const state = {
      rootPath: this.calendarTreeState.rootPath,
      query: this.calendarTreeState.query,
      sortMode: this.calendarTreeState.sortMode,
      showParents: this.calendarTreeState.showParents,
      collapsedNodePaths: [...this.calendarTreeState.collapsedNodePaths],
    };
    this.plugin.setCalendarTreePanelState(JSON.stringify(state));
  }

  async render(): Promise<void> {
    this.clearCalendarCreateState();
    const { contentEl } = this;
    const existingPreview = contentEl.querySelector<HTMLElement>(".fmo-tree-panel-preview");
    this.calendarTreePanelScrollTop = existingPreview?.scrollTop ?? this.calendarTreePanelScrollTop;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    this.loadTreePanelState();
    // Sync range from calendar period
    this.calendarTreeState.range = this.period;
    this.calendarTreeState.trackedOnly = true;

    // Header with title and period toggle
    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concerns Calendar" });

    const rangeRow = header.createEl("div", { cls: "fmo-outline-range-row" });
    for (const option of CALENDAR_PERIOD_OPTIONS) {
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

    // Two-column layout
    const layout = contentEl.createEl("div", { cls: "fmo-calendar-layout" });
    const sidebar = layout.createEl("div", { cls: "fmo-calendar-sidebar" });
    const divider = layout.createEl("div", { cls: "fmo-calendar-divider" });
    const main = layout.createEl("div", { cls: "fmo-calendar-main" });

    this.attachSidebarResize(divider, sidebar);

    // Build stable color map from ALL concerns with entries in this period.
    // Computed once per render() so colors don't shift on collapse/expand/filter.
    this.calendarColorMap = this.buildColorMap(this.gatherCalendarEntries());

    // Function to render the calendar main area with filtered entries
    const renderCalendarMain = (visiblePaths: Set<string> | null): void => {
      this.currentVisiblePaths = visiblePaths ? new Set(visiblePaths) : null;
      main.empty();
      const allEntries = this.gatherCalendarEntries();
      let entries = visiblePaths
        ? allEntries.filter((e) => visiblePaths.has(e.path))
        : allEntries;

      entries = this.remapCollapsedEntries(entries);
      const highlightedDisplayPaths = this.remapPathsToDisplay(this.hoveredPaths);

      if (entries.length === 0) {
        main.createEl("p", {
          cls: "fmo-empty",
          text: "No tracked time in this period yet. Drag on the grid to add a segment."
        });
      }

      if (this.period === "today") {
        this.renderDayTimeline(main, entries, this.calendarColorMap, highlightedDisplayPaths);
      } else {
        this.renderWeekGrid(main, entries, this.calendarColorMap, highlightedDisplayPaths);
      }

      // Drag handle to resize the grid vertically
      const gridEl = main.querySelector<HTMLElement>(".fmo-calendar-timeline, .fmo-calendar-week-wrapper");
      if (gridEl) {
        this.attachResizeHandle(main, gridEl);
      }

      const totalSeconds = entries.reduce((sum, e) => sum + e.entry.durationMinutes * 60, 0);
      this.calendarTreePanel?.setStatusText(`total: ${this.plugin.formatShortDuration(totalSeconds)}`);
    };

    // Create tree panel in sidebar
    this.calendarTreePanel = new ConcernTreePanel({
      plugin: this.plugin,
      container: sidebar,
      initialPreviewScrollTop: this.calendarTreePanelScrollTop,
      state: { ...this.calendarTreeState },
      hideControls: { range: true, trackedOnly: true },
      onChange: (visiblePaths, newState) => {
        this.calendarTreeState = {
          ...newState,
          collapsedNodePaths: new Set(newState.collapsedNodePaths),
        };
        this.persistTreePanelState();
        renderCalendarMain(visiblePaths);
      },
      onHoverChange: (hoveredPaths) => {
        this.hoveredPaths = hoveredPaths ? new Set(hoveredPaths) : null;
        renderCalendarMain(this.currentVisiblePaths);
      },
    });

    // Initial render of calendar with tree panel's visible paths
    renderCalendarMain(this.calendarTreePanel.getVisiblePaths());
  }

  private gatherCalendarEntries(): CalendarEntry[] {
    const now = new Date();
    const window = this.getCalendarWindow(now);
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

  private getCalendarWindow(now: Date): { startMs: number; endMs: number } {
    return this.plugin.getWindowForRange(this.period, now);
  }

  private attachDragResize(
    handle: HTMLElement,
    axis: "x" | "y",
    cursorClass: string,
    getStartSize: () => number,
    onMove: (delta: number, startSize: number) => void,
    onEnd: (delta: number, startSize: number) => void
  ): void {
    let start = 0;
    let startSize = 0;

    const move = (e: MouseEvent): void => onMove((axis === "x" ? e.clientX : e.clientY) - start, startSize);

    const up = (e: MouseEvent): void => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.removeClass("fmo-calendar-resizing", cursorClass);
      onEnd((axis === "x" ? e.clientX : e.clientY) - start, startSize);
    };

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      start = axis === "x" ? e.clientX : e.clientY;
      startSize = getStartSize();
      document.body.addClass("fmo-calendar-resizing", cursorClass);
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  private attachSidebarResize(divider: HTMLElement, sidebar: HTMLElement): void {
    this.attachDragResize(divider, "x", "fmo-resizing-h",
      () => sidebar.getBoundingClientRect().width,
      (delta, startWidth) => {
        const maxWidth = sidebar.parentElement!.clientWidth * 0.5;
        sidebar.style.width = `${Math.max(180, Math.min(maxWidth, startWidth + delta))}px`;
      },
      () => {}
    );
  }

  private attachResizeHandle(container: HTMLElement, gridEl: HTMLElement): void {
    this.attachDragResize(
      container.createEl("div", { cls: "fmo-calendar-resize-handle" }),
      "y", "fmo-resizing-v",
      () => gridEl.getBoundingClientRect().height,
      (delta, startHeight) => {
        const scale = Math.max(MIN_ZOOM / this.zoom, Math.min(MAX_ZOOM / this.zoom, (startHeight + delta) / startHeight));
        gridEl.style.transform = `scaleY(${scale})`;
        gridEl.style.transformOrigin = "top";
      },
      (delta, startHeight) => {
        gridEl.style.transform = "";
        gridEl.style.transformOrigin = "";
        if (Math.abs(delta) < 3) return;
        this.zoom = this.zoom * ((startHeight + delta) / startHeight);
        void this.render();
      }
    );
  }

  private getBasenameByPath(): Map<string, string> {
    const map = new Map<string, string>();
    for (const task of this.plugin.getTaskTreeItems()) {
      map.set(task.file.path, task.file.basename);
    }
    return map;
  }

  private remapCollapsedEntries(entries: CalendarEntry[]): CalendarEntry[] {
    if (!this.calendarTreePanel) return entries;
    const displayPathMap = this.calendarTreePanel.getDisplayPathMap();
    if (displayPathMap.size === 0) return entries;

    const basenameByPath = this.getBasenameByPath();
    return entries.map((e) => {
      const displayPath = displayPathMap.get(e.path);
      if (displayPath && displayPath !== e.path) {
        return { ...e, path: displayPath, basename: basenameByPath.get(displayPath) ?? e.basename };
      }
      return e;
    });
  }

  private remapPathsToDisplay(paths: Set<string> | null): Set<string> | null {
    if (!paths || paths.size === 0) return null;

    const displayPathMap = this.calendarTreePanel?.getDisplayPathMap() ?? new Map<string, string>();
    if (displayPathMap.size === 0) return new Set(paths);

    const remapped = new Set<string>();
    for (const path of paths) {
      remapped.add(displayPathMap.get(path) ?? path);
    }
    return remapped;
  }

  private buildColorMap(entries: CalendarEntry[]): Map<string, string> {
    // Include every concern so colors are stable regardless of filtering/collapsing.
    const pathBasenames = this.getBasenameByPath();
    for (const e of entries) {
      if (!pathBasenames.has(e.path)) pathBasenames.set(e.path, e.basename);
    }

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
    if (entries.length === 0) {
      return { minHour: 0, maxHour: 24 };
    }

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
    ctx: BlockRenderContext
  ): void {
    const startFrac = (e.entry.startMs - ctx.dayStartMs) / (60 * 60 * 1000);
    const durationHours = e.entry.durationMinutes / 60;
    const top = (startFrac - ctx.minHour) * ctx.pxPerHour;
    const height = Math.max(BLOCK_MIN_HEIGHT_PX, durationHours * ctx.pxPerHour);

    const startDate = new Date(e.entry.startMs);
    const timeLabel = `${pad2(startDate.getHours())}:${pad2(startDate.getMinutes())}`;
    const durationLabel = this.plugin.formatShortDuration(e.entry.durationMinutes * 60);
    const tooltip = `${e.basename} ${timeLabel} (${durationLabel})`;

    const block = container.createEl("div", { cls: "fmo-calendar-block" });
    if (ctx.highlightedPaths) {
      block.addClass(ctx.highlightedPaths.has(e.path) ? "fmo-calendar-block-highlighted" : "fmo-calendar-block-dimmed");
    }
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.fontSize = `${computeBlockFontSizePx(height)}px`;
    block.style.backgroundColor = ctx.colorMap.get(e.path) ?? CALENDAR_COLORS[0];
    block.title = tooltip;
    if (height >= 12) block.setText(height >= 20 ? `${timeLabel} ${e.basename} (${durationLabel})` : `${timeLabel} ${e.basename}`);

    block.addEventListener("click", () => { void this.plugin.openFile(e.path); });
  }

  private renderDayTimeline(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>,
    highlightedPaths: Set<string> | null
  ): void {
    const pxPerHour = this.pxPerHour;
    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * pxPerHour;
    const dayStartMs = this.plugin.getDayStart(new Date()).getTime();

    const timeline = containerEl.createEl("div", { cls: "fmo-calendar-timeline" });
    timeline.style.height = `${gridHeight}px`;

    this.renderHourLabelsAndGridlines(timeline, hourRange, pxPerHour, "fmo-calendar-hour-label");

    const ctx: BlockRenderContext = { colorMap, minHour: hourRange.minHour, pxPerHour, dayStartMs, highlightedPaths };
    for (const e of entries) {
      this.renderEntryBlock(timeline, e, ctx);
    }

    this.attachTimeSegmentCreation(timeline, {
      dayStartMs,
      minHour: hourRange.minHour,
      maxHour: hourRange.maxHour,
      pxPerHour
    });
  }

  private renderWeekGrid(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>,
    highlightedPaths: Set<string> | null
  ): void {
    const now = new Date();
    const weekWindow = this.getCalendarWindow(now);
    const weekStartMs = weekWindow.startMs;
    const dayNames = this.plugin.settings.weekStartsOn === "sunday"
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    const dayEntries: CalendarEntry[][] = Array.from({ length: 7 }, () => []);
    for (const e of entries) {
      const dayIndex = Math.floor(
        (this.plugin.getDayStart(new Date(e.entry.startMs)).getTime() - weekStartMs) /
        DAY_MS
      );
      if (dayIndex >= 0 && dayIndex < 7) dayEntries[dayIndex].push(e);
    }

    const pxPerHour = this.pxPerHour;
    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * pxPerHour;
    const todayMs = this.period === "week"
      ? this.plugin.getDayStart(now).getTime()
      : -1;

    const wrapper = containerEl.createEl("div", { cls: "fmo-calendar-week-wrapper" });

    // Hour axis
    const hourAxis = wrapper.createEl("div", { cls: "fmo-calendar-week-hour-axis" });
    hourAxis.style.height = `${gridHeight}px`;
    this.renderHourLabelsAndGridlines(hourAxis, hourRange, pxPerHour, "fmo-calendar-hour-label");

    // Day columns
    const grid = wrapper.createEl("div", { cls: "fmo-calendar-week-grid" });

    for (let d = 0; d < 7; d++) {
      const dayMs = weekStartMs + d * DAY_MS;
      const isToday = dayMs === todayMs;

      const col = grid.createEl("div", { cls: "fmo-calendar-week-col" });

      col.createEl("div", {
        cls: isToday ? "fmo-calendar-day-label fmo-calendar-day-today" : "fmo-calendar-day-label",
        text: `${dayNames[d] ?? ""} ${pad2(new Date(dayMs).getDate())}`
      });

      const total = dayEntries[d].reduce((s, e) => s + e.entry.durationMinutes * 60, 0);
      const totalLabel = total > 0 ? this.plugin.formatShortDuration(total) : "";
      col.createEl("div", {
        cls: "fmo-calendar-day-total-top",
        text: totalLabel
      });

      const dayCol = col.createEl("div", { cls: "fmo-calendar-day-bar" });
      dayCol.style.height = `${gridHeight}px`;

      // Gridlines
      for (let h = hourRange.minHour; h <= hourRange.maxHour; h++) {
        const line = dayCol.createEl("div", { cls: "fmo-calendar-gridline" });
        line.style.top = `${(h - hourRange.minHour) * pxPerHour}px`;
      }

      // Entry blocks
      const blockCtx: BlockRenderContext = { colorMap, minHour: hourRange.minHour, pxPerHour, dayStartMs: dayMs, highlightedPaths };
      for (const e of dayEntries[d]) {
        this.renderEntryBlock(dayCol, e, blockCtx);
      }

      this.attachTimeSegmentCreation(dayCol, {
        dayStartMs: dayMs,
        minHour: hourRange.minHour,
        maxHour: hourRange.maxHour,
        pxPerHour
      });

      // Day total (bottom duplicate)
      col.createEl("div", {
        cls: "fmo-calendar-day-total",
        text: totalLabel
      });
    }
  }

  private clearCalendarCreateState(): void {
    if (this.activeDragCleanup) {
      this.activeDragCleanup();
      this.activeDragCleanup = null;
    }
    this.discardPendingDraft();
    this.concernPickerOpen = false;
  }

  private discardPendingDraft(): void {
    if (this.pendingDraftBlock) {
      this.pendingDraftBlock.remove();
      this.pendingDraftBlock = null;
    }
  }

  private attachTimeSegmentCreation(containerEl: HTMLElement, spec: CalendarGridSpec): void {
    containerEl.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || this.concernPickerOpen) return;
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target.closest(".fmo-calendar-block")) return;
      if (event.target.closest(".fmo-calendar-draft-block")) return;
      if (event.target.closest(".fmo-calendar-hour-label")) return;

      event.preventDefault();
      event.stopPropagation();

      if (this.activeDragCleanup) {
        this.activeDragCleanup();
        this.activeDragCleanup = null;
      }
      this.discardPendingDraft();

      const gridHeight = this.getGridHeightPx(spec);
      const anchorY = this.clientYToLocalY(event.clientY, containerEl, gridHeight);
      let currentY = anchorY;

      const draftBlock = containerEl.createEl("div", { cls: "fmo-calendar-draft-block" });
      draftBlock.createEl("span", { cls: "fmo-calendar-draft-plus", text: "+" });
      this.pendingDraftBlock = draftBlock;

      const updateDraft = (clientY: number): void => {
        currentY = this.clientYToLocalY(clientY, containerEl, gridHeight);
        const top = Math.min(anchorY, currentY);
        const height = Math.max(2, Math.abs(currentY - anchorY));
        draftBlock.style.top = `${top}px`;
        draftBlock.style.height = `${height}px`;
      };

      updateDraft(event.clientY);

      const move = (moveEvent: MouseEvent): void => {
        updateDraft(moveEvent.clientY);
      };

      const finalize = (clientY: number): void => {
        updateDraft(clientY);
        const { startMs, endMs } = this.getSegmentRangeFromLocalYs(anchorY, currentY, spec);
        void this.finalizeSegmentCreation(startMs, endMs, draftBlock);
      };

      const up = (upEvent: MouseEvent): void => {
        cleanup();
        finalize(upEvent.clientY);
      };

      const cleanup = (): void => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.removeClass("fmo-calendar-creating");
        if (this.activeDragCleanup === cleanup) {
          this.activeDragCleanup = null;
        }
      };

      this.activeDragCleanup = cleanup;
      document.body.addClass("fmo-calendar-creating");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  private clientYToLocalY(clientY: number, containerEl: HTMLElement, maxY: number): number {
    const rect = containerEl.getBoundingClientRect();
    return this.clamp(clientY - rect.top, 0, maxY);
  }

  private localYToTimestampMs(localY: number, spec: CalendarGridSpec): number {
    const clampedY = this.clamp(localY, 0, this.getGridHeightPx(spec));
    const hourOffset = clampedY / spec.pxPerHour;
    const timestamp = spec.dayStartMs + (spec.minHour + hourOffset) * 60 * 60 * 1000;
    return Math.floor(timestamp / 60_000) * 60_000;
  }

  private getGridHeightPx(spec: CalendarGridSpec): number {
    return (spec.maxHour - spec.minHour) * spec.pxPerHour;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getSegmentRangeFromLocalYs(
    anchorY: number,
    currentY: number,
    spec: CalendarGridSpec
  ): { startMs: number; endMs: number } {
    const anchorMs = this.localYToTimestampMs(anchorY, spec);
    const currentMs = this.localYToTimestampMs(currentY, spec);
    const startMs = Math.min(anchorMs, currentMs);
    const endMs = Math.max(anchorMs, currentMs);
    return {
      startMs,
      endMs: endMs > startMs ? endMs : startMs + 60_000
    };
  }

  private selectConcernPathForSegment(draftBlock: HTMLElement): Promise<string | null> {
    const taskFiles = this.plugin.getTaskTreeItems().map((item) => item.file);
    if (taskFiles.length === 0) {
      new Notice("No concerns available to assign this segment.");
      return Promise.resolve(null);
    }

    this.concernPickerOpen = true;
    draftBlock.addClass("fmo-calendar-draft-block-fixed");

    return new Promise<string | null>((resolve) => {
      let settled = false;
      const resolveOnce = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const modal = new TaskSelectModal(
        this.app,
        taskFiles,
        (file) => {
          this.concernPickerOpen = false;
          resolveOnce(file.path);
        },
        () => {
          this.concernPickerOpen = false;
          resolveOnce(null);
        }
      );
      modal.open();
    });
  }

  private async finalizeSegmentCreation(
    startMs: number,
    endMs: number,
    draftBlock: HTMLElement
  ): Promise<void> {
    try {
      const selectedPath = await this.selectConcernPathForSegment(draftBlock);
      if (!selectedPath) {
        this.discardPendingDraft();
        return;
      }

      const appended = await this.plugin.appendTimeEntryForPath(selectedPath, startMs, endMs);
      if (!appended) {
        this.discardPendingDraft();
        new Notice("Could not create time segment for the selected concern.");
        return;
      }
      this.pendingDraftBlock = null;
      await this.render();
    } catch (error) {
      this.discardPendingDraft();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not create time segment: ${message}`);
    }
  }

}
