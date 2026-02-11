import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type App,
  type FrontMatterCache,
  type WorkspaceLeaf
} from "obsidian";
import { DEFAULT_SETTINGS, type LifeDashboardSettings } from "./settings";
import { LifeDashboardView, VIEW_TYPE_LIFE_DASHBOARD } from "./ui/life-dashboard-view";
import type { TaskItem, TimeLogByNoteId } from "./models/types";

class LifeDashboardSettingTab extends PluginSettingTab {
  private readonly plugin: LifeDashboardPlugin;

  constructor(app: App, plugin: LifeDashboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Life Dashboard Settings" });

    new Setting(containerEl)
      .setName("Task property name")
      .setDesc("Frontmatter key used to identify task notes.")
      .addText((text) =>
        text
          .setPlaceholder("type")
          .setValue(this.plugin.settings.propertyName)
          .onChange(async (value) => {
            this.plugin.settings.propertyName = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Task property value")
      .setDesc("Required value for task notes. Leave empty to include any note with the property.")
      .addText((text) =>
        text
          .setPlaceholder("concen")
          .setValue(this.plugin.settings.propertyValue)
          .onChange(async (value) => {
            this.plugin.settings.propertyValue = value;
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Additional filter property")
      .setDesc("Optional second frontmatter key to filter task notes.")
      .addText((text) =>
        text
          .setPlaceholder("status")
          .setValue(this.plugin.settings.additionalFilterPropertyName)
          .onChange(async (value) => {
            this.plugin.settings.additionalFilterPropertyName = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Additional filter value")
      .setDesc("Optional second filter value. Leave empty to require only additional property presence.")
      .addText((text) =>
        text
          .setPlaceholder("active")
          .setValue(this.plugin.settings.additionalFilterPropertyValue)
          .onChange(async (value) => {
            this.plugin.settings.additionalFilterPropertyValue = value;
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Case sensitive")
      .setDesc("If enabled, value matching is case sensitive for all filters.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.caseSensitive)
          .onChange(async (value) => {
            this.plugin.settings.caseSensitive = value;
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Time log file path")
      .setDesc("JSON file path in vault where time entries are stored.")
      .addText((text) =>
        text
          .setPlaceholder("Data/time/time-tracked.json")
          .setValue(this.plugin.settings.timeLogPath)
          .onChange(async (value) => {
            this.plugin.settings.timeLogPath = value.trim() || "Data/time/time-tracked.json";
            await this.plugin.saveSettings();
            await this.plugin.reloadTimeTotals();
            this.plugin.refreshView();
          })
      );
  }
}

export default class LifeDashboardPlugin extends Plugin {
  settings!: LifeDashboardSettings;
  timeTotalsById: Map<string, number> = new Map();
  private lastPersistedVisibility = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.lastPersistedVisibility = Boolean(this.settings.viewWasVisible);
    await this.reloadTimeTotals();

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
    this.registerEvent(this.app.vault.on("rename", () => {
      void this.reloadTimeTotals();
      this.refreshView();
    }));
    this.registerEvent(this.app.vault.on("delete", () => {
      void this.reloadTimeTotals();
      this.refreshView();
    }));
    this.registerEvent(this.app.vault.on("create", () => this.refreshView()));

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      void this.persistVisibilityState();
    }));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      void this.maybeAutoSelectFromActive();
    }));

    this.app.workspace.onLayoutReady(() => {
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
    await this.persistVisibilityState(true);
  }

  getTaskTreeItems(): TaskItem[] {
    const files = this.app.vault.getMarkdownFiles();
    const tasks: TaskItem[] = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!this.frontmatterMatchesTaskFilters(fm)) continue;

      tasks.push({
        file,
        parentRaw: fm?.parent
      });
    }

    tasks.sort((a, b) => a.file.path.localeCompare(b.file.path));
    return tasks;
  }

  private frontmatterMatchesTaskFilters(frontmatter: FrontMatterCache | undefined): boolean {
    const prop = this.settings.propertyName.trim();
    if (!prop) return false;
    if (!frontmatter || !(prop in frontmatter)) return false;

    const primaryActual = String(frontmatter[prop] ?? "");
    if (!this.matchesValue(primaryActual, this.settings.propertyValue.trim())) {
      return false;
    }

    const extraProp = this.settings.additionalFilterPropertyName.trim();
    if (!extraProp) return true;
    if (!(extraProp in frontmatter)) return false;

    const extraActual = String(frontmatter[extraProp] ?? "");
    return this.matchesValue(extraActual, this.settings.additionalFilterPropertyValue.trim());
  }

  private fileMatchesTaskFilter(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    return this.frontmatterMatchesTaskFilters(cache?.frontmatter);
  }

  async postFilterSettingsChanged(): Promise<void> {
    await this.maybeAutoSelectFromActive();
    this.refreshView();
  }

  private async maybeAutoSelectFromActive(): Promise<void> {
    if (this.settings.activeTrackingStart) return;

    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) return;
    if (!this.fileMatchesTaskFilter(file)) return;
    if (this.settings.selectedTaskPath === file.path) return;

    this.settings.selectedTaskPath = file.path;
    await this.saveSettings();
    this.refreshView();
  }

  getActiveTaskPath(): string {
    if (this.settings.activeTrackingStart && this.settings.activeTrackingTaskPath) {
      return this.settings.activeTrackingTaskPath;
    }
    return this.settings.selectedTaskPath || "";
  }

  async setSelectedTaskPath(path: string): Promise<void> {
    this.settings.selectedTaskPath = path;
    await this.saveSettings();
    this.refreshView();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
    }

    if (!leaf) {
      return;
    }

    if (leaf.getViewState().type !== VIEW_TYPE_LIFE_DASHBOARD) {
      await leaf.setViewState({ type: VIEW_TYPE_LIFE_DASHBOARD, active: true });
    }

    workspace.revealLeaf(leaf);
    await this.persistVisibilityState(true);
    this.refreshView();
  }

  private matchesValue(actual: string, expected: string): boolean {
    if (!expected || expected.trim().length === 0) return true;

    if (this.settings.caseSensitive) {
      return actual === expected;
    }

    return actual.toLowerCase() === expected.toLowerCase();
  }

  getCurrentElapsedSeconds(): number {
    if (!this.settings.activeTrackingStart) return 0;
    const now = Date.now();
    const start = Number(this.settings.activeTrackingStart);
    if (!Number.isFinite(start) || start <= 0) return 0;
    return Math.max(0, Math.floor((now - start) / 1000));
  }

  async startTracking(): Promise<void> {
    if (this.settings.activeTrackingStart) return;

    let taskPath = this.settings.selectedTaskPath;
    if (!taskPath) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof TFile && this.fileMatchesTaskFilter(activeFile)) {
        taskPath = activeFile.path;
      }
    }

    if (!taskPath) {
      new Notice("Select a task first (Change task...) or open a task note.");
      return;
    }

    const taskFile = this.app.vault.getAbstractFileByPath(taskPath);
    if (!(taskFile instanceof TFile)) {
      new Notice("Selected task note was not found.");
      return;
    }

    const taskId = await this.ensureTaskIdForFile(taskFile);
    if (!taskId) {
      new Notice("Could not prepare task id for tracking.");
      return;
    }

    this.settings.selectedTaskPath = taskPath;
    this.settings.activeTrackingTaskPath = taskPath;
    this.settings.activeTrackingTaskId = taskId;
    this.settings.activeTrackingStart = Date.now();
    await this.saveSettings();
    this.refreshView();
  }

  async stopTracking(): Promise<void> {
    if (!this.settings.activeTrackingStart) return;

    const startMs = Number(this.settings.activeTrackingStart);
    const endMs = Date.now();
    const taskId = this.settings.activeTrackingTaskId;

    if (taskId && Number.isFinite(startMs) && startMs > 0 && endMs >= startMs) {
      try {
        await this.appendTimeEntry(taskId, startMs, endMs);
        await this.reloadTimeTotals();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Failed to save time entry: ${message}`);
      }
    }

    this.settings.activeTrackingStart = null;
    this.settings.activeTrackingTaskPath = "";
    this.settings.activeTrackingTaskId = "";
    await this.saveSettings();
    this.refreshView();
  }

  private getTimeLogPath(): string {
    const raw = (this.settings.timeLogPath || "Data/time/time-tracked.json").trim();
    return raw.replace(/^\/+/, "") || "Data/time/time-tracked.json";
  }

  private async ensureDirectoryPath(relativePath: string): Promise<void> {
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length <= 1) return;

    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  private parseStartTimestamp(value: string): Date | null {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2}):(\d{2})$/.exec(value);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hours = Number(m[4]);
    const minutes = Number(m[5]);
    const date = new Date(year, month, day, hours, minutes, 0, 0);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  private parseIntervalToken(token: string): { start: string; durationMinutes: number; startMs: number; endMs: number } | null {
    const m = /^(\d{4}\.\d{2}\.\d{2}-\d{2}:\d{2})T(?:(?:P)?T)?(\d+)M$/.exec(token.trim());
    if (!m) return null;

    const start = m[1];
    const durationMinutes = Number(m[2]);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;

    const startDate = this.parseStartTimestamp(start);
    if (!startDate) return null;

    const startMs = startDate.getTime();
    const endMs = startMs + durationMinutes * 60 * 1000;
    return { start, durationMinutes, startMs, endMs };
  }

  private formatIntervalToken(start: string, durationMinutes: number): string {
    return `${start}T${durationMinutes}M`;
  }

  private normalizeAndValidateNoteIntervals(noteId: string, intervals: string[]): string[] {
    const parsed = Array.from(new Set(intervals))
      .map((token) => this.parseIntervalToken(token))
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) => a.startMs - b.startMs);

    const normalized: string[] = [];
    let prevEnd = -Infinity;
    for (const item of parsed) {
      if (item.startMs < prevEnd) {
        throw new Error(`Overlapping intervals for note ${noteId}`);
      }
      prevEnd = item.endMs;
      normalized.push(this.formatIntervalToken(item.start, item.durationMinutes));
    }

    return normalized;
  }

  private normalizeAndValidateTimeLogMap(raw: unknown): TimeLogByNoteId {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }

    const obj = raw as Record<string, unknown>;
    const output: TimeLogByNoteId = {};

    for (const [noteId, value] of Object.entries(obj)) {
      if (!noteId.trim()) continue;
      if (!Array.isArray(value)) continue;

      const intervals = value.filter((v): v is string => typeof v === "string");
      output[noteId] = this.normalizeAndValidateNoteIntervals(noteId, intervals);
    }

    return output;
  }

  private async readTimeLogRaw(): Promise<unknown> {
    const filePath = this.getTimeLogPath();

    await this.ensureDirectoryPath(filePath);

    const exists = await this.app.vault.adapter.exists(filePath);
    if (!exists) {
      const initial: TimeLogByNoteId = {};
      await this.app.vault.adapter.write(filePath, JSON.stringify(initial, null, 2));
      return initial;
    }

    try {
      const raw = await this.app.vault.adapter.read(filePath);
      return JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }

  private async writeTimeLog(data: TimeLogByNoteId): Promise<void> {
    const filePath = this.getTimeLogPath();
    await this.ensureDirectoryPath(filePath);
    await this.app.vault.adapter.write(filePath, JSON.stringify(data, null, 2));
  }

  formatTimestamp(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${yyyy}.${mm}.${dd}-${hh}:${min}`;
  }

  private async appendTimeEntry(noteId: string, startMs: number, endMs: number): Promise<void> {
    const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
    const start = this.formatTimestamp(new Date(startMs));
    const token = this.formatIntervalToken(start, durationMinutes);

    const data = await this.readTimeLogMap();
    const current = data[noteId] ?? [];
    const next = this.normalizeAndValidateNoteIntervals(noteId, [...current, token]);
    data[noteId] = next;
    await this.writeTimeLog(data);
  }

  private async migrateTimeLogToMapFormat(): Promise<void> {
    const raw = await this.readTimeLogRaw();

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const hasEntriesArray = Array.isArray(obj.entries);
      if (!hasEntriesArray) {
        const normalized = this.normalizeAndValidateTimeLogMap(raw);
        await this.writeTimeLog(normalized);
        return;
      }

      const entries = obj.entries as Array<Record<string, unknown>>;
      const byId: TimeLogByNoteId = {};

      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.noteId !== "string" || !entry.noteId.trim()) continue;
        if (typeof entry.start !== "string" || !entry.start.trim()) continue;

        let minutes = Number(entry.durationMinutes);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          const legacySeconds = Number(entry.durationSeconds);
          if (Number.isFinite(legacySeconds) && legacySeconds > 0) {
            minutes = Math.max(1, Math.round(legacySeconds / 60));
          }
        }
        if (!Number.isFinite(minutes) || minutes <= 0) continue;

        const token = this.formatIntervalToken(entry.start, Math.max(1, Math.round(minutes)));
        const key = entry.noteId.trim();
        if (!byId[key]) byId[key] = [];
        byId[key].push(token);
      }

      const normalized = this.normalizeAndValidateTimeLogMap(byId);
      await this.writeTimeLog(normalized);
      return;
    }

    await this.writeTimeLog({});
  }

  private async readTimeLogMap(): Promise<TimeLogByNoteId> {
    await this.migrateTimeLogToMapFormat();
    const raw = await this.readTimeLogRaw();
    return this.normalizeAndValidateTimeLogMap(raw);
  }

  async reloadTimeTotals(): Promise<void> {
    const data = await this.readTimeLogMap();
    const totals = new Map<string, number>();

    for (const [noteId, intervals] of Object.entries(data)) {
      let seconds = 0;
      for (const token of intervals) {
        const parsed = this.parseIntervalToken(token);
        if (!parsed) continue;
        seconds += parsed.durationMinutes * 60;
      }
      if (seconds > 0) {
        totals.set(noteId, seconds);
      }
    }

    this.timeTotalsById = totals;
  }

  getTrackedSeconds(path: string): number {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return 0;
    const noteId = this.getTaskIdForFile(file);
    if (!noteId) return 0;
    return this.timeTotalsById.get(noteId) ?? 0;
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
    } catch {
      return "";
    }

    const resolved = this.getTaskIdForFile(file);
    return resolved || generated;
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
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardView) {
        void view.render();
      }
    }
  }

  private pushLiveTimerUpdate(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardView) {
        view.updateLiveTimer();
      }
    }
  }

  private isDashboardVisible(): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD).length > 0;
  }

  private async persistVisibilityState(force = false): Promise<void> {
    const visible = this.isDashboardVisible();
    if (!force && visible === this.lastPersistedVisibility) return;

    this.settings.viewWasVisible = visible;
    this.lastPersistedVisibility = visible;
    await this.saveSettings();
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
