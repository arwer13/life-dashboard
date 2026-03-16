import { Notice } from "obsidian";
import type { TimeLogEntry } from "../../models/types";
import { isFileItem } from "../../models/types";
import {
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  DASHBOARD_COLORS,
  DAY_MS,
  type OutlineSortMode
} from "../../models/view-types";
import type {
  HealthTrackingDay,
  HealthTrackingRangeSnapshot
} from "../../services/health-tracking-service";
import type LifeDashboardPlugin from "../../plugin";
import type { OutlineTimeRange, TimeWindow } from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";
import { ConcernTreePanel, type ConcernTreePanelState } from "../concern-tree-panel";
import { TaskSelectModal } from "../task-select-modal";

type CalendarPeriod = "today" | "week" | "month" | "year";

type CalendarEntry = {
  path: string;
  basename: string;
  entry: TimeLogEntry;
};

type CalendarDayBucket = {
  totalSeconds: number;
  secondsByPath: Map<string, number>;
};

type CalendarYearSlot = {
  date: Date;
  key: string;
} | null;

type HourRange = { minHour: number; maxHour: number };

type BlockRenderContext = {
  colorMap: Map<string, string>;
  highlightedPaths: Set<string> | null;
  spec: CalendarGridSpec;
};

type CalendarGridSpec = {
  dayStartMs: number;
  minHour: number;
  maxHour: number;
  pxPerHour: number;
};

type HealthOverviewMetric = {
  label: string;
  value: string;
  sublabel: string;
  dimmed?: boolean;
  title?: string;
};

const BASE_DAY_PX_PER_HOUR = 60;
const BASE_WEEK_PX_PER_HOUR = 40;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const BLOCK_MIN_HEIGHT_PX = 3;
const BLOCK_LABEL_FONT_PX = 10;
const RESIZE_SNAP_MS = 5 * 60 * 1000;
const CALENDAR_PERIOD_OPTIONS: Array<{ value: CalendarPeriod; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" }
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

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
    if (value === "week" || value === "month" || value === "year") return value;
    // Migrate legacy "previousWeek" → "week" with offset -1
    if (value === "previousWeek") {
      this.plugin.settings.calendarPeriod = "week";
      this.plugin.settings.calendarOffset = -1;
      void this.plugin.saveSettings();
      return "week";
    }
    return "today";
  }

  private set period(value: CalendarPeriod) {
    if (this.plugin.settings.calendarPeriod === value) return;
    this.plugin.settings.calendarPeriod = value;
    this.plugin.settings.calendarOffset = 0;
    void this.plugin.saveSettings();
  }

  private get offset(): number {
    return this.plugin.settings.calendarOffset ?? 0;
  }

  private set offset(value: number) {
    if (this.plugin.settings.calendarOffset === value) return;
    this.plugin.settings.calendarOffset = value;
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
    this.calendarTreeState.trackedOnly = true;

    const now = new Date();
    const calendarWindow = this.getCalendarWindow(now);
    const calendarEntries = this.gatherCalendarEntries(calendarWindow);
    await this.plugin.ensureHealthTrackingLoaded();
    const healthRange = this.plugin.getHealthTrackingRangeSnapshot(calendarWindow, now);
    this.calendarTreeState.range = this.getTreeRange();

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

    // Navigation row (for week/month/year)
    if (this.period !== "today") {
      this.renderNavigation(header, calendarWindow);
    }
    this.renderHealthOverview(header, healthRange);

    // Two-column layout
    const layout = contentEl.createEl("div", { cls: "fmo-calendar-layout" });
    const sidebar = layout.createEl("div", { cls: "fmo-calendar-sidebar" });
    const divider = layout.createEl("div", { cls: "fmo-calendar-divider" });
    const main = layout.createEl("div", { cls: "fmo-calendar-main" });

    this.attachSidebarResize(divider, sidebar);

    // Build stable color map from ALL concerns with entries in this period.
    this.calendarColorMap = this.buildColorMap(calendarEntries);

    // Function to render the calendar main area with filtered entries
    const renderCalendarMain = (visiblePaths: Set<string> | null): void => {
      this.currentVisiblePaths = visiblePaths ? new Set(visiblePaths) : null;
      main.empty();
      let entries = visiblePaths
        ? calendarEntries.filter((e) => visiblePaths.has(e.path))
        : calendarEntries;

      entries = this.remapCollapsedEntries(entries);
      const highlightedDisplayPaths = this.remapPathsToDisplay(this.hoveredPaths);

      switch (this.period) {
        case "today":
          if (entries.length === 0) {
            main.createEl("p", { cls: "fmo-empty", text: "No tracked time today. Drag on the grid to add a segment." });
          }
          this.renderDayTimeline(main, entries, this.calendarColorMap, highlightedDisplayPaths, calendarWindow);
          break;
        case "week":
          if (entries.length === 0) {
            main.createEl("p", { cls: "fmo-empty", text: "No tracked time this week. Drag on the grid to add a segment." });
          }
          this.renderWeekGrid(main, entries, this.calendarColorMap, highlightedDisplayPaths, calendarWindow, healthRange);
          break;
        case "month":
          this.renderMonthGrid(main, entries, this.calendarColorMap, highlightedDisplayPaths, calendarWindow, healthRange);
          break;
        case "year":
          this.renderYearHeatmap(main, entries, calendarWindow, healthRange);
          break;
      }

      // Drag handle to resize the grid vertically (only for day/week views)
      if (this.period === "today" || this.period === "week") {
        const gridEl = main.querySelector<HTMLElement>(".fmo-calendar-timeline, .fmo-calendar-week-wrapper");
        if (gridEl) {
          this.attachResizeHandle(main, gridEl);
        }
      }

      const totalSeconds = this.getEntryTotalSeconds(entries);
      this.calendarTreePanel?.setStatusText(`total: ${this.plugin.timeData.formatShortDuration(totalSeconds)}`);
    };

    // Lightweight highlight update that toggles CSS classes without rebuilding DOM
    const updateHighlights = (hoveredPaths: Set<string> | null): void => {
      this.hoveredPaths = hoveredPaths ? new Set(hoveredPaths) : null;
      const highlightedDisplayPaths = this.remapPathsToDisplay(this.hoveredPaths);
      this.applyHighlights(main, highlightedDisplayPaths);
    };

    // Create tree panel in sidebar
    this.calendarTreePanel = new ConcernTreePanel({
      plugin: this.plugin,
      container: sidebar,
      initialPreviewScrollTop: this.calendarTreePanelScrollTop,
      state: { ...this.calendarTreeState },
      customWindow: calendarWindow,
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
        updateHighlights(hoveredPaths);
      },
    });

    // Initial render of calendar with tree panel's visible paths
    renderCalendarMain(this.calendarTreePanel.getVisiblePaths());
  }

  private getTreeRange(): OutlineTimeRange {
    switch (this.period) {
      case "today":
        return "today";
      case "week":
        if (this.offset === 0) return "week";
        if (this.offset === -1) return "previousWeek";
        break;
      case "month":
        if (this.offset === 0) return "month";
        break;
      case "year":
        break;
    }

    // For custom offsets, fall back to "all"; customWindow handles actual filtering.
    return "all";
  }

  private renderNavigation(
    header: HTMLElement,
    calendarWindow: TimeWindow
  ): void {
    const nav = header.createEl("div", { cls: "fmo-calendar-nav" });

    const prevBtn = nav.createEl("button", {
      cls: "fmo-calendar-nav-btn",
      attr: { type: "button", "aria-label": "Previous" }
    });
    prevBtn.setText("\u2039");
    prevBtn.addEventListener("click", () => {
      this.offset = this.offset - 1;
      void this.render();
    });

    const label = nav.createEl("button", {
      cls: "fmo-calendar-nav-label",
      attr: { type: "button", "aria-label": "Go to current" }
    });
    label.setText(this.getNavigationLabel(calendarWindow));
    if (this.offset !== 0) label.addClass("fmo-calendar-nav-label-offset");
    label.addEventListener("click", () => {
      if (this.offset === 0) return;
      this.offset = 0;
      void this.render();
    });

    const nextBtn = nav.createEl("button", {
      cls: "fmo-calendar-nav-btn",
      attr: { type: "button", "aria-label": "Next" }
    });
    nextBtn.setText("\u203A");
    nextBtn.disabled = this.offset >= 0;
    nextBtn.addEventListener("click", () => {
      if (this.offset >= 0) return;
      this.offset = this.offset + 1;
      void this.render();
    });
  }

  private getNavigationLabel(window: TimeWindow): string {
    const start = new Date(window.startMs);
    if (this.period === "year") {
      return `${start.getFullYear()}`;
    }
    if (this.period === "month") {
      return `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}`;
    }
    // week
    const end = new Date(window.endMs - 1);
    const startStr = `${MONTH_NAMES[start.getMonth()].slice(0, 3)} ${start.getDate()}`;
    if (start.getMonth() === end.getMonth()) {
      return `${startStr}\u2013${end.getDate()}, ${start.getFullYear()}`;
    }
    const endStr = `${MONTH_NAMES[end.getMonth()].slice(0, 3)} ${end.getDate()}`;
    if (start.getFullYear() === end.getFullYear()) {
      return `${startStr} \u2013 ${endStr}, ${start.getFullYear()}`;
    }
    return `${startStr}, ${start.getFullYear()} \u2013 ${endStr}, ${end.getFullYear()}`;
  }

  private getDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  private hasRenderableHealthData(healthRange: HealthTrackingRangeSnapshot): boolean {
    return healthRange.daysByDateKey.size > 0
      || healthRange.observability.sleepFiles.length > 0
      || healthRange.observability.stepsFiles.length > 0
      || healthRange.observability.parseErrors.length > 0;
  }

  private getHealthDay(
    date: Date,
    healthRange: HealthTrackingRangeSnapshot
  ): HealthTrackingDay | null {
    return healthRange.daysByDateKey.get(this.getDateKey(date)) ?? null;
  }

  private renderHealthOverview(
    header: HTMLElement,
    healthRange: HealthTrackingRangeSnapshot
  ): void {
    if (!this.hasRenderableHealthData(healthRange)) return;

    const overview = header.createEl("div", { cls: "fmo-calendar-health-overview" });
    const cards = overview.createEl("div", { cls: "fmo-calendar-health-cards" });

    const summary = healthRange.summary;
    const todayDay = this.period === "today"
      ? this.getHealthDay(new Date(), healthRange)
      : null;
    const sleepValue = this.period === "today"
      ? this.formatSleepDuration(todayDay?.sleepMinutes ?? null)
      : this.formatSleepDuration(summary.averageSleepMinutes);
    const sleepHrValue = this.period === "today"
      ? this.formatSleepHr(todayDay?.avgSleepHr ?? null)
      : this.formatSleepHr(summary.averageSleepHr);
    const stepsValue = this.period === "today"
      ? this.formatSteps(todayDay?.steps ?? null, false)
      : this.formatSteps(summary.averageSteps, false);
    const sleepMissing = this.period === "today"
      ? todayDay?.sleepMinutes == null
      : summary.averageSleepMinutes == null;
    const sleepHrMissing = this.period === "today"
      ? todayDay?.avgSleepHr == null
      : summary.averageSleepHr == null;
    const stepsMissing = this.period === "today"
      ? todayDay?.steps == null
      : summary.averageSteps == null;

    const metrics: HealthOverviewMetric[] = [
      {
        label: "Sleep",
        value: sleepValue,
        sublabel: this.period === "today" ? "main sleep" : "avg in range",
        dimmed: sleepMissing,
        title: todayDay?.sleepWindowLabel ?? undefined,
      },
      {
        label: "Sleep HR",
        value: sleepHrValue,
        sublabel: this.period === "today" ? "avg during sleep" : "range avg",
        dimmed: sleepHrMissing,
      },
      {
        label: "Steps",
        value: stepsValue,
        sublabel: this.period === "today" ? "today so far" : "avg in range",
        dimmed: stepsMissing,
      },
      {
        label: "Coverage",
        value: this.getHealthCoverageLabel(healthRange),
        sublabel: this.getHealthCoverageSublabel(healthRange),
        title: this.getHealthCoverageTitle(healthRange),
      },
    ];

    for (const metric of metrics) {
      this.renderHealthOverviewCard(cards, metric);
    }
  }

  private renderHealthOverviewCard(
    container: HTMLElement,
    metric: HealthOverviewMetric
  ): void {
    const card = container.createEl("div", {
      cls: metric.dimmed
        ? "fmo-calendar-health-card fmo-calendar-health-card-dimmed"
        : "fmo-calendar-health-card",
    });
    if (metric.title) card.title = metric.title;

    card.createEl("div", {
      cls: "fmo-calendar-health-card-label",
      text: metric.label
    });
    card.createEl("div", {
      cls: "fmo-calendar-health-card-value",
      text: metric.value
    });
    card.createEl("div", {
      cls: "fmo-calendar-health-card-sub",
      text: metric.sublabel
    });
  }

  private renderMonthHealthSignals(
    container: HTMLElement,
    healthDay: HealthTrackingDay | null
  ): void {
    if (!healthDay || (healthDay.sleepMinutes == null && healthDay.steps == null)) return;

    const signals = container.createEl("div", { cls: "fmo-calendar-month-signals" });

    if (healthDay.sleepMinutes != null) {
      this.renderMonthHealthChip(signals, {
        label: "Sleep",
        value: this.formatSleepDuration(healthDay.sleepMinutes),
        sublabel: this.formatSleepHr(healthDay.avgSleepHr),
        title: this.buildSleepChipTitle(healthDay),
      });
    }

    if (healthDay.steps != null) {
      this.renderMonthHealthChip(signals, {
        label: "Steps",
        value: this.formatSteps(healthDay.steps, true),
        title: `Steps: ${this.formatSteps(healthDay.steps, false)}`,
      });
    }
  }

  private renderWeekHealthAxis(container: HTMLElement): void {
    const axisHead = container.createEl("div", { cls: "fmo-calendar-week-axis-head" });
    axisHead.createEl("div", { cls: "fmo-calendar-week-axis-spacer" });
    axisHead.createEl("div", {
      cls: "fmo-calendar-week-axis-label",
      text: "sleep"
    });
    axisHead.createEl("div", {
      cls: "fmo-calendar-week-axis-label",
      text: "steps"
    });
    axisHead.createEl("div", { cls: "fmo-calendar-week-axis-total-spacer" });
  }

  private renderWeekHealthCells(
    container: HTMLElement,
    healthDay: HealthTrackingDay | null
  ): void {
    const stack = container.createEl("div", { cls: "fmo-calendar-week-health-stack" });

    this.renderWeekHealthCell(
      stack,
      healthDay?.sleepMinutes != null ? this.formatSleepDuration(healthDay.sleepMinutes) : "\u2014",
      healthDay?.avgSleepHr != null ? this.formatSleepHr(healthDay.avgSleepHr) : null,
      healthDay ? this.buildSleepChipTitle(healthDay) : null,
      healthDay?.sleepMinutes == null
    );
    this.renderWeekHealthCell(
      stack,
      healthDay?.steps != null ? this.formatSteps(healthDay.steps, true) : "\u2014",
      null,
      healthDay?.steps != null ? `Steps: ${this.formatSteps(healthDay.steps, false)}` : null,
      healthDay?.steps == null
    );
  }

  private renderWeekHealthCell(
    container: HTMLElement,
    value: string,
    sublabel: string | null,
    title: string | null,
    dimmed: boolean
  ): void {
    const cell = container.createEl("div", {
      cls: dimmed
        ? "fmo-calendar-week-health-cell fmo-calendar-week-health-cell-dimmed"
        : "fmo-calendar-week-health-cell"
    });
    if (title) cell.title = title;

    cell.createEl("div", {
      cls: "fmo-calendar-week-health-value",
      text: value
    });
    if (sublabel) {
      cell.createEl("div", {
        cls: "fmo-calendar-week-health-sub",
        text: sublabel
      });
    }
  }

  private renderMonthHealthChip(
    container: HTMLElement,
    options: {
      label: string;
      value: string;
      sublabel?: string;
      title?: string;
    }
  ): void {
    const chip = container.createEl("div", {
      cls: "fmo-calendar-health-chip fmo-calendar-health-chip-compact"
    });
    if (options.title) chip.title = options.title;

    chip.createEl("span", {
      cls: "fmo-calendar-health-chip-label",
      text: options.label
    });
    chip.createEl("span", {
      cls: "fmo-calendar-health-chip-value",
      text: options.value
    });
    if (options.sublabel) {
      chip.createEl("span", {
        cls: "fmo-calendar-health-chip-sub",
        text: options.sublabel
      });
    }
  }

  private buildSleepChipTitle(healthDay: HealthTrackingDay): string {
    const parts = [`Sleep: ${this.formatSleepDuration(healthDay.sleepMinutes)}`];
    if (healthDay.avgSleepHr != null) {
      parts.push(`Avg sleep HR: ${this.formatSleepHr(healthDay.avgSleepHr)}`);
    }
    if (healthDay.sleepWindowLabel) {
      parts.push(`Window: ${healthDay.sleepWindowLabel}`);
    }
    return parts.join(" | ");
  }

  private getHealthCoverageLabel(healthRange: HealthTrackingRangeSnapshot): string {
    const total = Math.max(healthRange.summary.activeDayCount, 1);
    return `sleep ${healthRange.summary.sleepDays}/${total} | steps ${healthRange.summary.stepsDays}/${total}`;
  }

  private getHealthCoverageSublabel(healthRange: HealthTrackingRangeSnapshot): string {
    const issueCount = healthRange.observability.parseErrors.length;
    if (issueCount <= 0) return "Me/Tracking";
    return issueCount === 1 ? "Me/Tracking | 1 issue" : `Me/Tracking | ${issueCount} issues`;
  }

  private getHealthCoverageTitle(healthRange: HealthTrackingRangeSnapshot): string {
    const parts = [
      `Sleep files: ${healthRange.observability.sleepFiles.length > 0 ? healthRange.observability.sleepFiles.map((path) => path.split("/").pop() ?? path).join(", ") : "none"}`,
      `Steps files: ${healthRange.observability.stepsFiles.length > 0 ? healthRange.observability.stepsFiles.map((path) => path.split("/").pop() ?? path).join(", ") : "none"}`,
      `Rows loaded: sleep ${healthRange.observability.sleepRows}, steps ${healthRange.observability.stepsRows}`
    ];

    if (healthRange.observability.parseErrors.length > 0) {
      parts.push(`Issues: ${healthRange.observability.parseErrors.join(" | ")}`);
    }

    return parts.join("\n");
  }

  private buildCalendarDayTitle(
    year: number,
    monthIndex: number,
    dayOfMonth: number,
    totalSeconds: number,
    healthDay: HealthTrackingDay | null
  ): string {
    const parts = [`${MONTH_NAMES[monthIndex]} ${dayOfMonth}, ${year}`];
    if (totalSeconds > 0) {
      parts.push(`Tracked time: ${this.plugin.timeData.formatShortDuration(totalSeconds)}`);
    }
    if (healthDay?.sleepMinutes != null) {
      parts.push(`Sleep: ${this.formatSleepDuration(healthDay.sleepMinutes)}`);
    }
    if (healthDay?.avgSleepHr != null) {
      parts.push(`Avg sleep HR: ${this.formatSleepHr(healthDay.avgSleepHr)}`);
    }
    if (healthDay?.sleepWindowLabel) {
      parts.push(`Sleep window: ${healthDay.sleepWindowLabel}`);
    }
    if (healthDay?.steps != null) {
      parts.push(`Steps: ${this.formatSteps(healthDay.steps, false)}`);
    }
    return parts.join("\n");
  }

  private formatSleepDuration(minutes: number | null): string {
    if (minutes == null || !Number.isFinite(minutes)) return "No data";
    return this.plugin.timeData.formatShortDuration(Math.max(0, Math.round(minutes)) * 60);
  }

  private formatSleepHr(value: number | null): string {
    if (value == null || !Number.isFinite(value)) return "No data";
    return `${Math.round(value)} bpm`;
  }

  private formatSteps(value: number | null, compact: boolean): string {
    if (value == null || !Number.isFinite(value)) return "No data";
    const rounded = Math.max(0, Math.round(value));
    if (!compact) return rounded.toLocaleString();
    if (rounded < 1000) return `${rounded}`;
    const compactValue = (rounded / 1000).toFixed(1);
    return `${compactValue.replace(/\.0$/, "")}k`;
  }

  private getWeekdayLabels(): string[] {
    return this.plugin.settings.weekStartsOn === "sunday"
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  }

  private getEntryTotalSeconds(entries: CalendarEntry[]): number {
    return entries.reduce((sum, entry) => sum + entry.entry.durationMinutes * 60, 0);
  }

  private getMaxBucketSeconds(dayBuckets: Map<string, CalendarDayBucket>): number {
    let maxSeconds = 0;
    for (const bucket of dayBuckets.values()) {
      if (bucket.totalSeconds > maxSeconds) maxSeconds = bucket.totalSeconds;
    }
    return maxSeconds;
  }

  private getIntensityRatio(totalSeconds: number, maxSeconds: number): number {
    if (totalSeconds <= 0 || maxSeconds <= 0) return 0;
    return totalSeconds / maxSeconds;
  }

  private getYearHeatmapLevel(totalSeconds: number, maxSeconds: number): string {
    const intensity = this.getIntensityRatio(totalSeconds, maxSeconds);
    if (intensity > 0.75) return "4";
    if (intensity > 0.5) return "3";
    if (intensity > 0.25) return "2";
    if (intensity > 0) return "1";
    return "0";
  }

  private buildDayBuckets(
    entries: CalendarEntry[],
    window: TimeWindow
  ): Map<string, CalendarDayBucket> {
    const buckets = new Map<string, CalendarDayBucket>();

    for (const entry of entries) {
      const entryStartMs = Math.max(entry.entry.startMs, window.startMs);
      const entryEndMs = Math.min(
        entry.entry.startMs + entry.entry.durationMinutes * 60_000,
        window.endMs
      );
      if (entryEndMs <= entryStartMs) continue;

      let cursorMs = entryStartMs;
      while (cursorMs < entryEndMs) {
        const dayStart = this.plugin.timeData.getDayStart(new Date(cursorMs));
        const nextDayStart = new Date(dayStart.getTime());
        nextDayStart.setDate(nextDayStart.getDate() + 1);
        const segmentEndMs = Math.min(entryEndMs, nextDayStart.getTime());
        const segmentSeconds = Math.floor((segmentEndMs - cursorMs) / 1000);
        if (segmentSeconds > 0) {
          const key = this.getDateKey(dayStart);
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = { totalSeconds: 0, secondsByPath: new Map() };
            buckets.set(key, bucket);
          }
          bucket.totalSeconds += segmentSeconds;
          bucket.secondsByPath.set(
            entry.path,
            (bucket.secondsByPath.get(entry.path) ?? 0) + segmentSeconds
          );
        }
        cursorMs = segmentEndMs;
      }
    }

    return buckets;
  }

  private gatherCalendarEntries(window: TimeWindow): CalendarEntry[] {
    const result: CalendarEntry[] = [];

    for (const task of this.plugin.getTaskTreeItems()) {
      if (!isFileItem(task)) continue;
      for (const entry of this.plugin.timeData.getEntriesForPath(task.path)) {
        if (entry.startMs >= window.startMs && entry.startMs < window.endMs) {
          result.push({ path: task.path, basename: task.basename, entry });
        }
      }
    }

    return result.sort((a, b) => a.entry.startMs - b.entry.startMs);
  }

  private getCalendarWindow(now: Date): TimeWindow {
    switch (this.period) {
      case "today":
        return this.plugin.timeData.getWindowForRange("today", now);
      case "week": {
        const weekStart = this.plugin.timeData.getWeekStart(now);
        weekStart.setDate(weekStart.getDate() + this.offset * 7);
        const weekEnd = new Date(weekStart.getTime());
        weekEnd.setDate(weekEnd.getDate() + 7);
        return { startMs: weekStart.getTime(), endMs: weekEnd.getTime() };
      }
      case "month": {
        const start = new Date(now.getFullYear(), now.getMonth() + this.offset, 1, 0, 0, 0, 0);
        const end = new Date(now.getFullYear(), now.getMonth() + this.offset + 1, 1, 0, 0, 0, 0);
        return { startMs: start.getTime(), endMs: end.getTime() };
      }
      case "year": {
        const year = now.getFullYear() + this.offset;
        const start = new Date(year, 0, 1, 0, 0, 0, 0);
        const end = new Date(year + 1, 0, 1, 0, 0, 0, 0);
        return { startMs: start.getTime(), endMs: end.getTime() };
      }
    }
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
      if (!isFileItem(task)) continue;
      map.set(task.path, task.basename);
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

  private applyHighlights(container: HTMLElement, highlightedPaths: Set<string> | null): void {
    // Toggle highlight/dim classes on calendar blocks without rebuilding DOM
    for (const block of container.querySelectorAll<HTMLElement>(".fmo-calendar-block[data-path]")) {
      block.removeClass("fmo-calendar-block-highlighted", "fmo-calendar-block-dimmed");
      if (highlightedPaths) {
        block.addClass(highlightedPaths.has(block.dataset.path!) ? "fmo-calendar-block-highlighted" : "fmo-calendar-block-dimmed");
      }
    }
    // Toggle opacity on month day bars
    for (const bar of container.querySelectorAll<HTMLElement>(".fmo-calendar-month-day-bar[data-path]")) {
      if (highlightedPaths) {
        bar.style.opacity = highlightedPaths.has(bar.dataset.path!) ? "1" : "0.2";
      } else {
        bar.style.opacity = "";
      }
    }
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
      colorMap.set(sorted[i][0], DASHBOARD_COLORS[i % DASHBOARD_COLORS.length]);
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
    const { spec } = ctx;
    const startFrac = (e.entry.startMs - spec.dayStartMs) / (60 * 60 * 1000);
    const durationHours = e.entry.durationMinutes / 60;
    const top = (startFrac - spec.minHour) * spec.pxPerHour;
    const height = Math.max(BLOCK_MIN_HEIGHT_PX, durationHours * spec.pxPerHour);

    const startDate = new Date(e.entry.startMs);
    const timeLabel = `${pad2(startDate.getHours())}:${pad2(startDate.getMinutes())}`;
    const durationLabel = this.plugin.timeData.formatShortDuration(e.entry.durationMinutes * 60);
    const tooltip = `${e.basename} ${timeLabel} (${durationLabel})`;

    const block = container.createEl("div", { cls: "fmo-calendar-block" });
    block.dataset.path = e.path;
    if (ctx.highlightedPaths) {
      block.addClass(ctx.highlightedPaths.has(e.path) ? "fmo-calendar-block-highlighted" : "fmo-calendar-block-dimmed");
    }
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.fontSize = `${BLOCK_LABEL_FONT_PX}px`;
    block.style.backgroundColor = ctx.colorMap.get(e.path) ?? DASHBOARD_COLORS[0];
    block.title = tooltip;
    if (height >= 12) block.setText(e.basename);

    block.addEventListener("click", () => { void this.plugin.openFile(e.path); });
    this.attachBlockResize(block, container, e, spec);
  }

  private attachBlockResize(
    block: HTMLElement,
    container: HTMLElement,
    e: CalendarEntry,
    spec: CalendarGridSpec
  ): void {
    const handle = block.createEl("div", { cls: "fmo-calendar-block-resize-handle" });
    const endMs = e.entry.startMs + e.entry.durationMinutes * 60 * 1000;

    handle.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.clearCalendarCreateState();

      const gridHeight = this.getGridHeightPx(spec);
      const origEndMs = endMs;
      let lastNewEndMs = origEndMs;

      const move = (moveEv: MouseEvent): void => {
        const localY = this.clientYToLocalY(moveEv.clientY, container, gridHeight);
        const rawMs = this.localYToTimestampMs(localY, spec);
        const snappedMs = Math.round(rawMs / RESIZE_SNAP_MS) * RESIZE_SNAP_MS;
        const newEndMs = Math.max(e.entry.startMs + 60_000, snappedMs);
        lastNewEndMs = newEndMs;

        const newDurationHours = (newEndMs - e.entry.startMs) / (60 * 60 * 1000);
        block.style.height = `${Math.max(BLOCK_MIN_HEIGHT_PX, newDurationHours * spec.pxPerHour)}px`;
      };

      const cleanup = (): void => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.removeClass("fmo-calendar-resizing");
        if (this.activeDragCleanup === cleanup) {
          this.activeDragCleanup = null;
        }
      };

      const up = (): void => {
        cleanup();
        if (lastNewEndMs !== origEndMs) {
          void this.plugin.updateTimeEntryForPath(e.path, e.entry.startMs, origEndMs, lastNewEndMs);
        }
      };

      this.activeDragCleanup = cleanup;
      document.body.addClass("fmo-calendar-resizing");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  private renderDayTimeline(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>,
    highlightedPaths: Set<string> | null,
    window: TimeWindow
  ): void {
    const pxPerHour = this.pxPerHour;
    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * pxPerHour;
    const dayStartMs = window.startMs;

    const timeline = containerEl.createEl("div", { cls: "fmo-calendar-timeline" });
    timeline.style.height = `${gridHeight}px`;

    this.renderHourLabelsAndGridlines(timeline, hourRange, pxPerHour, "fmo-calendar-hour-label");

    const spec: CalendarGridSpec = { dayStartMs, minHour: hourRange.minHour, maxHour: hourRange.maxHour, pxPerHour };
    const ctx: BlockRenderContext = { colorMap, highlightedPaths, spec };
    for (const e of entries) {
      this.renderEntryBlock(timeline, e, ctx);
    }

    this.attachTimeSegmentCreation(timeline, spec);
  }

  private renderWeekGrid(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>,
    highlightedPaths: Set<string> | null,
    window: TimeWindow,
    healthRange: HealthTrackingRangeSnapshot
  ): void {
    const now = new Date();
    const weekStartMs = window.startMs;
    const dayNames = this.getWeekdayLabels();

    const dayEntries: CalendarEntry[][] = Array.from({ length: 7 }, () => []);
    for (const e of entries) {
      const dayIndex = Math.floor(
        (this.plugin.timeData.getDayStart(new Date(e.entry.startMs)).getTime() - weekStartMs) /
        DAY_MS
      );
      if (dayIndex >= 0 && dayIndex < 7) dayEntries[dayIndex].push(e);
    }

    const pxPerHour = this.pxPerHour;
    const hourRange = this.computeHourRange(entries);
    const gridHeight = (hourRange.maxHour - hourRange.minHour) * pxPerHour;
    const todayMs = this.plugin.timeData.getDayStart(now).getTime();
    const todayInRange = todayMs >= weekStartMs && todayMs < weekStartMs + 7 * DAY_MS;

    const wrapper = containerEl.createEl("div", { cls: "fmo-calendar-week-wrapper" });

    // Hour axis
    const hourAxis = wrapper.createEl("div", { cls: "fmo-calendar-week-hour-axis" });
    this.renderWeekHealthAxis(hourAxis);
    const hourAxisBody = hourAxis.createEl("div", { cls: "fmo-calendar-week-hour-axis-body" });
    hourAxisBody.style.height = `${gridHeight}px`;
    this.renderHourLabelsAndGridlines(hourAxisBody, hourRange, pxPerHour, "fmo-calendar-hour-label");

    // Day columns
    const grid = wrapper.createEl("div", { cls: "fmo-calendar-week-grid" });

    for (let d = 0; d < 7; d++) {
      const dayMs = weekStartMs + d * DAY_MS;
      const isToday = todayInRange && dayMs === todayMs;

      const col = grid.createEl("div", { cls: "fmo-calendar-week-col" });

      col.createEl("div", {
        cls: isToday ? "fmo-calendar-day-label fmo-calendar-day-today" : "fmo-calendar-day-label",
        text: `${dayNames[d] ?? ""} ${pad2(new Date(dayMs).getDate())}`
      });

      const dayDate = new Date(dayMs);
      this.renderWeekHealthCells(col, this.getHealthDay(dayDate, healthRange));

      const total = this.getEntryTotalSeconds(dayEntries[d]);
      const totalLabel = total > 0 ? this.plugin.timeData.formatShortDuration(total) : "";
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
      const daySpec: CalendarGridSpec = { dayStartMs: dayMs, minHour: hourRange.minHour, maxHour: hourRange.maxHour, pxPerHour };
      const blockCtx: BlockRenderContext = { colorMap, highlightedPaths, spec: daySpec };
      for (const e of dayEntries[d]) {
        this.renderEntryBlock(dayCol, e, blockCtx);
      }

      this.attachTimeSegmentCreation(dayCol, daySpec);

      // Day total (bottom duplicate)
      col.createEl("div", {
        cls: "fmo-calendar-day-total",
        text: totalLabel
      });
    }
  }

  private renderMonthGrid(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    colorMap: Map<string, string>,
    highlightedPaths: Set<string> | null,
    window: TimeWindow,
    healthRange: HealthTrackingRangeSnapshot
  ): void {
    const now = new Date();
    const monthStart = new Date(window.startMs);
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const dayNames = this.getWeekdayLabels();

    // First day of month's weekday offset
    const firstDayDate = new Date(year, month, 1);
    const firstWeekday = firstDayDate.getDay(); // 0=Sun
    const weekStartsOn = this.plugin.settings.weekStartsOn === "sunday" ? 0 : 1;
    const startOffset = (firstWeekday - weekStartsOn + 7) % 7;

    const dayBuckets = this.buildDayBuckets(entries, window);
    const maxSeconds = this.getMaxBucketSeconds(dayBuckets);

    const todayMs = this.plugin.timeData.getDayStart(now).getTime();

    const grid = containerEl.createEl("div", { cls: "fmo-calendar-month-grid" });

    // Day name headers
    for (const name of dayNames) {
      grid.createEl("div", { cls: "fmo-calendar-month-header", text: name });
    }

    // Leading empty cells
    for (let i = 0; i < startOffset; i++) {
      grid.createEl("div", { cls: "fmo-calendar-month-cell fmo-calendar-month-cell-empty" });
    }

    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
      const dayMs = new Date(year, month, d, 0, 0, 0, 0).getTime();
      const isToday = dayMs === todayMs;
      const dayDate = new Date(dayMs);
      const dateKey = this.getDateKey(dayDate);
      const bucket = dayBuckets.get(dateKey);
      const healthDay = this.getHealthDay(dayDate, healthRange);
      const totalSeconds = bucket?.totalSeconds ?? 0;
      const intensity = this.getIntensityRatio(totalSeconds, maxSeconds);

      const cell = grid.createEl("div", {
        cls: isToday
          ? "fmo-calendar-month-cell fmo-calendar-month-cell-today"
          : "fmo-calendar-month-cell"
      });

      if (totalSeconds > 0) {
        cell.style.backgroundColor = `color-mix(in srgb, var(--interactive-accent) ${Math.round(8 + intensity * 42)}%, transparent)`;
      }

      const dayLabel = cell.createEl("div", { cls: "fmo-calendar-month-day-num", text: `${d}` });
      if (isToday) dayLabel.addClass("fmo-calendar-day-today");

      if (totalSeconds > 0) {
        cell.createEl("div", {
          cls: "fmo-calendar-month-day-time",
          text: this.plugin.timeData.formatShortDuration(totalSeconds)
        });
      }

      this.renderMonthHealthSignals(cell, healthDay);

      if (totalSeconds > 0) {
        // Colored concern bars
        const bars = cell.createEl("div", { cls: "fmo-calendar-month-day-bars" });
        const secondsByPath = bucket?.secondsByPath ?? new Map<string, number>();
        for (const [path, secs] of [...secondsByPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
          const bar = bars.createEl("div", { cls: "fmo-calendar-month-day-bar" });
          bar.dataset.path = path;
          const color = colorMap.get(path) ?? DASHBOARD_COLORS[0];
          bar.style.backgroundColor = color;
          const ratio = totalSeconds > 0 ? secs / totalSeconds : 0;
          bar.style.flex = `${ratio}`;
          if (highlightedPaths) {
            bar.style.opacity = highlightedPaths.has(path) ? "1" : "0.2";
          }
        }
      }

      cell.title = this.buildCalendarDayTitle(year, month, d, totalSeconds, healthDay);
    }
  }

  private buildYearWeeks(year: number): CalendarYearSlot[][] {
    const weekStartsOn = this.plugin.settings.weekStartsOn === "sunday" ? 0 : 1;
    const weeks: CalendarYearSlot[][] = [];
    let currentDate = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);

    const firstDayOfWeek = (currentDate.getDay() - weekStartsOn + 7) % 7;
    let currentWeek: CalendarYearSlot[] = Array.from({ length: firstDayOfWeek }, () => null);

    while (currentDate < yearEnd) {
      const dayOfWeek = (currentDate.getDay() - weekStartsOn + 7) % 7;
      if (dayOfWeek === 0 && currentWeek.length > 0) {
        while (currentWeek.length < 7) currentWeek.push(null);
        weeks.push(currentWeek);
        currentWeek = [];
      }
      currentWeek.push({ date: new Date(currentDate), key: this.getDateKey(currentDate) });
      currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 1);
    }

    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) currentWeek.push(null);
      weeks.push(currentWeek);
    }

    return weeks;
  }

  private getMonthStartWeekByIndex(weeks: CalendarYearSlot[][]): Map<number, number> {
    const monthStartWeekByIndex = new Map<number, number>();
    for (let weekIndex = 0; weekIndex < weeks.length; weekIndex++) {
      for (const slot of weeks[weekIndex]) {
        if (slot && slot.date.getDate() === 1) {
          monthStartWeekByIndex.set(slot.date.getMonth(), weekIndex);
          break;
        }
      }
    }
    return monthStartWeekByIndex;
  }

  private renderYearHeatmap(
    containerEl: HTMLElement,
    entries: CalendarEntry[],
    window: TimeWindow,
    healthRange: HealthTrackingRangeSnapshot
  ): void {
    const now = new Date();
    const yearStart = new Date(window.startMs);
    const year = yearStart.getFullYear();
    const dayBuckets = this.buildDayBuckets(entries, window);
    const maxSeconds = this.getMaxBucketSeconds(dayBuckets);
    const dayLabels = this.getWeekdayLabels();

    const wrapper = containerEl.createEl("div", { cls: "fmo-calendar-year-wrapper" });
    const weeks = this.buildYearWeeks(year);

    const monthLabelRow = wrapper.createEl("div", { cls: "fmo-calendar-year-month-row" });
    monthLabelRow.createEl("div", { cls: "fmo-calendar-year-day-label-spacer" });
    const monthTrack = monthLabelRow.createEl("div", { cls: "fmo-calendar-year-month-track" });
    monthTrack.style.setProperty("--year-cols", `${weeks.length}`);
    const monthStartWeekByIndex = this.getMonthStartWeekByIndex(weeks);
    for (let monthIdx = 0; monthIdx < MONTH_NAMES.length; monthIdx++) {
      const weekIndex = monthStartWeekByIndex.get(monthIdx);
      if (weekIndex == null) continue;
      const monthLabel = monthTrack.createEl("div", {
        cls: "fmo-calendar-year-month-label",
        text: MONTH_NAMES[monthIdx].slice(0, 3)
      });
      monthLabel.style.gridColumn = `${weekIndex + 1}`;
    }

    const todayKey = this.getDateKey(this.plugin.timeData.getDayStart(now));

    const body = wrapper.createEl("div", { cls: "fmo-calendar-year-body" });
    const dayLabelColumn = body.createEl("div", { cls: "fmo-calendar-year-day-labels" });
    for (let row = 0; row < 7; row++) {
      dayLabelColumn.createEl("div", {
        cls: "fmo-calendar-year-day-label",
        text: row % 2 === 0 ? dayLabels[row] : ""
      });
    }

    const grid = body.createEl("div", { cls: "fmo-calendar-year-grid" });
    for (let w = 0; w < weeks.length; w++) {
      const weekEl = grid.createEl("div", { cls: "fmo-calendar-year-week" });
      for (let row = 0; row < 7; row++) {
        const slot = weeks[w][row];
        const cell = weekEl.createEl("div", { cls: "fmo-calendar-year-cell" });

        if (!slot) {
          cell.addClass("fmo-calendar-year-cell-empty");
          continue;
        }

        const totalSeconds = dayBuckets.get(slot.key)?.totalSeconds ?? 0;
        cell.dataset.level = this.getYearHeatmapLevel(totalSeconds, maxSeconds);

        if (slot.key === todayKey) {
          cell.addClass("fmo-calendar-year-cell-today");
        }

        const d = slot.date;
        cell.title = this.buildCalendarDayTitle(
          d.getFullYear(),
          d.getMonth(),
          d.getDate(),
          totalSeconds,
          this.getHealthDay(d, healthRange)
        );
      }
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
    const taskFiles = this.plugin.getTaskTreeItems().filter(isFileItem).map((item) => item.file);
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
