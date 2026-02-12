import { Notice, Plugin, TFile, type FrontMatterCache } from "obsidian";
import type { TaskItem, TimeLogEntry } from "./models/types";
import {
  DEFAULT_SETTINGS,
  type LifeDashboardSettings
} from "./settings";
import { DashboardViewController } from "./services/dashboard-view-controller";
import { TaskFilterService } from "./services/task-filter-service";
import { TimeLogStore } from "./services/time-log-store";
import { TrackingService } from "./services/tracking-service";
import { LifeDashboardSettingTab } from "./ui/life-dashboard-setting-tab";
import { LifeDashboardView, VIEW_TYPE_LIFE_DASHBOARD } from "./ui/life-dashboard-view";
import { DISPLAY_VERSION } from "./version";

export type OutlineTimeRange = "today" | "week" | "month" | "all";
type PeriodTooltipRange = OutlineTimeRange | "yesterday";
type TimeWindow = { startMs: number; endMs: number };
type TimerNotificationRule = {
  thresholdSeconds: number;
  label: string;
  message: string;
};
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

  private taskFilterService!: TaskFilterService;
  private timeLogStore!: TimeLogStore;
  private trackingService!: TrackingService;
  private viewController!: DashboardViewController;
  private startupTotalsLoadStarted = false;
  private outlineFilterSaveTimer: number | null = null;
  private activeNotificationSessionKey = "";
  private lastElapsedSecondsForNotify: number | null = null;
  private notifiedThresholdSeconds = new Set<number>();
  private parsedNotificationRulesCacheRaw = "";
  private parsedNotificationRulesCache: TimerNotificationRule[] = [];
  private notificationPermissionRequested = false;
  private powerAutoStopInFlight: Promise<void> | null = null;
  private removePowerMonitorListeners: Array<() => void> = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    this.initializeServices();
    this.registerMainProcessPowerMonitorAutoStop();
    console.info(
      `[life-dashboard] loaded v${DISPLAY_VERSION} at ${new Date().toISOString()}`
    );

    this.registerView(VIEW_TYPE_LIFE_DASHBOARD, (leaf) => new LifeDashboardView(leaf, this));

    this.addRibbonIcon("list-tree", "Open Life Dashboard", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-life-dashboard",
      name: "Open Life Dashboard",
      callback: () => {
        void this.activateView();
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

    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshView()));
    this.registerEvent(
      this.app.vault.on("rename", () => {
        void this.reloadTotalsAndRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        void this.reloadTotalsAndRefresh();
      })
    );
    this.registerEvent(this.app.vault.on("create", () => this.refreshView()));

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
      if (this.settings.viewWasVisible) {
        void this.activateView();
      } else {
        this.refreshView();
      }
    });

    this.registerInterval(
      window.setInterval(() => {
        this.pushLiveTimerUpdate();
      }, 1000)
    );
  }

  async onunload(): Promise<void> {
    this.clearPowerMonitorListeners();

    if (this.outlineFilterSaveTimer !== null) {
      window.clearTimeout(this.outlineFilterSaveTimer);
      this.outlineFilterSaveTimer = null;
      await this.saveSettings();
    }

    await this.trackingService.flushActiveTrackingOnUnload();
    await this.persistVisibilityState(true);
  }

  getTaskTreeItems(): TaskItem[] {
    return this.taskFilterService.getTaskTreeItems();
  }

  async postFilterSettingsChanged(): Promise<void> {
    await this.maybeAutoSelectFromActive();
    this.refreshView();
  }

  private async maybeAutoSelectFromActive(): Promise<void> {
    if (this.settings.activeTrackingStart) return;

    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) return;
    if (!this.taskFilterService.fileMatchesTaskFilter(file)) return;
    if (this.settings.selectedTaskPath === file.path) return;

    this.settings.selectedTaskPath = file.path;
    await this.saveSettings();
    this.refreshView();
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
    this.refreshView();
    return applySeconds;
  }

  async setSelectedTaskPath(path: string): Promise<void> {
    this.settings.selectedTaskPath = path;
    await this.saveSettings();
    this.refreshView();
  }

  getOutlineFilterQuery(): string {
    return this.settings.outlineFilterQuery || "";
  }

  setOutlineFilterQuery(query: string): void {
    if (this.settings.outlineFilterQuery === query) return;
    this.settings.outlineFilterQuery = query;
    this.scheduleOutlineFilterSave();
  }

  async activateView(): Promise<void> {
    await this.viewController.activateView();
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

  getConcernPeriodSummary(path: string): {
    todayEntries: string[];
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
      .filter((entry) => this.isEntryInWindow(entry, todayWindow))
      .sort((a, b) => a.startMs - b.startMs)
      .map((entry) => {
        const start = new Date(entry.startMs);
        const hhmm = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
        return `${hhmm} ${this.formatShortDuration(entry.durationMinutes * 60)}`;
      });
    const todaySeconds = this.sumSecondsInWindow(entries, todayWindow);
    const yesterdaySeconds = this.sumSecondsInWindow(entries, yesterdayWindow);
    const weekSeconds = this.sumSecondsInWindow(entries, weekWindow);

    return { todayEntries, todaySeconds, yesterdaySeconds, weekSeconds };
  }

  getTimeRangeDescription(range: PeriodTooltipRange): string {
    const window = this.getWindowForPeriod(range, new Date());
    if (!window) return "All tracked entries (no date filter).";
    return this.formatRangeLabel(new Date(window.startMs), new Date(window.endMs));
  }

  formatClockDuration(totalSeconds: number): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    const pad = (n: number): string => String(n).padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${minutes}:${pad(seconds)}`;
  }

  formatShortDuration(totalSeconds: number): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);

    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
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
    this.viewController = new DashboardViewController(this.app, this.settings, () => this.saveSettings());

    this.trackingService = new TrackingService({
      app: this.app,
      settings: this.settings,
      saveSettings: () => this.saveSettings(),
      refreshView: () => this.refreshView(),
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

  private async reloadTotalsAndRefresh(): Promise<void> {
    await this.reloadTimeTotalsSafely();
    this.refreshView();
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

  private getEntriesForPath(path: string): TimeLogEntry[] {
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

  private getWindowForRange(range: Exclude<OutlineTimeRange, "all">, now: Date): TimeWindow {
    if (range === "today") {
      const start = this.getDayStart(now);
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 1);
      return { startMs: start.getTime(), endMs: end.getTime() };
    }

    if (range === "week") {
      const start = this.getWeekStart(now);
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 7);
      return { startMs: start.getTime(), endMs: end.getTime() };
    }

    if (range === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
      return { startMs: start.getTime(), endMs: end.getTime() };
    }
    return { startMs: 0, endMs: 0 };
  }

  private getWindowForPeriod(range: PeriodTooltipRange, now: Date): TimeWindow | null {
    if (range === "all") {
      return null;
    }

    if (range === "yesterday") {
      const todayWindow = this.getWindowForRange("today", now);
      const yesterdayStart = new Date(todayWindow.startMs);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      return {
        startMs: yesterdayStart.getTime(),
        endMs: todayWindow.startMs
      };
    }

    return this.getWindowForRange(range, now);
  }

  private getWeekStart(now: Date): Date {
    const start = this.getDayStart(now);
    const day = start.getDay(); // Sunday=0 ... Saturday=6
    const weekStartsOn = this.settings.weekStartsOn === "sunday" ? 0 : 1;
    const offset = (day - weekStartsOn + 7) % 7;
    start.setDate(start.getDate() - offset);
    return start;
  }

  private getDayStart(value: Date): Date {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
  }

  private formatRangeLabel(start: Date, endExclusive: Date): string {
    const end = new Date(endExclusive.getTime() - 60 * 1000);
    return `${this.formatDateTime(start)} - ${this.formatDateTime(end)}`;
  }

  private sumSecondsInWindow(entries: TimeLogEntry[], window: TimeWindow): number {
    return entries.reduce((seconds, entry) => {
      if (!this.isEntryInWindow(entry, window)) {
        return seconds;
      }
      return seconds + entry.durationMinutes * 60;
    }, 0);
  }

  private isEntryInWindow(entry: TimeLogEntry, window: TimeWindow): boolean {
    return entry.startMs >= window.startMs && entry.startMs < window.endMs;
  }

  private formatDateTime(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  private handleTimerNotifications(): void {
    const start = this.getActiveTrackingStartMs();
    if (start == null) {
      this.resetNotificationState();
      return;
    }

    const sessionKey = `${start}:${this.settings.activeTrackingTaskId || ""}`;
    const elapsed = this.getCurrentElapsedSeconds();

    if (sessionKey !== this.activeNotificationSessionKey) {
      this.activeNotificationSessionKey = sessionKey;
      this.lastElapsedSecondsForNotify = elapsed;
      this.notifiedThresholdSeconds.clear();
      return;
    }

    const previous = this.lastElapsedSecondsForNotify ?? elapsed;
    if (elapsed < previous) {
      this.lastElapsedSecondsForNotify = elapsed;
      this.notifiedThresholdSeconds.clear();
      return;
    }

    const rules = this.getTimerNotificationRules();
    for (const rule of rules) {
      if (this.notifiedThresholdSeconds.has(rule.thresholdSeconds)) continue;
      if (previous < rule.thresholdSeconds && elapsed >= rule.thresholdSeconds) {
        this.notifiedThresholdSeconds.add(rule.thresholdSeconds);
        void this.showTimerNotification(rule.message || `Timer hit ${rule.label}`);
        this.playNotificationBeep();
      }
    }

    this.lastElapsedSecondsForNotify = elapsed;
  }

  private getActiveTrackingStartMs(): number | null {
    const start = Number(this.settings.activeTrackingStart);
    if (!Number.isFinite(start) || start <= 0) return null;
    return start;
  }

  private resetNotificationState(): void {
    this.activeNotificationSessionKey = "";
    this.lastElapsedSecondsForNotify = null;
    this.notifiedThresholdSeconds.clear();
  }

  private getTimerNotificationRules(): TimerNotificationRule[] {
    const raw = this.settings.timerNotificationRules || "";
    if (raw === this.parsedNotificationRulesCacheRaw) {
      return this.parsedNotificationRulesCache;
    }

    const parsed = this.parseTimerNotificationRules(raw);
    this.parsedNotificationRulesCacheRaw = raw;
    this.parsedNotificationRulesCache = parsed;
    return parsed;
  }

  private parseTimerNotificationRules(raw: string): TimerNotificationRule[] {
    const byThreshold = new Map<number, TimerNotificationRule>();
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = /^(\d+\s*[smhSMH])(?:\s+(?:"([^"]+)"|(.*)))?$/.exec(trimmed);
      if (!match) {
        console.warn("[life-dashboard] Invalid timer notification rule:", trimmed);
        continue;
      }

      const thresholdSeconds = this.parseDurationToSeconds(match[1]);
      if (thresholdSeconds <= 0) continue;

      const rawMessage = (match[2] ?? match[3] ?? "").trim();
      const label = match[1].replace(/\s+/g, "").toLowerCase();
      byThreshold.set(thresholdSeconds, {
        thresholdSeconds,
        label,
        message: rawMessage || `Timer reached ${label}`
      });
    }

    return Array.from(byThreshold.values()).sort((a, b) => a.thresholdSeconds - b.thresholdSeconds);
  }

  private parseDurationToSeconds(raw: string): number {
    const match = /^(\d+)\s*([smhSMH])$/.exec(raw.trim());
    if (!match) return 0;

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 0;

    const unit = match[2].toLowerCase();
    if (unit === "h") return value * 3600;
    if (unit === "m") return value * 60;
    return value;
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
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
