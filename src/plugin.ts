import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, normalizePath, type FrontMatterCache, type WorkspaceLeaf } from "obsidian";
import type { ListEntry, TaskItem, TimeLogByNoteId, TimeLogEntry } from "./models/types";
import {
  DEFAULT_TIME_LOG_PATH,
  DEFAULT_SETTINGS,
  type LifeDashboardSettings
} from "./settings";
import { DashboardViewController } from "./services/dashboard-view-controller";
import {
  MacOsTrayTimerService,
  MAX_MACOS_TRAY_RECENT_CONCERNS,
  type MacOsTrayRecentConcern
} from "./services/macos-tray-timer-service";
import { TaskFilterService } from "./services/task-filter-service";
import { TimeLogStore } from "./services/time-log-store";
import { TimeWindowService, type OutlineTimeRange as OutlineTimeRangeType, type PeriodTooltipRange as PeriodTooltipRangeType, type TimeWindow as TimeWindowType } from "./services/time-window-service";
import { TimerNotificationService } from "./services/timer-notification-service";
import { TrackingService } from "./services/tracking-service";
import { normalizePriorityValue } from "./services/priority-utils";
import { LifeDashboardSettingTab } from "./ui/life-dashboard-setting-tab";
import { ListEntrySearchModal } from "./ui/list-entry-search-modal";
import { TaskSelectModal } from "./ui/task-select-modal";
import {
  LifeDashboardBeancountView,
  LifeDashboardCalendarView,
  LifeDashboardConcernCanvasView,
  LifeDashboardOutlineView,
  LifeDashboardTimeLogView,
  LifeDashboardTimerView
} from "./ui/views";
import {
  LIFE_DASHBOARD_VIEW_TYPES,
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  VIEW_TYPE_LIFE_DASHBOARD_TIMELOG,
  VIEW_TYPE_LIFE_DASHBOARD_TIMER,
  VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT
} from "./models/view-types";
import { createKanbanViewRegistration, KANBAN_BASES_VIEW_ID } from "./ui/bases/kanban-bases-view";

export type OutlineTimeRange = OutlineTimeRangeType;
type PeriodTooltipRange = PeriodTooltipRangeType;
export type TimeWindow = TimeWindowType;
type PowerMonitorEvent = "suspend" | "lock-screen";
const AUTO_STOP_POWER_EVENTS: PowerMonitorEvent[] = ["suspend", "lock-screen"];
type MainProcessPowerMonitor = {
  on: (event: PowerMonitorEvent, listener: () => void) => void;
  off?: (event: PowerMonitorEvent, listener: () => void) => void;
  removeListener?: (event: PowerMonitorEvent, listener: () => void) => void;
};
type ElectronMainLike = {
  powerMonitor?: MainProcessPowerMonitor;
};
type ElectronWithRemoteLike = {
  shell?: { beep?: () => void };
  remote?: ElectronMainLike;
};
const LIFE_DASHBOARD_VIEW_TYPE_SET = new Set<string>(LIFE_DASHBOARD_VIEW_TYPES);
const PRIORITY_FRONTMATTER_KEY = "priority";
type ConcernPickerOptions = {
  onChoose: (file: TFile) => void;
  onCloseWithoutChoice?: () => void;
  placeholder?: string;
  showPathInSuggestion?: boolean;
  emptyNotice?: string;
};
type NoteTaskInfo = {
  path: string;
  label: string;
};

export default class LifeDashboardPlugin extends Plugin {
  settings!: LifeDashboardSettings;
  timeTotalsById: Map<string, number> = new Map();
  timeEntriesById: Map<string, TimeLogEntry[]> = new Map();
  highlightedTimeLogStartMs: number | null = null;

  private taskFilterService!: TaskFilterService;
  private timeLogStore!: TimeLogStore;
  private timeWindowService!: TimeWindowService;
  private timerNotificationService!: TimerNotificationService;
  private trackingService!: TrackingService;
  private viewController!: DashboardViewController;
  private startupTotalsLoadStarted = false;
  private outlineFilterSaveTimer: number | null = null;
  private canvasDraftSaveTimer: number | null = null;
  private notificationPermissionRequested = false;
  private powerAutoStopInFlight: Promise<void> | null = null;
  private removePowerMonitorListeners: Array<() => void> = [];
  private timeLogFsWatcher: import("fs").FSWatcher | null = null;
  private timeLogReloadDebounce: number | null = null;
  private watchedTimeLogPath = "";
  private watchedTimeLogAbsolutePath = "";
  private watchedTimeLogHash: string | null = null;
  private macOsTrayTimerService!: MacOsTrayTimerService;
  private macOsTrayRecentConcerns: MacOsTrayRecentConcern[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    this.initializeServices();
    this.registerMainProcessPowerMonitorAutoStop();

    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMER, (leaf) => new LifeDashboardTimerView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_OUTLINE, (leaf) => new LifeDashboardOutlineView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CANVAS, (leaf) => new LifeDashboardConcernCanvasView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CALENDAR, (leaf) => new LifeDashboardCalendarView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMELOG, (leaf) => new LifeDashboardTimeLogView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT, (leaf) => new LifeDashboardBeancountView(leaf));
    this.registerExtensions(["beancount"], VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT);
    this.registerBasesView(KANBAN_BASES_VIEW_ID, createKanbanViewRegistration(this));

    this.addRibbonIcon("list-tree", "Open Life Dashboard", () => {
      void this.activateView();
    });

    this.addRibbonIcon("network", "Open Concerns Canvas", () => {
      void this.viewController.activateCanvasView();
    });

    this.addRibbonIcon("timer", "Open Timer", () => {
      void this.viewController.activateTimerView();
    });

    this.addRibbonIcon("list", "Open Concerns Outline", () => {
      void this.viewController.activateOutlineView();
    });

    this.addRibbonIcon("calendar", "Open Concerns Calendar", () => {
      void this.viewController.activateCalendarView();
    });

    this.addRibbonIcon("history", "Open Time Log", () => {
      void this.viewController.activateTimeLogView();
    });

    this.addCommand({
      id: "open-life-dashboard",
      name: "Open Life Dashboard",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "open-concerns-canvas",
      name: "Open Concerns Canvas",
      callback: () => {
        void this.viewController.activateCanvasView();
      }
    });

    this.addCommand({
      id: "open-timer",
      name: "Open Timer",
      callback: () => {
        void this.viewController.activateTimerView();
      }
    });

    this.addCommand({
      id: "open-concerns-outline",
      name: "Open Concerns Outline",
      callback: () => {
        void this.viewController.activateOutlineView();
      }
    });

    this.addCommand({
      id: "open-calendar",
      name: "Open Concerns Calendar",
      callback: () => {
        void this.viewController.activateCalendarView();
      }
    });

    this.addCommand({
      id: "open-time-log",
      name: "Open Time Log",
      callback: () => {
        void this.viewController.activateTimeLogView();
      }
    });

    this.addCommand({
      id: "select-concern",
      name: "Quick Open Concern",
      callback: () => {
        this.openConcernQuickSearch();
      }
    });

    this.addCommand({
      id: "start-time-tracking",
      name: "Start task timer",
      callback: () => {
        void this.startTracking();
      }
    });

    this.addCommand({
      id: "stop-time-tracking",
      name: "Stop task timer",
      callback: () => {
        void this.stopTracking();
      }
    });

    this.addCommand({
      id: "reset-all-concern-priorities",
      name: "Reset all concern priorities",
      callback: () => {
        void this.resetAllConcernPriorities();
      }
    });

    this.addCommand({
      id: "search-list-entries",
      name: "Search list entries in current file",
      callback: () => {
        void this.openListEntrySearch();
      }
    });

    this.addCommand({
      id: "create-concerns-kanban",
      name: "Create Concerns Kanban board",
      callback: () => {
        void this.createConcernsKanbanBase();
      }
    });

    this.addSettingTab(new LifeDashboardSettingTab(this.app, this));

    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.handleTaskStructureChange();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.handleVaultRename(file, oldPath);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.handleVaultDelete(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        void this.handleVaultCreate(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.isTimeLogPath(file.path)) {
          void this.reloadTotalsAndRefresh();
        }
      })
    );

    this.rewireTimeLogWatcher();

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        void this.persistVisibilityState();
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.maybeAutoSelectFromActive();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.scheduleStartupTotalsLoad();
      void this.maybeAutoSelectFromActive();
      this.refreshView();
    });

    this.macOsTrayTimerService.syncEnabled(this.settings.macOsTrayTimerEnabled, false);
    this.updateMacOsTrayTimer();

    this.registerInterval(
      window.setInterval(() => {
        this.pushLiveTimerUpdate();
      }, 1000)
    );
  }

  async onunload(): Promise<void> {
    this.macOsTrayTimerService.destroy();
    this.clearPowerMonitorListeners();
    this.closeTimeLogFsWatcher();

    if (this.outlineFilterSaveTimer !== null) {
      window.clearTimeout(this.outlineFilterSaveTimer);
      this.outlineFilterSaveTimer = null;
    }
    if (this.canvasDraftSaveTimer !== null) {
      window.clearTimeout(this.canvasDraftSaveTimer);
      this.canvasDraftSaveTimer = null;
    }
    await this.saveSettings();

    await this.trackingService.flushActiveTrackingOnUnload();
    await this.persistVisibilityState(true);
  }

  getTaskTreeItems(): TaskItem[] {
    return this.taskFilterService.getTaskTreeItems();
  }

  async postFilterSettingsChanged(): Promise<void> {
    this.taskFilterService.invalidateCache();
    await this.maybeAutoSelectFromActive();
    this.refreshTaskStructureViews();
  }

  async onTimeLogPathSettingChanged(): Promise<void> {
    const normalized = this.getNormalizedTimeLogPath();
    if (this.settings.timeLogPath !== normalized) {
      this.settings.timeLogPath = normalized;
      await this.saveSettings();
    }
    this.rewireTimeLogWatcher();
    await this.reloadTotalsAndRefresh();
  }

  onMacOsTrayTimerSettingChanged(): void {
    this.macOsTrayTimerService.syncEnabled(this.settings.macOsTrayTimerEnabled, true);
    this.updateMacOsTrayTimer();
  }

  private async maybeAutoSelectFromActive(): Promise<void> {
    if (this.settings.activeTrackingStart) return;

    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) return;

    let concernPath: string;
    if (this.taskFilterService.fileMatchesTaskFilter(file)) {
      concernPath = file.path;
    } else {
      // For non-concern notes, auto-select the concern that wikilinks to this note
      // (only when exactly one concern references it)
      const single = this.findSingleReferencingConcern(file);
      if (!single) return;
      concernPath = single;
    }

    if (this.settings.selectedTaskPath === concernPath) return;

    this.settings.selectedTaskPath = concernPath;
    await this.saveSettings();
    this.refreshTaskStructureViews();
  }

  /** Returns the concern path if exactly one concern has a wikilink to the given file, null otherwise. */
  private findSingleReferencingConcern(file: TFile): string | null {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    let foundPath: string | null = null;
    for (const concern of this.taskFilterService.getTaskTreeItems()) {
      const outgoing = resolvedLinks[concern.file.path];
      if (outgoing && file.path in outgoing) {
        if (foundPath !== null) return null;
        foundPath = concern.file.path;
      }
    }

    return foundPath;
  }

  getActiveTaskPath(): string {
    return this.trackingService.getActiveTaskPath();
  }

  getCurrentElapsedSeconds(): number {
    return this.trackingService.getCurrentElapsedSeconds();
  }

  getExtendTrackingBySecondsAvailable(): number {
    const start = this.getActiveTrackingStartMs();
    if (start == null) return 0;

    const latestEndMs = this.getLatestTrackedEndMs();
    return Math.max(0, Math.floor((start - latestEndMs) / 1000));
  }

  async extendActiveTrackingByMinutes(minutes: number): Promise<number> {
    const safeMinutes = Math.max(0, Math.floor(minutes));
    if (safeMinutes <= 0) return 0;

    const start = this.getActiveTrackingStartMs();
    if (start == null) return 0;

    const requestedSeconds = safeMinutes * 60;
    const allowedSeconds = this.getExtendTrackingBySecondsAvailable();
    const applySeconds = Math.min(requestedSeconds, allowedSeconds);
    if (applySeconds <= 0) return 0;

    this.settings.activeTrackingStart = start - applySeconds * 1000;
    await this.saveSettings();
    this.refreshTimeTrackingViews();
    return applySeconds;
  }

  async setSelectedTaskPath(path: string): Promise<void> {
    if (this.settings.selectedTaskPath === path) return;
    this.settings.selectedTaskPath = path;
    await this.saveSettings();
    this.refreshTaskStructureViews();
  }

  private openConcernQuickSearch(): void {
    const targetLeaf = this.getConcernQuickOpenTargetLeaf();
    this.openConcernPicker({
      onChoose: (file) => {
        void targetLeaf.openFile(file, { active: true });
      },
      placeholder: "Find concern note...",
      showPathInSuggestion: false,
      emptyNotice: "No concerns available to open."
    });
  }

  private async openListEntrySearch(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file.");
      return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const rootListItems = cache?.listItems?.filter((li) => li.parent < 0);
    if (!rootListItems || rootListItems.length === 0) {
      new Notice("No top-level list entries found.");
      return;
    }

    const text = await this.app.vault.cachedRead(file);
    const lines = text.split("\n");
    const entries: ListEntry[] = [];
    for (const li of rootListItems) {
      const line = li.position.start.line;
      const raw = lines[line] ?? "";
      const content = raw.replace(/^[-*+]\s+/, "");
      if (content) {
        entries.push({ text: content, textLower: content.toLowerCase(), line });
      }
    }

    if (entries.length === 0) {
      new Notice("No top-level list entries found.");
      return;
    }

    const modal = new ListEntrySearchModal(this.app, entries, (entry) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.editor) {
        const pos = { line: entry.line, ch: 0 };
        view.editor.setCursor(pos);
        view.editor.scrollIntoView({ from: pos, to: pos }, true);
      }
    });
    modal.open();
  }

  openConcernPicker(options: ConcernPickerOptions): void {
    const taskFiles = this.getTaskTreeItems().map((item) => item.file);
    if (taskFiles.length === 0) {
      new Notice(options.emptyNotice ?? "No concerns available.");
      options.onCloseWithoutChoice?.();
      return;
    }

    const modal = new TaskSelectModal(
      this.app,
      taskFiles,
      options.onChoose,
      options.onCloseWithoutChoice,
      {
        placeholder: options.placeholder,
        showPathInSuggestion: options.showPathInSuggestion
      }
    );
    modal.open();
  }

  private getConcernQuickOpenTargetLeaf(): WorkspaceLeaf {
    const mostRecentLeaf = this.app.workspace.getMostRecentLeaf();
    if (mostRecentLeaf && !this.isLifeDashboardLeaf(mostRecentLeaf)) {
      return mostRecentLeaf;
    }

    const markdownLeaf = this.app.workspace.getLeavesOfType("markdown")[0];
    if (markdownLeaf) {
      return markdownLeaf;
    }

    return this.app.workspace.getLeaf("tab");
  }

  private isLifeDashboardLeaf(leaf: WorkspaceLeaf): boolean {
    return LIFE_DASHBOARD_VIEW_TYPE_SET.has(leaf.getViewState().type);
  }

  getOutlineFilterQuery(): string {
    return this.settings.outlineFilterQuery || "";
  }

  setOutlineFilterQuery(query: string): void {
    if (this.settings.outlineFilterQuery === query) return;
    this.settings.outlineFilterQuery = query;
    this.scheduleOutlineFilterSave();
  }

  getCanvasDraftState(): string {
    return this.settings.canvasDraftState || "";
  }

  setCanvasDraftState(state: string): void {
    if (this.settings.canvasDraftState === state) return;
    this.settings.canvasDraftState = state;
    this.scheduleCanvasDraftSave();
  }

  getCalendarTreePanelState(): string {
    return this.settings.calendarTreePanelState || "";
  }

  setCalendarTreePanelState(state: string): void {
    if (this.settings.calendarTreePanelState === state) return;
    this.settings.calendarTreePanelState = state;
    void this.saveSettings();
  }

  async activateView(): Promise<void> {
    await this.viewController.activateView();
  }

  async activateTimeLogView(): Promise<void> {
    await this.viewController.activateTimeLogView();
  }

  async ensureTaskId(file: TFile): Promise<string> {
    return this.ensureTaskIdForFile(file);
  }

  async startTracking(): Promise<void> {
    await this.trackingService.startTracking();
  }

  async stopTracking(): Promise<void> {
    await this.trackingService.stopTracking();
    await this.maybeAutoSelectFromActive();
  }

  async reloadTimeTotals(): Promise<void> {
    const snapshot = await this.timeLogStore.loadSnapshot();
    this.timeTotalsById = snapshot.totals;
    this.timeEntriesById = snapshot.entriesByNoteId;
    this.recomputeMacOsTrayRecentConcerns();
  }

  async readTimeLog(): Promise<TimeLogByNoteId> {
    return this.timeLogStore.readTimeLogMap();
  }

  async saveTimeLog(data: TimeLogByNoteId): Promise<void> {
    await this.timeLogStore.writeTimeLogMap(data);
    await this.reloadTimeTotals();
    this.refreshTimeTrackingViews();
  }

  async appendTimeEntryForPath(path: string, startMs: number, endMs: number): Promise<boolean> {
    const normalizedStartMs = Math.min(startMs, endMs);
    const normalizedEndMs = Math.max(startMs, endMs);
    if (!Number.isFinite(normalizedStartMs) || !Number.isFinite(normalizedEndMs)) return false;
    if (normalizedEndMs <= normalizedStartMs) return false;

    return this.withNoteIdForPath(path, (noteId) =>
      this.timeLogStore.appendTimeEntry(noteId, normalizedStartMs, normalizedEndMs)
    );
  }

  async updateTimeEntryForPath(path: string, startMs: number, oldEndMs: number, newEndMs: number): Promise<boolean> {
    if (!Number.isFinite(startMs) || !Number.isFinite(oldEndMs) || !Number.isFinite(newEndMs)) return false;
    if (newEndMs <= startMs) return false;

    return this.withNoteIdForPath(path, (noteId) =>
      this.timeLogStore.updateTimeEntry(noteId, startMs, oldEndMs, newEndMs)
    );
  }

  private async withNoteIdForPath(path: string, action: (noteId: string) => Promise<void>): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;

    const noteId = await this.ensureTaskIdForFile(file);
    if (!noteId) return false;

    await action(noteId);
    await this.reloadTimeTotals();
    this.refreshTimeTrackingViews();
    return true;
  }

  async setConcernPriority(path: string, priority: string): Promise<boolean> {
    const normalizedPriority = normalizePriorityValue(priority);
    if (!normalizedPriority) return false;

    return this.updateConcernFrontmatter(
      path,
      (fm) => {
        const currentRaw = fm[PRIORITY_FRONTMATTER_KEY];
        const current =
          currentRaw == null
            ? ""
            : String(currentRaw).trim().toLowerCase();
        if (current === normalizedPriority) return false;
        fm[PRIORITY_FRONTMATTER_KEY] = normalizedPriority;
        return true;
      },
      "Could not update frontmatter priority"
    );
  }

  async clearConcernPriority(path: string): Promise<boolean> {
    return this.updateConcernFrontmatter(
      path,
      (fm) => {
        if (!Object.prototype.hasOwnProperty.call(fm, PRIORITY_FRONTMATTER_KEY)) return false;
        delete fm[PRIORITY_FRONTMATTER_KEY];
        return true;
      },
      "Could not remove frontmatter priority"
    );
  }

  async resetAllConcernPriorities(): Promise<void> {
    const concernItems = this.getTaskTreeItems();
    const paths = concernItems
      .filter((item) =>
        Object.prototype.hasOwnProperty.call(item.frontmatter ?? {}, PRIORITY_FRONTMATTER_KEY)
      )
      .map((item) => item.file.path);

    if (concernItems.length === 0) {
      new Notice("No concerns found.");
      return;
    }

    if (paths.length === 0) {
      new Notice("No concern priorities found to reset.");
      return;
    }

    let clearedCount = 0;
    for (const path of paths) {
      const changed = await this.clearConcernPriority(path);
      if (changed) clearedCount += 1;
    }

    new Notice(
      clearedCount === 1
        ? "Reset priority on 1 concern."
        : `Reset priority on ${clearedCount} concerns.`
    );
  }

  private async updateConcernFrontmatter(
    path: string,
    mutate: (fm: Record<string, unknown>) => boolean,
    errorPrefix: string
  ): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;

    let changed = false;
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        changed = mutate(fm as Record<string, unknown>) || changed;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`${errorPrefix}: ${message}`);
      return false;
    }

    return changed;
  }

  buildNoteIdToBasenameMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [noteId, info] of this.buildNoteIdToTaskInfoMap()) {
      map.set(noteId, info.label);
    }
    return map;
  }

  getTrackedSeconds(path: string): number {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return 0;
    const noteId = this.getTaskIdForFile(file);
    if (!noteId) return 0;
    return this.timeTotalsById.get(noteId) ?? 0;
  }

  getTrackedSecondsForRange(path: string, range: OutlineTimeRange): number {
    if (range === "all") {
      return this.getTrackedSeconds(path);
    }

    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) return 0;

    const window = this.getWindowForRange(range, new Date());
    return this.sumSecondsInWindow(entries, window);
  }

  getLatestTrackedStartMsForRange(path: string, range: OutlineTimeRange): number {
    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) return 0;

    if (range === "all") {
      return entries.reduce((latest, entry) => Math.max(latest, entry.startMs), 0);
    }

    const window = this.getWindowForRange(range, new Date());
    let latest = 0;
    for (const entry of entries) {
      const overlapStartMs = this.timeWindowService.getEntryOverlapStartMs(entry, window);
      if (overlapStartMs != null && overlapStartMs > latest) {
        latest = overlapStartMs;
      }
    }
    return latest;
  }

  getConcernPeriodSummary(path: string): {
    todayEntries: Array<{ label: string; startMs: number }>;
    todaySeconds: number;
    yesterdaySeconds: number;
    weekSeconds: number;
  } {
    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) {
      return {
        todayEntries: [],
        todaySeconds: 0,
        yesterdaySeconds: 0,
        weekSeconds: 0
      };
    }

    const pad = (n: number): string => String(n).padStart(2, "0");
    const now = new Date();
    const todayWindow = this.getWindowForRange("today", now);
    const yesterdayWindow = {
      startMs: todayWindow.startMs - 24 * 60 * 60 * 1000,
      endMs: todayWindow.startMs
    };
    const weekWindow = this.getWindowForRange("week", now);

    const todayEntries = entries
      .map((entry) => {
        const overlapSeconds = this.timeWindowService.getEntryOverlapSeconds(entry, todayWindow);
        const overlapStartMs = this.timeWindowService.getEntryOverlapStartMs(entry, todayWindow);
        return { entry, overlapSeconds, overlapStartMs };
      })
      .filter(
        (item): item is { entry: TimeLogEntry; overlapSeconds: number; overlapStartMs: number } =>
          item.overlapSeconds > 0 && item.overlapStartMs != null
      )
      .sort((a, b) => a.overlapStartMs - b.overlapStartMs)
      .map(({ entry, overlapSeconds, overlapStartMs }) => {
        const start = new Date(overlapStartMs);
        const hhmm = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
        const label = `${hhmm} ${this.formatShortDuration(overlapSeconds)}`;
        return { label, startMs: entry.startMs };
      });
    const todaySeconds = this.sumSecondsInWindow(entries, todayWindow);
    const yesterdaySeconds = this.sumSecondsInWindow(entries, yesterdayWindow);
    const weekSeconds = this.sumSecondsInWindow(entries, weekWindow);

    return { todayEntries, todaySeconds, yesterdaySeconds, weekSeconds };
  }

  getTimeRangeDescription(range: PeriodTooltipRange): string {
    return this.timeWindowService.getTimeRangeDescription(range, new Date());
  }

  formatClockDuration(totalSeconds: number): string {
    return this.timeWindowService.formatClockDuration(totalSeconds);
  }

  formatShortDuration(totalSeconds: number): string {
    return this.timeWindowService.formatShortDuration(totalSeconds);
  }

  async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(true);
    if (!leaf) return;

    await leaf.openFile(file, { active: true });
  }

  private async createConcernsKanbanBase(): Promise<void> {
    const basePath = "Concerns Kanban.base";
    let file = this.app.vault.getAbstractFileByPath(basePath);

    if (!file) {
      const propName = this.settings.propertyName.trim() || "type";
      const propValue = this.settings.propertyValue.trim() || "concen";

      const yaml = [
        "views:",
        `  - type: ${KANBAN_BASES_VIEW_ID}`,
        "    name: Kanban",
        "    filters:",
        "      and:",
        `        - ${propName} == "${propValue}"`,
        ""
      ].join("\n");

      try {
        file = await this.app.vault.create(basePath, yaml);
      } catch {
        file = this.app.vault.getAbstractFileByPath(basePath);
      }
    }

    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
    }
  }

  refreshView(): void {
    this.viewController.refreshView();
  }

  private refreshTaskStructureViews(): void {
    this.viewController.refreshTaskStructureViews();
  }

  private refreshTimeTrackingViews(): void {
    this.viewController.refreshTimeTrackingViews();
    this.updateMacOsTrayTimer();
  }

  private pushLiveTimerUpdate(): void {
    this.viewController.pushLiveTimerUpdate();
    this.handleTimerNotifications();
    this.updateMacOsTrayTimer();
  }

  private async persistVisibilityState(force = false): Promise<void> {
    await this.viewController.persistVisibilityState(force);
  }

  private initializeServices(): void {
    this.taskFilterService = new TaskFilterService(this.app, this.settings);
    this.timeLogStore = new TimeLogStore(this.app, this.settings, () => this.saveSettings());
    this.timeWindowService = new TimeWindowService(() => this.settings.weekStartsOn);
    this.timerNotificationService = new TimerNotificationService();
    this.macOsTrayTimerService = new MacOsTrayTimerService({
      openTimer: () => {
        void this.viewController.activateTimerView();
      },
      startTimer: () => {
        void this.startTracking();
      },
      stopTimer: () => {
        void this.stopTracking();
      },
      startRecentConcern: (path) => {
        void this.selectConcernForTrayAndStartTracking(path);
      }
    });
    this.viewController = new DashboardViewController(this.app, this.settings, () => this.saveSettings());

    this.trackingService = new TrackingService({
      app: this.app,
      settings: this.settings,
      saveSettings: () => this.saveSettings(),
      refreshView: () => this.refreshTimeTrackingViews(),
      fileMatchesTaskFilter: (file) => this.taskFilterService.fileMatchesTaskFilter(file),
      ensureTaskIdForFile: (file) => this.ensureTaskIdForFile(file),
      appendTimeEntry: (noteId, startMs, endMs) => this.timeLogStore.appendTimeEntry(noteId, startMs, endMs),
      reloadTimeTotals: () => this.reloadTimeTotals()
    });

    this.viewController.syncLastPersistedVisibility();
  }

  private registerMainProcessPowerMonitorAutoStop(): void {
    const powerMonitor = this.getMainProcessPowerMonitor();
    if (!powerMonitor || typeof powerMonitor.on !== "function") {
      return;
    }

    const subscribe = (event: PowerMonitorEvent): void => {
      const handler = (): void => {
        this.requestPowerAutoStop(event);
      };
      powerMonitor.on(event, handler);
      this.removePowerMonitorListeners.push(() => {
        if (typeof powerMonitor.off === "function") {
          powerMonitor.off(event, handler);
          return;
        }
        if (typeof powerMonitor.removeListener === "function") {
          powerMonitor.removeListener(event, handler);
        }
      });
    };

    for (const event of AUTO_STOP_POWER_EVENTS) {
      subscribe(event);
    }
  }

  private getMainProcessPowerMonitor(): MainProcessPowerMonitor | null {
    const req = (window as unknown as { require?: (id: string) => unknown }).require;
    if (!req) return null;

    try {
      const electronMain = req("electron/main") as ElectronMainLike | undefined;
      if (electronMain?.powerMonitor) {
        return electronMain.powerMonitor;
      }
    } catch {
      // ignore and try remote bridge
    }

    try {
      const electron = req("electron") as ElectronWithRemoteLike | undefined;
      if (electron?.remote?.powerMonitor) {
        return electron.remote.powerMonitor;
      }
    } catch {
      // ignore
    }

    return null;
  }

  private requestPowerAutoStop(source: PowerMonitorEvent): void {
    if (!this.settings.activeTrackingStart) return;
    if (this.powerAutoStopInFlight) return;

    this.powerAutoStopInFlight = this.stopTracking()
      .catch((error) => {
        console.error("[life-dashboard] Failed to auto-stop timer from power event:", source, error);
      })
      .finally(() => {
        this.powerAutoStopInFlight = null;
      });
  }

  private clearPowerMonitorListeners(): void {
    for (const remove of this.removePowerMonitorListeners) {
      remove();
    }
    this.removePowerMonitorListeners = [];
  }

  private updateMacOsTrayTimer(): void {
    const isTracking = Boolean(this.settings.activeTrackingStart);
    const elapsedSeconds = isTracking ? this.getCurrentElapsedSeconds() : 0;
    const recentConcerns = isTracking ? [] : this.getMacOsTrayRecentConcerns();
    this.macOsTrayTimerService.update({
      enabled: this.settings.macOsTrayTimerEnabled,
      isTracking,
      elapsedLabel: this.formatClockDuration(elapsedSeconds),
      taskLabel: this.getMacOsTrayTaskLabel(),
      recentConcerns
    });
  }

  private getMacOsTrayTaskLabel(): string {
    const taskPath = this.getActiveTaskPath();
    if (!taskPath) return "";
    const file = this.app.vault.getAbstractFileByPath(taskPath);
    if (file instanceof TFile) {
      return file.basename;
    }
    const parts = taskPath.split("/");
    return parts[parts.length - 1] || taskPath;
  }

  private getMacOsTrayRecentConcerns(): MacOsTrayRecentConcern[] {
    return this.macOsTrayRecentConcerns.slice(0, MAX_MACOS_TRAY_RECENT_CONCERNS);
  }

  private async selectConcernForTrayAndStartTracking(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !this.taskFilterService.fileMatchesTaskFilter(file)) {
      new Notice("Could not start tracking this concern from tray.");
      this.recomputeMacOsTrayRecentConcerns();
      this.updateMacOsTrayTimer();
      return;
    }

    await this.setSelectedTaskPath(path);
    await this.startTracking();
  }

  private recomputeMacOsTrayRecentConcerns(): void {
    if (this.timeEntriesById.size === 0) {
      this.macOsTrayRecentConcerns = [];
      return;
    }

    const latestEndMsByNoteId = new Map<string, number>();
    for (const [noteId, entries] of this.timeEntriesById.entries()) {
      const latestEndMs = this.getLatestTrackedEndMsForEntries(entries);
      if (latestEndMs > 0) {
        latestEndMsByNoteId.set(noteId, latestEndMs);
      }
    }

    if (latestEndMsByNoteId.size === 0) {
      this.macOsTrayRecentConcerns = [];
      return;
    }

    const taskInfoByNoteId = this.buildNoteIdToTaskInfoMap();
    this.macOsTrayRecentConcerns = Array.from(latestEndMsByNoteId.entries())
      .map(([noteId, latestEndMs]) => {
        const info = taskInfoByNoteId.get(noteId);
        if (!info) return null;
        return { latestEndMs, path: info.path, label: info.label };
      })
      .filter(
        (item): item is { latestEndMs: number; path: string; label: string } => item !== null
      )
      .sort((a, b) => {
        if (a.latestEndMs !== b.latestEndMs) {
          return b.latestEndMs - a.latestEndMs;
        }
        return a.label.localeCompare(b.label);
      })
      .slice(0, MAX_MACOS_TRAY_RECENT_CONCERNS)
      .map(({ path, label }) => ({ path, label }));
  }

  private buildNoteIdToTaskInfoMap(): Map<string, NoteTaskInfo> {
    const map = new Map<string, NoteTaskInfo>();
    const files = this.app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
    for (const file of files) {
      const id = this.getTaskIdForFile(file);
      if (!id) continue;
      map.set(id, {
        path: file.path,
        label: file.basename
      });
    }
    return map;
  }

  private getNormalizedTimeLogPath(): string {
    const raw = (this.settings.timeLogPath || DEFAULT_TIME_LOG_PATH).trim().replace(/^\/+/, "");
    return normalizePath(raw || DEFAULT_TIME_LOG_PATH);
  }

  private isTimeLogPath(path: string): boolean {
    return normalizePath(path) === this.getNormalizedTimeLogPath();
  }

  private rewireTimeLogWatcher(): void {
    const normalized = this.getNormalizedTimeLogPath();
    if (this.timeLogFsWatcher && this.watchedTimeLogPath === normalized) {
      return;
    }
    this.closeTimeLogFsWatcher();
    this.watchTimeLogFile();
  }

  private watchTimeLogFile(): void {
    const adapter = this.app.vault.adapter;
    if (!("getBasePath" in adapter) || typeof adapter.getBasePath !== "function") return;

    const timeLogPath = this.getNormalizedTimeLogPath();
    const basePath = adapter.getBasePath() as string;
    const fs = this.requireNode<typeof import("fs")>("fs");
    const path = this.requireNode<typeof import("path")>("path");
    if (!fs || !path) return;

    const absolutePath = path.join(basePath, timeLogPath);
    try {
      this.timeLogFsWatcher = fs.watch(
        absolutePath,
        { persistent: false },
        () => this.debounceTimeLogReload()
      );
      this.watchedTimeLogPath = timeLogPath;
      this.watchedTimeLogAbsolutePath = absolutePath;
      void this.refreshWatchedTimeLogHash();
    } catch {
      console.error("[life-dashboard] Could not watch time log file for external changes.");
      this.watchedTimeLogPath = "";
      this.watchedTimeLogAbsolutePath = "";
      this.watchedTimeLogHash = null;
    }
  }

  private debounceTimeLogReload(): void {
    if (this.timeLogReloadDebounce !== null) {
      window.clearTimeout(this.timeLogReloadDebounce);
    }
    this.timeLogReloadDebounce = window.setTimeout(() => {
      this.timeLogReloadDebounce = null;
      void this.reloadTotalsAndRefreshIfHashChanged();
    }, 500);
  }

  private closeTimeLogFsWatcher(): void {
    if (this.timeLogReloadDebounce !== null) {
      window.clearTimeout(this.timeLogReloadDebounce);
      this.timeLogReloadDebounce = null;
    }
    if (this.timeLogFsWatcher) {
      this.timeLogFsWatcher.close();
      this.timeLogFsWatcher = null;
    }
    this.watchedTimeLogPath = "";
    this.watchedTimeLogAbsolutePath = "";
    this.watchedTimeLogHash = null;
  }

  private async reloadTotalsAndRefreshIfHashChanged(): Promise<void> {
    const previousHash = this.watchedTimeLogHash;
    const nextHash = await this.computeWatchedTimeLogHash();
    if (nextHash !== null && previousHash !== null && nextHash === previousHash) {
      return;
    }

    await this.reloadTotalsAndRefresh();
    if (nextHash !== null) {
      this.watchedTimeLogHash = nextHash;
    } else {
      await this.refreshWatchedTimeLogHash();
    }
    new Notice("Time tracking data reloaded.");
  }

  private async refreshWatchedTimeLogHash(): Promise<void> {
    this.watchedTimeLogHash = await this.computeWatchedTimeLogHash();
  }

  private async computeWatchedTimeLogHash(): Promise<string | null> {
    if (!this.watchedTimeLogAbsolutePath) {
      return null;
    }
    const fs = this.requireNode<typeof import("fs")>("fs");
    const crypto = this.requireNode<typeof import("crypto")>("crypto");
    if (!fs || !crypto || !fs.promises) {
      return null;
    }

    try {
      const data = await fs.promises.readFile(this.watchedTimeLogAbsolutePath, "utf8");
      return crypto.createHash("sha256").update(data).digest("hex");
    } catch (error) {
      console.error("[life-dashboard] Could not compute time log hash:", error);
      return null;
    }
  }

  private requireNode<T>(id: string): T | null {
    try {
      const req = (window as unknown as { require?: (id: string) => unknown }).require;
      return (req?.(id) as T) ?? null;
    } catch {
      return null;
    }
  }

  private handleTaskStructureChange(): void {
    this.taskFilterService.invalidateCache();
    this.recomputeMacOsTrayRecentConcerns();
    this.refreshTaskStructureViews();
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.isTimeLogPath(oldPath) || this.isTimeLogPath(file.path)) {
      this.rewireTimeLogWatcher();
      await this.reloadTotalsAndRefresh();
      return;
    }

    let settingsChanged = false;
    const remappedSelected = this.remapPathPrefix(this.settings.selectedTaskPath, oldPath, file.path);
    if (remappedSelected !== this.settings.selectedTaskPath) {
      this.settings.selectedTaskPath = remappedSelected;
      settingsChanged = true;
    }
    const remappedActive = this.remapPathPrefix(this.settings.activeTrackingTaskPath, oldPath, file.path);
    if (remappedActive !== this.settings.activeTrackingTaskPath) {
      this.settings.activeTrackingTaskPath = remappedActive;
      settingsChanged = true;
    }

    if (settingsChanged) {
      await this.saveSettings();
    }
    this.handleTaskStructureChange();
  }

  private async handleVaultDelete(file: TAbstractFile): Promise<void> {
    if (this.isTimeLogPath(file.path)) {
      this.rewireTimeLogWatcher();
      await this.reloadTotalsAndRefresh();
      return;
    }

    let settingsChanged = false;
    if (this.pathMatchesOrDescends(this.settings.selectedTaskPath, file.path)) {
      this.settings.selectedTaskPath = "";
      settingsChanged = true;
    }
    if (this.pathMatchesOrDescends(this.settings.activeTrackingTaskPath, file.path)) {
      this.settings.activeTrackingTaskPath = "";
      settingsChanged = true;
    }

    if (settingsChanged) {
      await this.saveSettings();
    }
    this.handleTaskStructureChange();
  }

  private async handleVaultCreate(file: TAbstractFile): Promise<void> {
    if (this.isTimeLogPath(file.path)) {
      this.rewireTimeLogWatcher();
      await this.reloadTotalsAndRefresh();
      return;
    }

    this.handleTaskStructureChange();
  }

  private remapPathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
    if (!path) return path;
    if (path === oldPrefix) {
      return newPrefix;
    }
    const oldPrefixWithSlash = `${oldPrefix}/`;
    if (!path.startsWith(oldPrefixWithSlash)) {
      return path;
    }
    return `${newPrefix}/${path.slice(oldPrefixWithSlash.length)}`;
  }

  private pathMatchesOrDescends(path: string, maybePrefix: string): boolean {
    return path === maybePrefix || path.startsWith(`${maybePrefix}/`);
  }

  private async reloadTotalsAndRefresh(): Promise<void> {
    await this.reloadTimeTotalsSafely();
    this.refreshTimeTrackingViews();
  }

  private scheduleOutlineFilterSave(): void {
    if (this.outlineFilterSaveTimer !== null) {
      window.clearTimeout(this.outlineFilterSaveTimer);
    }

    this.outlineFilterSaveTimer = window.setTimeout(() => {
      this.outlineFilterSaveTimer = null;
      void this.saveSettings();
    }, 300);
  }

  private scheduleCanvasDraftSave(): void {
    if (this.canvasDraftSaveTimer !== null) {
      window.clearTimeout(this.canvasDraftSaveTimer);
    }

    this.canvasDraftSaveTimer = window.setTimeout(() => {
      this.canvasDraftSaveTimer = null;
      void this.saveSettings();
    }, 300);
  }

  private scheduleStartupTotalsLoad(): void {
    if (this.startupTotalsLoadStarted) return;
    this.startupTotalsLoadStarted = true;

    window.setTimeout(() => {
      void this.reloadTotalsAndRefresh();
    }, 0);
  }

  private async reloadTimeTotalsSafely(): Promise<void> {
    try {
      await this.reloadTimeTotals();
    } catch (error) {
      this.timeTotalsById = new Map();
      this.timeEntriesById = new Map();
      this.recomputeMacOsTrayRecentConcerns();
      console.error("[life-dashboard] Failed to read time totals:", error);
    }
  }

  getEntriesForPath(path: string): TimeLogEntry[] {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [];

    const noteId = this.getTaskIdForFile(file);
    if (!noteId) return [];
    return this.timeEntriesById.get(noteId) ?? [];
  }

  private getLatestTrackedEndMs(): number {
    let latestEndMs = 0;
    for (const entries of this.timeEntriesById.values()) {
      const entryLatestEndMs = this.getLatestTrackedEndMsForEntries(entries);
      if (entryLatestEndMs > latestEndMs) {
        latestEndMs = entryLatestEndMs;
      }
    }
    return latestEndMs;
  }

  private getLatestTrackedEndMsForEntries(entries: TimeLogEntry[]): number {
    let latestEndMs = 0;
    for (const entry of entries) {
      const endMs = entry.startMs + entry.durationMinutes * 60_000;
      if (endMs > latestEndMs) {
        latestEndMs = endMs;
      }
    }
    return latestEndMs;
  }

  getWindowForRange(range: Exclude<OutlineTimeRange, "all">, now: Date): TimeWindow {
    return this.timeWindowService.getWindowForRange(range, now);
  }

  getWeekStart(now: Date): Date {
    return this.timeWindowService.getWeekStart(now);
  }

  getDayStart(value: Date): Date {
    return this.timeWindowService.getDayStart(value);
  }

  private sumSecondsInWindow(entries: TimeLogEntry[], window: TimeWindow): number {
    return entries.reduce((seconds, entry) => {
      return seconds + this.timeWindowService.getEntryOverlapSeconds(entry, window);
    }, 0);
  }

  private handleTimerNotifications(): void {
    this.timerNotificationService.handleTick(
      {
        activeStartMs: this.getActiveTrackingStartMs(),
        activeTaskId: this.settings.activeTrackingTaskId || "",
        elapsedSeconds: this.getCurrentElapsedSeconds(),
        rawRules: this.settings.timerNotificationRules || ""
      },
      {
        notify: (message) => this.showTimerNotification(message),
        beep: () => this.playNotificationBeep()
      }
    );
  }

  private getActiveTrackingStartMs(): number | null {
    const start = Number(this.settings.activeTrackingStart);
    if (!Number.isFinite(start) || start <= 0) return null;
    return start;
  }

  private async showTimerNotification(message: string): Promise<void> {
    const title = "Life Dashboard Timer";

    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (window.Notification.permission === "granted") {
      new window.Notification(title, { body: message });
      return;
    }

    if (window.Notification.permission === "denied") {
      return;
    }

    if (this.notificationPermissionRequested) return;
    this.notificationPermissionRequested = true;
    try {
      const permission = await window.Notification.requestPermission();
      if (permission === "granted") {
        new window.Notification(title, { body: message });
      }
    } catch (error) {
      console.error("[life-dashboard] Failed to request notification permission:", error);
    }
  }

  private playNotificationBeep(): void {
    try {
      const electron = (
        window as unknown as { require?: (id: string) => { shell?: { beep?: () => void } } }
      ).require?.("electron");
      if (electron?.shell?.beep) {
        electron.shell.beep();
      }
    } catch {
      // expected on mobile/web
    }
  }

  private getTaskIdFromFrontmatter(frontmatter: FrontMatterCache | undefined): string {
    if (!frontmatter || frontmatter.id == null) return "";
    const id = String(frontmatter.id).trim();
    return id || "";
  }

  private getTaskIdForFile(file: TFile): string {
    const cache = this.app.metadataCache.getFileCache(file);
    return this.getTaskIdFromFrontmatter(cache?.frontmatter);
  }

  private generateUuid(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      const v = ch === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private async ensureTaskIdForFile(file: TFile): Promise<string> {
    const existing = this.getTaskIdForFile(file);
    if (existing) return existing;

    const generated = this.generateUuid();

    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const current = this.getTaskIdFromFrontmatter(fm);
        if (current) return;
        fm.id = generated;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not update frontmatter id: ${message}`);
      return "";
    }

    const resolved = this.getTaskIdForFile(file);
    return resolved || generated;
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.timeLogPath = this.getNormalizedTimeLogPath();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
