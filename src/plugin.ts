import { Notice, Plugin, TAbstractFile, TFile, normalizePath, type FrontMatterCache } from "obsidian";
import type { TaskItem, TimeLogByNoteId, TimeLogEntry } from "./models/types";
import {
  DEFAULT_TIME_LOG_PATH,
  DEFAULT_SETTINGS,
  type LifeDashboardSettings
} from "./settings";
import { DashboardViewController } from "./services/dashboard-view-controller";
import { TaskFilterService } from "./services/task-filter-service";
import { TimeLogStore } from "./services/time-log-store";
import { TimeWindowService, type OutlineTimeRange as OutlineTimeRangeType, type PeriodTooltipRange as PeriodTooltipRangeType, type TimeWindow as TimeWindowType } from "./services/time-window-service";
import { TimerNotificationService } from "./services/timer-notification-service";
import { TrackingService } from "./services/tracking-service";
import { normalizePriorityValue } from "./services/priority-utils";
import { LifeDashboardSettingTab } from "./ui/life-dashboard-setting-tab";
import {
  LifeDashboardCalendarView,
  LifeDashboardConcernCanvasView,
  LifeDashboardOutlineView,
  LifeDashboardTimeLogView,
  LifeDashboardTimerView
} from "./ui/views";
import {
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  VIEW_TYPE_LIFE_DASHBOARD_TIMELOG,
  VIEW_TYPE_LIFE_DASHBOARD_TIMER
} from "./models/view-types";
import { DISPLAY_VERSION } from "./version";

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
  remote?: ElectronMainLike;
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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.initializeServices();
    this.registerMainProcessPowerMonitorAutoStop();
    console.info(
      `[life-dashboard] loaded v${DISPLAY_VERSION} at ${new Date().toISOString()}`
    );

    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMER, (leaf) => new LifeDashboardTimerView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_OUTLINE, (leaf) => new LifeDashboardOutlineView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CANVAS, (leaf) => new LifeDashboardConcernCanvasView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CALENDAR, (leaf) => new LifeDashboardCalendarView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMELOG, (leaf) => new LifeDashboardTimeLogView(leaf, this));

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

    this.registerInterval(
      window.setInterval(() => {
        this.pushLiveTimerUpdate();
      }, 1000)
    );
  }

  async onunload(): Promise<void> {
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

  private async maybeAutoSelectFromActive(): Promise<void> {
    if (this.settings.activeTrackingStart) return;

    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) return;
    if (!this.taskFilterService.fileMatchesTaskFilter(file)) return;
    if (this.settings.selectedTaskPath === file.path) return;

    this.settings.selectedTaskPath = file.path;
    await this.saveSettings();
    this.refreshTaskStructureViews();
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
    this.settings.selectedTaskPath = path;
    await this.saveSettings();
    this.refreshTaskStructureViews();
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
  }

  async reloadTimeTotals(): Promise<void> {
    const snapshot = await this.timeLogStore.loadSnapshot();
    this.timeTotalsById = snapshot.totals;
    this.timeEntriesById = snapshot.entriesByNoteId;
  }

  async readTimeLog(): Promise<TimeLogByNoteId> {
    return this.timeLogStore.readTimeLogMap();
  }

  async saveTimeLog(data: TimeLogByNoteId): Promise<void> {
    await this.timeLogStore.writeTimeLogMap(data);
    await this.reloadTimeTotals();
    this.refreshTimeTrackingViews();
  }

  async setConcernPriority(path: string, priority: string): Promise<boolean> {
    const normalizedPriority = normalizePriorityValue(priority);
    if (!normalizedPriority) return false;

    return this.updateConcernFrontmatter(
      path,
      (fm) => {
        const current =
          fm.priority == null
            ? ""
            : String(fm.priority).trim().toLowerCase();
        if (current === normalizedPriority) return false;
        fm.priority = normalizedPriority;
        return true;
      },
      "Could not update frontmatter priority"
    );
  }

  async clearConcernPriority(path: string): Promise<boolean> {
    return this.updateConcernFrontmatter(
      path,
      (fm) => {
        if (!Object.prototype.hasOwnProperty.call(fm, "priority")) return false;
        delete fm.priority;
        return true;
      },
      "Could not remove frontmatter priority"
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
    for (const task of this.getTaskTreeItems()) {
      const cache = this.app.metadataCache.getFileCache(task.file);
      const id = cache?.frontmatter?.id;
      if (id) map.set(String(id).trim(), task.file.basename);
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

  refreshView(): void {
    this.viewController.refreshView();
  }

  private refreshTaskStructureViews(): void {
    this.viewController.refreshTaskStructureViews();
  }

  private refreshTimeTrackingViews(): void {
    this.viewController.refreshTimeTrackingViews();
  }

  private pushLiveTimerUpdate(): void {
    this.viewController.pushLiveTimerUpdate();
    this.handleTimerNotifications();
  }

  private async persistVisibilityState(force = false): Promise<void> {
    await this.viewController.persistVisibilityState(force);
  }

  private initializeServices(): void {
    this.taskFilterService = new TaskFilterService(this.app, this.settings);
    this.timeLogStore = new TimeLogStore(this.app, this.settings, () => this.saveSettings());
    this.timeWindowService = new TimeWindowService(() => this.settings.weekStartsOn);
    this.timerNotificationService = new TimerNotificationService();
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
      console.warn("[life-dashboard] Main-process powerMonitor is unavailable.");
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
    console.info(
      "[life-dashboard] Registered main-process powerMonitor auto-stop listeners (suspend, lock-screen)."
    );
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

    console.info(`[life-dashboard] Auto-stopping timer due to power event: ${source}`);
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

    try {
      this.timeLogFsWatcher = fs.watch(
        path.join(basePath, timeLogPath),
        { persistent: false },
        () => this.debounceTimeLogReload()
      );
      this.watchedTimeLogPath = timeLogPath;
    } catch {
      console.warn("[life-dashboard] Could not watch time log file for external changes.");
      this.watchedTimeLogPath = "";
    }
  }

  private debounceTimeLogReload(): void {
    if (this.timeLogReloadDebounce !== null) {
      window.clearTimeout(this.timeLogReloadDebounce);
    }
    this.timeLogReloadDebounce = window.setTimeout(() => {
      this.timeLogReloadDebounce = null;
      void this.reloadTotalsAndRefresh().then(() => {
        new Notice("Time tracking data reloaded.");
      });
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
      for (const entry of entries) {
        const endMs = entry.startMs + entry.durationMinutes * 60 * 1000;
        if (endMs > latestEndMs) {
          latestEndMs = endMs;
        }
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
      console.warn("[life-dashboard] System notifications are unavailable in this environment.");
      return;
    }

    if (window.Notification.permission === "granted") {
      new window.Notification(title, { body: message });
      return;
    }

    if (window.Notification.permission === "denied") {
      console.warn("[life-dashboard] System notifications are denied by the user.");
      return;
    }

    if (this.notificationPermissionRequested) return;
    this.notificationPermissionRequested = true;
    try {
      const permission = await window.Notification.requestPermission();
      if (permission === "granted") {
        new window.Notification(title, { body: message });
      } else {
        console.warn("[life-dashboard] System notification permission was not granted.");
      }
    } catch (error) {
      console.warn("[life-dashboard] Failed to request notification permission:", error);
    }
  }

  private playNotificationBeep(): void {
    try {
      const electron = (
        window as unknown as { require?: (id: string) => { shell?: { beep?: () => void } } }
      ).require?.("electron");
      if (electron?.shell?.beep) {
        electron.shell.beep();
      } else {
        console.warn("[life-dashboard] Native desktop beep is unavailable in this environment.");
      }
    } catch {
      console.warn("[life-dashboard] Failed to play native desktop beep.");
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
