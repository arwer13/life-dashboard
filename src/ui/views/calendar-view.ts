import { type WorkspaceLeaf } from "obsidian";
import type { TaskItem, TimeLogEntry } from "../../models/types";
import {
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  type OutlineSortMode
} from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import type { OutlineTimeRange } from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";
import { ConcernTreePanel, type ConcernTreePanelState } from "../concern-tree-panel";

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

const BASE_DAY_PX_PER_HOUR = 60;
const BASE_WEEK_PX_PER_HOUR = 40;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const BLOCK_MIN_HEIGHT_PX = 3;

const pad2 = (n: number): string => String(n).padStart(2, "0");

export class LifeDashboardCalendarView extends LifeDashboardBaseView {
  private calendarTreePanel: ConcernTreePanel | null = null;
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

  private get period(): CalendarPeriod {
    return this.plugin.settings.calendarPeriod === "week" ? "week" : "today";
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
    const { contentEl } = this;
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
      main.empty();
      const allEntries = this.gatherCalendarEntries();
      let entries = visiblePaths
        ? allEntries.filter((e) => visiblePaths.has(e.path))
        : allEntries;

      entries = this.remapCollapsedEntries(entries);

      if (entries.length === 0) {
        main.createEl("p", { cls: "fmo-empty", text: "No tracked time in this period." });
        this.calendarTreePanel?.setStatusText("");
        return;
      }

      if (this.period === "today") {
        this.renderDayTimeline(main, entries, this.calendarColorMap);
      } else {
        this.renderWeekGrid(main, entries, this.calendarColorMap);
      }

      // Drag handle to resize the grid vertically
      const gridEl = main.firstElementChild as HTMLElement | null;
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
    });

    // Initial render of calendar with tree panel's visible paths
    renderCalendarMain(this.calendarTreePanel.getVisiblePaths());
  }

  private gatherCalendarEntries(): CalendarEntry[] {
    const now = new Date();
    const window = this.plugin.getWindowForRange(this.period, now);
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
    if (height >= 12) block.setText(height >= 20 ? `${timeLabel} ${e.basename} (${durationLabel})` : `${timeLabel} ${e.basename}`);

    block.addEventListener("click", () => { void this.plugin.openFile(e.path); });
  }

  private renderDayTimeline(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>
  ): void {
    const pxPerHour = this.pxPerHour;
    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * pxPerHour;
    const dayStartMs = this.plugin.getDayStart(new Date()).getTime();

    const timeline = containerEl.createEl("div", { cls: "fmo-calendar-timeline" });
    timeline.style.height = `${gridHeight}px`;

    this.renderHourLabelsAndGridlines(timeline, hourRange, pxPerHour, "fmo-calendar-hour-label");

    for (const e of entries) {
      this.renderEntryBlock(timeline, e, colorMap, hourRange.minHour, pxPerHour, dayStartMs);
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

    const pxPerHour = this.pxPerHour;
    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * pxPerHour;
    const todayMs = this.plugin.getDayStart(now).getTime();

    const wrapper = containerEl.createEl("div", { cls: "fmo-calendar-week-wrapper" });

    // Hour axis
    const hourAxis = wrapper.createEl("div", { cls: "fmo-calendar-week-hour-axis" });
    hourAxis.style.height = `${gridHeight}px`;
    this.renderHourLabelsAndGridlines(hourAxis, hourRange, pxPerHour, "fmo-calendar-hour-label");

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
        line.style.top = `${(h - hourRange.minHour) * pxPerHour}px`;
      }

      // Entry blocks
      for (const e of dayEntries[d]) {
        this.renderEntryBlock(dayCol, e, colorMap, hourRange.minHour, pxPerHour, dayMs);
      }

      // Day total
      const total = dayEntries[d].reduce((s, e) => s + e.entry.durationMinutes * 60, 0);
      col.createEl("div", {
        cls: "fmo-calendar-day-total",
        text: total > 0 ? this.plugin.formatShortDuration(total) : ""
      });
    }
  }

}
