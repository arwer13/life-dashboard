import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, normalizePath, setIcon, type FrontMatterCache, type Hotkey, type WorkspaceLeaf } from "obsidian";
import type { ListEntry, TaskItem, InlineTaskItem, TimeLogByNoteId } from "./models/types";
import { isFileItem } from "./models/types";
import { parseInlineTasksForFile, parseInlinePath, stripPriorityEmojis, parsePriorityFromText, PRIORITY_DIGIT_TO_EMOJI, INLINE_CHECKBOX_PATH_SEP, TASKS_HEADING_RE, ANY_HEADING_RE } from "./services/inline-task-parser";
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
import { TimeDataFacade } from "./services/time-data-facade";
import { TimeWindowService, type OutlineTimeRange as OutlineTimeRangeType, type TimeWindow as TimeWindowType } from "./services/time-window-service";
import { TimerNotificationService } from "./services/timer-notification-service";
import { TrackingService } from "./services/tracking-service";
import { normalizePriorityValue } from "./services/priority-utils";
import { matchesFrontmatterFilter } from "./services/outline-filter";
import {
  HealthTrackingService,
  type HealthTrackingRangeSnapshot
} from "./services/health-tracking-service";
import {
  SupplementsTrackingService,
  type SupplementsSnapshot
} from "./services/supplements-tracking-service";
import { LifeDashboardSettingTab } from "./ui/life-dashboard-setting-tab";
import { ListEntrySearchModal } from "./ui/list-entry-search-modal";
import { TextInputModal } from "./ui/text-input-modal";
import { QuickTaskModal } from "./ui/quick-task-modal";
import {
  TaskSelectModal,
  type TaskSelectModalSearchMode,
  type TaskSelectModalSuggestionDecoration
} from "./ui/task-select-modal";
import {
  LifeDashboardBeancountView,
  LifeDashboardCalendarView,
  LifeDashboardConcernCanvasView,
  LifeDashboardOutlineView,
  LifeDashboardTimeLogView,
  LifeDashboardTimelineView,
  LifeDashboardTimerView,
  LifeDashboardSupplementsView,
  LifeDashboardConcernMapView
} from "./ui/views";
import { renderTimelineInto } from "./ui/views/timeline-view";
import {
  LIFE_DASHBOARD_VIEW_TYPES,
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  VIEW_TYPE_LIFE_DASHBOARD_TIMELOG,
  VIEW_TYPE_LIFE_DASHBOARD_TIMELINE,
  VIEW_TYPE_LIFE_DASHBOARD_TIMER,
  VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT,
  VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS,
  VIEW_TYPE_LIFE_DASHBOARD_CONCERN_MAP
} from "./models/view-types";
import { createKanbanViewRegistration, KANBAN_BASES_VIEW_ID } from "./ui/bases/kanban-bases-view";
import { createSubConcernsExtension } from "./ui/editor/sub-concerns-extension";
import { createCheckboxPromoteExtension } from "./ui/editor/checkbox-promote-extension";

export type OutlineTimeRange = OutlineTimeRangeType;
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
type QuickConcernSearchOptions = {
  onChoose?: (file: TFile) => void;
  onCloseWithoutChoice?: () => void;
};
type ConcernQuickOpenFrontmatterState = {
  isDone: boolean;
  isArchived: boolean;
};
type ConcernQuickOpenSearchData = {
  allConcernFiles: TFile[];
  openConcernFiles: TFile[];
  suggestionDecorations: Record<string, TaskSelectModalSuggestionDecoration>;
};
type NoteTaskInfo = {
  path: string;
  label: string;
};

export default class LifeDashboardPlugin extends Plugin {
  settings!: LifeDashboardSettings;
  timeData!: TimeDataFacade;
  highlightedTimeLogStartMs: number | null = null;
  treeStructureVersion = 0;

  private taskFilterService!: TaskFilterService;
  private timeLogStore!: TimeLogStore;
  private timeWindowService!: TimeWindowService;
  private timerNotificationService!: TimerNotificationService;
  private trackingService!: TrackingService;
  private healthTrackingService!: HealthTrackingService;
  private supplementsTrackingService!: SupplementsTrackingService;
  private viewController!: DashboardViewController;
  private startupTotalsLoadStarted = false;
  private outlineFilterSaveTimer: number | null = null;
  private canvasDraftSaveTimer: number | null = null;
  private concernMapSaveTimer: number | null = null;
  private subConcernActionEl: HTMLElement | null = null;
  private subConcernActionFilePath: string | null = null;
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
  private concernQuickSearchModal: TaskSelectModal | null = null;
  private cachedInlineItems: InlineTaskItem[] = [];
  private inlineTaskCacheGeneration = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.initializeServices();
    this.registerMainProcessPowerMonitorAutoStop();

    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMER, (leaf) => new LifeDashboardTimerView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_OUTLINE, (leaf) => new LifeDashboardOutlineView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CANVAS, (leaf) => new LifeDashboardConcernCanvasView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CALENDAR, (leaf) => new LifeDashboardCalendarView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMELOG, (leaf) => new LifeDashboardTimeLogView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMELINE, (leaf) => new LifeDashboardTimelineView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS, (leaf) => new LifeDashboardSupplementsView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CONCERN_MAP, (leaf) => new LifeDashboardConcernMapView(leaf, this));
    this.registerView(VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT, (leaf) => new LifeDashboardBeancountView(leaf));
    this.registerExtensions(["beancount"], VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT);
    this.registerMarkdownCodeBlockProcessor("life-dashboard-timeline", (_source, el) => {
      renderTimelineInto(el, this);
    });
    this.registerBasesView(KANBAN_BASES_VIEW_ID, createKanbanViewRegistration(this));
    this.registerEditorExtension(createSubConcernsExtension(this));
    this.registerEditorExtension(createCheckboxPromoteExtension(this));

    this.addRibbonIcon("list-tree", "Open all views", () => {
      void this.activateView();
    });

    this.addRibbonIcon("network", "Open concerns canvas", () => {
      void this.viewController.activateCanvasView();
    });

    this.addRibbonIcon("timer", "Open timer", () => {
      void this.viewController.activateTimerView();
    });

    this.addRibbonIcon("list", "Open concerns outline", () => {
      void this.viewController.activateOutlineView();
    });

    this.addRibbonIcon("calendar", "Open concerns calendar", () => {
      void this.viewController.activateCalendarView();
    });

    this.addRibbonIcon("history", "Open time log", () => {
      void this.viewController.activateTimeLogView();
    });

    this.addRibbonIcon("gantt-chart", "Open timeline", () => {
      void this.viewController.activateTimelineView();
    });

    this.addRibbonIcon("pill", "Open supplements grid", () => {
      void this.viewController.activateSupplementsView();
    });

    this.addRibbonIcon("map", "Open concern map", () => {
      void this.viewController.activateConcernMapView();
    });

    this.addCommand({
      id: "open-all-views",
      name: "Open all views",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "open-concerns-canvas",
      name: "Open concerns canvas",
      callback: () => {
        void this.viewController.activateCanvasView();
      }
    });

    this.addCommand({
      id: "open-timer",
      name: "Open timer",
      callback: () => {
        void this.viewController.activateTimerView();
      }
    });

    this.addCommand({
      id: "open-concerns-outline",
      name: "Open concerns outline",
      callback: () => {
        void this.viewController.activateOutlineView();
      }
    });

    this.addCommand({
      id: "open-calendar",
      name: "Open concerns calendar",
      callback: () => {
        void this.viewController.activateCalendarView();
      }
    });

    this.addCommand({
      id: "open-time-log",
      name: "Open time log",
      callback: () => {
        void this.viewController.activateTimeLogView();
      }
    });

    this.addCommand({
      id: "open-timeline",
      name: "Open timeline",
      callback: () => {
        void this.viewController.activateTimelineView();
      }
    });

    this.addCommand({
      id: "open-supplements",
      name: "Open supplements grid",
      callback: () => {
        void this.viewController.activateSupplementsView();
      }
    });

    this.addCommand({
      id: "open-concern-map",
      name: "Open concern map",
      callback: () => {
        void this.viewController.activateConcernMapView();
      }
    });

    this.addCommand({
      id: "select-concern",
      name: "Quick open concern",
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
      name: "Create concerns kanban board",
      callback: () => {
        void this.createConcernsKanbanBase();
      }
    });

    this.addCommand({
      id: "create-sub-concern",
      name: "Create sub-concern for active note",
      callback: () => {
        this.createSubConcern();
      }
    });

    this.addSettingTab(new LifeDashboardSettingTab(this.app, this));

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        // Only trigger if this file is (or was) a concern.
        const cache = this.app.metadataCache.getFileCache(file);
        const prop = this.settings.propertyName.trim();
        const hasConcernProperty = prop && cache?.frontmatter && prop in cache.frontmatter;
        if (!hasConcernProperty && !this.taskFilterService.hasCachedFilePath(file.path)) return;
        this.handleConcernContentChange(file.path);
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
          return;
        }
        if (this.isHealthTrackingPath(file.path)) {
          void this.reloadHealthTrackingAndRefresh();
          return;
        }
        if (this.isSupplementsPath(file.path)) {
          void this.reloadSupplementsAndRefresh();
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
        this.updateSubConcernHeaderButton();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.taskFilterService.fileMatchesTaskFilter(file)) return;
        menu.addItem((item) => {
          item
            .setTitle("Create sub-concern")
            .setIcon("plus-circle")
            .onClick(() => {
              this.createSubConcernForFile(file);
            });
        });
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.scheduleStartupTotalsLoad();
      void this.maybeAutoSelectFromActive();
      this.refreshView();
      void this.refreshInlineTaskCache();
      this.updateSubConcernHeaderButton();
    });

    this.macOsTrayTimerService.syncEnabled(this.settings.macOsTrayTimerEnabled, false);
    this.updateMacOsTrayTimer();

    this.registerInterval(
      window.setInterval(() => {
        this.pushLiveTimerUpdate();
      }, 1000)
    );
  }

  onunload(): void {
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
    if (this.concernMapSaveTimer !== null) {
      window.clearTimeout(this.concernMapSaveTimer);
      this.concernMapSaveTimer = null;
    }

    this.subConcernActionEl?.remove();
    this.subConcernActionEl = null;
    this.subConcernActionFilePath = null;

    // Best-effort persistence: Obsidian's onunload is synchronous so these
    // writes are fire-and-forget. Settings and tracking state are also saved
    // eagerly on every change, so this is a final-flush safety net.
    void (async () => {
      await this.saveSettings();
      await this.trackingService.flushActiveTrackingOnUnload();
      await this.persistVisibilityState(true);
    })();
  }

  getTaskTreeItems(): TaskItem[] {
    return [...this.taskFilterService.getTaskTreeItems(), ...this.cachedInlineItems];
  }

  isConcernFile(file: TFile): boolean {
    return this.taskFilterService.fileMatchesTaskFilter(file);
  }

  async postFilterSettingsChanged(): Promise<void> {
    this.taskFilterService.invalidateCache();
    await this.maybeAutoSelectFromActive();
    void this.refreshInlineTaskCache();
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
    for (const concern of this.taskFilterService.getTaskTreeItems().filter(isFileItem)) {
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

    const latestEndMs = this.timeData.getLatestTrackedEndMs();
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

  openConcernQuickSearch(options: QuickConcernSearchOptions = {}): void {
    if (this.concernQuickSearchModal) {
      this.concernQuickSearchModal.cycleSearchMode();
      return;
    }

    const concernItems = this.getTaskTreeItems();
    if (concernItems.length === 0) {
      new Notice("No concerns available to open.");
      return;
    }

    const onChoose =
      options.onChoose ??
      ((file: TFile) => {
        const targetLeaf = this.getConcernQuickOpenTargetLeaf();
        void targetLeaf.openFile(file, { active: true });
      });
    const searchModes = this.buildConcernQuickOpenSearchModes(concernItems);
    const modal = new TaskSelectModal(
      this.app,
      searchModes[0]?.tasks ?? [],
      (file) => {
        this.concernQuickSearchModal = null;
        onChoose(file);
      },
      options.onCloseWithoutChoice,
      {
        placeholder: "Find concern note...",
        showPathInSuggestion: false,
        searchModes,
        cycleHotkeys: this.getConcernQuickSearchCycleHotkeys(),
        onModalClose: () => {
          if (this.concernQuickSearchModal === modal) {
            this.concernQuickSearchModal = null;
          }
        }
      }
    );
    this.concernQuickSearchModal = modal;
    modal.open();
  }

  private buildConcernQuickOpenSearchModes(concernItems: TaskItem[]): TaskSelectModalSearchMode[] {
    const { allConcernFiles, openConcernFiles, suggestionDecorations } =
      this.collectConcernQuickOpenSearchData(concernItems);

    return [
      {
        tasks: openConcernFiles,
        instructions: [
          { command: "Mode", purpose: `open only (${openConcernFiles.length}/${allConcernFiles.length})` },
          { command: "Filter", purpose: "not done, not archived" },
          { command: "Tab", purpose: "next mode" },
          { command: "Again", purpose: "same shortcut also cycles" }
        ],
        emptyStateText: "No open concerns found. Run Quick Open Concern again to include done and archived."
      },
      {
        tasks: allConcernFiles,
        instructions: [
          { command: "Mode", purpose: `all concerns (${allConcernFiles.length})` },
          { command: "Includes", purpose: "done and archived" },
          { command: "Tab", purpose: "next mode" },
          { command: "Again", purpose: "same shortcut also cycles" }
        ],
        emptyStateText: "No concerns available to open.",
        suggestionDecorations
      }
    ];
  }

  private collectConcernQuickOpenSearchData(
    concernItems: TaskItem[]
  ): ConcernQuickOpenSearchData {
    const allConcernFiles: TFile[] = [];
    const openConcernFiles: TFile[] = [];
    const suggestionDecorations: Record<string, TaskSelectModalSuggestionDecoration> = {};

    for (const item of concernItems) {
      if (!isFileItem(item)) continue;
      allConcernFiles.push(item.file);

      const state = this.getConcernQuickOpenFrontmatterState(item.frontmatter);
      if (!state.isDone && !state.isArchived) {
        openConcernFiles.push(item.file);
      }

      const decoration = this.buildConcernQuickOpenSuggestionDecoration(state);
      if (decoration) {
        suggestionDecorations[item.file.path] = decoration;
      }
    }

    return { allConcernFiles, openConcernFiles, suggestionDecorations };
  }

  private buildConcernQuickOpenSuggestionDecoration(
    state: ConcernQuickOpenFrontmatterState
  ): TaskSelectModalSuggestionDecoration | null {
    const { isDone, isArchived } = state;
    if (!isDone && !isArchived) {
      return null;
    }

    return {
      dimmed: true,
      badges: [
        ...(isDone ? [{ label: "done", tone: "done" as const }] : []),
        ...(isArchived ? [{ label: "archived", tone: "archived" as const }] : [])
      ]
    };
  }

  private getConcernQuickOpenFrontmatterState(
    frontmatter: FrontMatterCache | undefined
  ): ConcernQuickOpenFrontmatterState {
    return {
      isDone: this.frontmatterHasValue(frontmatter, "status", "done"),
      isArchived: this.frontmatterFlagEnabled(frontmatter, "archived")
    };
  }

  private frontmatterHasValue(
    frontmatter: FrontMatterCache | undefined,
    key: string,
    expected: string
  ): boolean {
    return matchesFrontmatterFilter(frontmatter, key, expected);
  }

  private frontmatterFlagEnabled(frontmatter: FrontMatterCache | undefined, key: string): boolean {
    if (!frontmatter || !(key in frontmatter)) {
      return false;
    }

    return this.frontmatterValueIsEnabled(frontmatter[key]);
  }

  private frontmatterValueIsEnabled(value: unknown): boolean {
    if (Array.isArray(value)) {
      return value.some((entry) => this.frontmatterValueIsEnabled(entry));
    }

    if (value == null) {
      return false;
    }

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (!normalized) {
        return false;
      }
      return !["false", "0", "no", "off", "null", "undefined"].includes(normalized);
    }

    return true;
  }


  private getConcernQuickSearchCycleHotkeys(): Hotkey[] {
    const hotkey = this.getLastKeyboardEventHotkey();
    const normalizedHotkey = hotkey ? this.normalizeHotkey(hotkey) : null;
    return normalizedHotkey ? [normalizedHotkey] : [];
  }

  private getLastKeyboardEventHotkey(): Hotkey | null {
    const event = this.app.lastEvent;
    if (!event || !("key" in event) || typeof event.key !== "string") {
      return null;
    }

    const key = this.normalizeHotkeyKey(event.key);
    if (!key) {
      return null;
    }

    const modifiers: Hotkey["modifiers"] = [];
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.metaKey) modifiers.push("Meta");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    return { modifiers, key };
  }

  private normalizeHotkeyKey(key: string): string | null {
    const trimmed = key.trim();
    if (!trimmed) {
      return null;
    }

    const lower = trimmed.toLowerCase();
    if (["shift", "control", "ctrl", "meta", "alt", "mod"].includes(lower)) {
      return null;
    }

    return trimmed.length === 1 ? lower : trimmed;
  }

  private normalizeHotkey(hotkey: Hotkey): Hotkey | null {
    const key = hotkey.key?.trim();
    if (!key) {
      return null;
    }

    return {
      modifiers: [...hotkey.modifiers].sort(),
      key: this.normalizeHotkeyKey(key) ?? key
    };
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
    const taskFiles = this.getTaskTreeItems().filter(isFileItem).map((item) => item.file);
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

  getConcernMapState(): string {
    return this.settings.concernMapState || "";
  }

  setConcernMapState(state: string): void {
    if (this.settings.concernMapState === state) return;
    this.settings.concernMapState = state;
    this.scheduleConcernMapSave();
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
    this.timeData.timeTotalsById = snapshot.totals;
    this.timeData.timeEntriesById = snapshot.entriesByNoteId;
    this.recomputeMacOsTrayRecentConcerns();
  }

  async ensureHealthTrackingLoaded(): Promise<void> {
    await this.healthTrackingService.ensureLoaded();
  }

  getHealthTrackingRangeSnapshot(window: TimeWindow, now: Date): HealthTrackingRangeSnapshot {
    return this.healthTrackingService.getRangeSnapshot(window, now);
  }

  async ensureSupplementsLoaded(): Promise<void> {
    await this.supplementsTrackingService.ensureLoaded();
  }

  getSupplementsSnapshot(): SupplementsSnapshot {
    return this.supplementsTrackingService.getSnapshot();
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
            : `${currentRaw as string | number}`.trim().toLowerCase();
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

  async setPriorityForPath(path: string, digit: string): Promise<boolean> {
    if (path.includes(INLINE_CHECKBOX_PATH_SEP)) {
      const emoji = PRIORITY_DIGIT_TO_EMOJI.get(digit);
      if (!emoji) return false;
      return this.modifyInlineTaskLine(path, (text) => `${stripPriorityEmojis(text)} ${emoji}`);
    }
    return this.setConcernPriority(path, digit);
  }

  async clearPriorityForPath(path: string): Promise<boolean> {
    if (path.includes(INLINE_CHECKBOX_PATH_SEP)) {
      return this.modifyInlineTaskLine(path, stripPriorityEmojis);
    }
    return this.clearConcernPriority(path);
  }

  reparentConcernInteractive(concernPath: string): void {
    const parsed = parseInlinePath(concernPath);
    if (parsed) {
      void this.promoteCheckboxToConcern(parsed.filePath, parsed.line);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(concernPath);
    if (!(file instanceof TFile)) return;

    this.openConcernPicker({
      placeholder: "Select new parent...",
      onChoose: (parentFile: TFile) => {
        if (parentFile.path === concernPath) return;
        void this.updateConcernFrontmatter(
          concernPath,
          (fm) => {
            const newParent = `[[${parentFile.basename}]]`;
            const current = fm.parent;
            if (typeof current === "string" && current === newParent) return false;
            fm.parent = newParent;
            return true;
          },
          "Could not update parent"
        );
      }
    });
  }

  private async modifyInlineTaskLine(
    inlinePath: string,
    transform: (text: string) => string
  ): Promise<boolean> {
    const parsed = parseInlinePath(inlinePath);
    if (!parsed) return false;

    const file = this.app.vault.getAbstractFileByPath(parsed.filePath);
    if (!(file instanceof TFile)) return false;
    const lineNum = parsed.line;

    let changed = false;
    await this.app.vault.process(file, (content) => {
      const lines = content.split("\n");
      const line = lines[lineNum];
      if (!line) return content;

      const match = /^(\s*[-*]\s+\[ \]\s+)(.+)$/.exec(line);
      if (!match) return content;

      const newText = transform(match[2]);
      if (newText === match[2]) return content;

      lines[lineNum] = `${match[1]}${newText}`;
      changed = true;
      return lines.join("\n");
    });
    return changed;
  }

  async resetAllConcernPriorities(): Promise<void> {
    const concernItems = this.getTaskTreeItems();
    const paths = concernItems
      .filter(isFileItem)
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


  async openFile(path: string, line?: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(true);
    if (!leaf) return;

    await leaf.openFile(file, { active: true });

    if (line != null) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.editor) {
        const pos = { line, ch: 0 };
        view.editor.setCursor(pos);
        view.editor.scrollIntoView({ from: pos, to: pos }, true);
      }
    }
  }

  private createSubConcern(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (!(activeFile instanceof TFile)) {
      new Notice("No active file.");
      return;
    }

    if (!this.taskFilterService.fileMatchesTaskFilter(activeFile)) {
      new Notice("Active file is not a concern.");
      return;
    }

    this.createSubConcernForFile(activeFile);
  }

  private createSubConcernForFile(parentFile: TFile): void {
    const modal = new TextInputModal(
      this.app,
      "Name for the new sub-concern:",
      "Sub-concern name",
      (name) => {
        void this.doCreateSubConcern(parentFile, name);
      }
    );
    modal.open();
  }

  private async doCreateSubConcern(parentFile: TFile, name: string): Promise<void> {
    const result = await this.createConcernFile(parentFile, name, "tension");
    if (result) {
      await this.openFile(result.path);
    }
  }

  private async createConcernFile(
    parentFile: TFile,
    name: string,
    kind: string,
    priority?: string
  ): Promise<{ path: string; fileName: string } | null> {
    const parentName = parentFile.basename;
    const parentDir = parentFile.parent?.path ?? "";
    const propName = this.settings.propertyName.trim() || "type";
    const propValue = this.settings.propertyValue.trim() || "concen";

    const dir = parentDir ? `${parentDir}/` : "";
    let fileName = name;
    let newPath = normalizePath(`${dir}${fileName}.md`);

    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(newPath)) {
      fileName = `${name} ${counter}`;
      newPath = normalizePath(`${dir}${fileName}.md`);
      counter++;
    }

    const id = this.generateConcernId();
    const frontmatterLines = [
      "---",
      `${propName}: ${propValue}`,
      `parent: "[[${parentName}]]"`,
      `kind: ${kind}`,
      `id: "${id}"`,
    ];
    if (priority) {
      frontmatterLines.push(`priority: ${priority}`);
    }
    frontmatterLines.push("---", "");
    const frontmatter = frontmatterLines.join("\n");

    try {
      await this.app.vault.create(newPath, frontmatter);
      return { path: newPath, fileName };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to create concern: ${message}`);
      return null;
    }
  }

  private sanitizeFileName(text: string): string {
    return text
      .replace(/[\\/:*?"<>|]/g, "-")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, "-")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .replace(/-{2,}/g, "-")
      || "untitled";
  }

  async promoteCheckboxToConcern(filePath: string, line: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const lineText = lines[line];
    if (!lineText) return;

    const match = /^(\s*)[-*] \[ \]\s+(.+)$/.exec(lineText);
    if (!match) return;

    const indent = match[1];
    const rawText = match[2].trim();
    const priorityRank = parsePriorityFromText(rawText);
    const priority = priorityRank != null ? `p${priorityRank}` : undefined;
    const cleanText = stripPriorityEmojis(rawText);
    const safeName = this.sanitizeFileName(cleanText);

    this.openConcernPicker({
      placeholder: "Move inline task to...",
      onChoose: (parentFile: TFile) => {
        void this.moveOrPromoteCheckbox(file, line, lineText, indent, safeName, parentFile, priority);
      }
    });
  }

  private async moveOrPromoteCheckbox(
    sourceFile: TFile,
    line: number,
    originalLineText: string,
    indent: string,
    safeName: string,
    targetFile: TFile,
    priority?: string
  ): Promise<void> {
    // If target has a Tasks section, move inline task there instead of promoting
    if (targetFile.path !== sourceFile.path) {
      const targetContent = await this.app.vault.read(targetFile);
      const insertIdx = this.findTasksSectionInsertLine(targetContent);
      if (insertIdx >= 0) {
        await this.moveInlineTaskToFile(sourceFile, line, originalLineText, targetFile);
        return;
      }
    }
    // Fall back to promote-to-concern
    await this.doPromoteCheckbox(sourceFile, line, indent, safeName, targetFile, priority);
  }

  /**
   * Find the line index where a new checkbox should be inserted inside the Tasks section.
   * Returns -1 if no Tasks section exists.
   */
  private findTasksSectionInsertLine(content: string): number {
    const lines = content.split("\n");

    let insideTasksSection = false;
    let sectionHeadingLevel = 0;
    let lastCheckboxLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      const headingMatch = ANY_HEADING_RE.exec(line);

      if (headingMatch) {
        const level = headingMatch[1].length;
        const tasksMatch = TASKS_HEADING_RE.exec(line);
        if (tasksMatch) {
          insideTasksSection = true;
          sectionHeadingLevel = tasksMatch[1].length;
          lastCheckboxLine = i;
          continue;
        }
        if (insideTasksSection && level <= sectionHeadingLevel) {
          // End of Tasks section — insert before this heading
          return lastCheckboxLine + 1;
        }
        continue;
      }

      if (insideTasksSection) {
        if (/^\s*[-*]\s+\[.\]\s+/.test(line)) {
          lastCheckboxLine = i;
        }
      }
    }

    // Tasks section extends to end of file
    if (insideTasksSection) {
      return lastCheckboxLine + 1;
    }
    return -1;
  }

  private async moveInlineTaskToFile(
    sourceFile: TFile,
    sourceLine: number,
    originalLineText: string,
    targetFile: TFile
  ): Promise<void> {
    // Re-read source to verify the line hasn't changed
    const sourceContent = await this.app.vault.read(sourceFile);
    const sourceLines = sourceContent.split("\n");
    if (sourceLines[sourceLine] !== originalLineText) {
      new Notice("The checkbox line appears to have changed. Move aborted.");
      return;
    }

    // Extract the raw checkbox text (normalize indent for the target)
    const checkboxMatch = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(originalLineText);
    if (!checkboxMatch) return;
    const checkboxText = `- [ ] ${checkboxMatch[1].trim()}`;

    // Insert into target first (safer: a failure only produces a duplicate, not data loss)
    const targetContent = await this.app.vault.read(targetFile);
    const insertIdx = this.findTasksSectionInsertLine(targetContent);
    if (insertIdx < 0) {
      new Notice("Target does not have a tasks section. Move aborted.");
      return;
    }
    const targetLines = targetContent.split("\n");
    targetLines.splice(insertIdx, 0, checkboxText);
    await this.app.vault.modify(targetFile, targetLines.join("\n"));

    // Then remove from source
    sourceLines.splice(sourceLine, 1);
    await this.app.vault.modify(sourceFile, sourceLines.join("\n"));
  }

  private async doPromoteCheckbox(
    sourceFile: TFile,
    line: number,
    indent: string,
    safeName: string,
    parentFile: TFile,
    priority?: string
  ): Promise<void> {
    const result = await this.createConcernFile(parentFile, safeName, "task", priority);
    if (!result) return;

    // Replace the checkbox line with a wikilink
    const content = await this.app.vault.read(sourceFile);
    const lines = content.split("\n");
    const currentLine = lines[line];
    if (!currentLine || !/^\s*[-*] \[ \]\s+/.test(currentLine)) {
      new Notice("The checkbox line appears to have changed. Promotion aborted.");
      return;
    }
    lines[line] = `${indent}- [[${result.fileName}]]`;
    await this.app.vault.modify(sourceFile, lines.join("\n"));
  }

  private updateSubConcernHeaderButton(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = activeView?.file ?? null;
    const activePath = activeFile?.path ?? null;
    const isConcern = activeFile != null
      && this.taskFilterService.fileMatchesTaskFilter(activeFile);
    const targetPath = isConcern ? activePath : null;

    if (targetPath === this.subConcernActionFilePath) return;

    this.subConcernActionEl?.remove();
    this.subConcernActionEl = null;
    this.subConcernActionFilePath = null;

    if (!targetPath || !activeView?.file) return;

    const actionsEl = activeView.containerEl.querySelector(".view-actions");
    if (!actionsEl) return;

    const file = activeView.file;
    const btn = activeView.containerEl.createEl("a", {
      cls: "view-action clickable-icon",
      attr: { "aria-label": "Create sub-concern" }
    });
    setIcon(btn, "plus-circle");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      this.createSubConcernForFile(file);
    });

    actionsEl.prepend(btn);
    this.subConcernActionEl = btn;
    this.subConcernActionFilePath = targetPath;
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
    this.timeData = new TimeDataFacade(this.app, this.timeWindowService);
    this.timerNotificationService = new TimerNotificationService();
    this.healthTrackingService = new HealthTrackingService(this.app);
    this.supplementsTrackingService = new SupplementsTrackingService(this.app);
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
      },
      quickAddTask: () => {
        this.openQuickTaskModal();
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
      elapsedLabel: this.timeData.formatClockDuration(elapsedSeconds),
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
    if (this.timeData.timeEntriesById.size === 0) {
      this.macOsTrayRecentConcerns = [];
      return;
    }

    const latestEndMsByNoteId = new Map<string, number>();
    for (const [noteId, entries] of this.timeData.timeEntriesById.entries()) {
      let latestEndMs = 0;
      for (const entry of entries) {
        const endMs = entry.startMs + entry.durationMinutes * 60_000;
        if (endMs > latestEndMs) latestEndMs = endMs;
      }
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
    const basePath = (adapter as unknown as { getBasePath: () => string }).getBasePath();
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

  private async refreshInlineTaskCacheForPath(changedPath: string): Promise<void> {
    const gen = ++this.inlineTaskCacheGeneration;
    const file = this.app.vault.getAbstractFileByPath(changedPath);
    if (!(file instanceof TFile)) return;

    let newItems: InlineTaskItem[];
    try {
      const content = await this.app.vault.cachedRead(file);
      newItems = parseInlineTasksForFile(changedPath, content);
    } catch {
      newItems = [];
    }

    if (gen !== this.inlineTaskCacheGeneration) return;
    this.cachedInlineItems = [
      ...this.cachedInlineItems.filter((item) => item.parentPath !== changedPath),
      ...newItems
    ];
    this.treeStructureVersion++;
    this.refreshTaskStructureViews();
  }

  private async refreshInlineTaskCache(): Promise<void> {
    const gen = ++this.inlineTaskCacheGeneration;
    this.taskFilterService.invalidateCache();
    const fileItems = this.taskFilterService.getTaskTreeItems();
    const results: InlineTaskItem[][] = await Promise.all(
      fileItems.filter(isFileItem).map(async (item) => {
        try {
          const content = await this.app.vault.cachedRead(item.file);
          return parseInlineTasksForFile(item.file.path, content);
        } catch {
          return [];
        }
      })
    );
    if (gen !== this.inlineTaskCacheGeneration) return; // superseded by newer request
    this.cachedInlineItems = results.flat();
    this.treeStructureVersion++;
    this.refreshTaskStructureViews();
  }

  /** A single concern file's content changed (metadata cache update). Scope refresh to that file. */
  private handleConcernContentChange(changedPath: string): void {
    this.taskFilterService.invalidateCache();
    this.recomputeMacOsTrayRecentConcerns();
    void this.refreshInlineTaskCacheForPath(changedPath);
  }

  /** Full structure change (file added/removed/renamed). Re-parse all inline tasks. */
  private handleTaskStructureChange(): void {
    this.taskFilterService.invalidateCache();
    this.recomputeMacOsTrayRecentConcerns();
    void this.refreshInlineTaskCache();
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.isTimeLogPath(oldPath) || this.isTimeLogPath(file.path)) {
      this.rewireTimeLogWatcher();
      await this.reloadTotalsAndRefresh();
      return;
    }

    if (this.isHealthTrackingPath(oldPath) || this.isHealthTrackingPath(file.path)) {
      await this.reloadHealthTrackingAndRefresh();
      return;
    }

    if (this.isSupplementsPath(oldPath) || this.isSupplementsPath(file.path)) {
      await this.reloadSupplementsAndRefresh();
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

    if (this.isHealthTrackingPath(file.path)) {
      await this.reloadHealthTrackingAndRefresh();
      return;
    }

    if (this.isSupplementsPath(file.path)) {
      await this.reloadSupplementsAndRefresh();
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

    if (this.isHealthTrackingPath(file.path)) {
      await this.reloadHealthTrackingAndRefresh();
      return;
    }

    if (this.isSupplementsPath(file.path)) {
      await this.reloadSupplementsAndRefresh();
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

  private isHealthTrackingPath(path: string): boolean {
    return this.healthTrackingService.matchesTrackingPath(path);
  }

  private async reloadHealthTrackingAndRefresh(): Promise<void> {
    await this.healthTrackingService.reload();
    this.viewController.refreshViewByType(VIEW_TYPE_LIFE_DASHBOARD_CALENDAR);
  }

  private isSupplementsPath(path: string): boolean {
    return this.supplementsTrackingService.matchesPath(path);
  }

  private async reloadSupplementsAndRefresh(): Promise<void> {
    await this.supplementsTrackingService.reload();
    this.viewController.refreshViewByType(VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS);
  }

  private scheduleDebouncedSave(timerField: "outlineFilterSaveTimer" | "canvasDraftSaveTimer" | "concernMapSaveTimer"): void {
    if (this[timerField] !== null) {
      window.clearTimeout(this[timerField]);
    }

    this[timerField] = window.setTimeout(() => {
      this[timerField] = null;
      void this.saveSettings();
    }, 300);
  }

  private scheduleOutlineFilterSave(): void {
    this.scheduleDebouncedSave("outlineFilterSaveTimer");
  }

  private scheduleCanvasDraftSave(): void {
    this.scheduleDebouncedSave("canvasDraftSaveTimer");
  }

  private scheduleConcernMapSave(): void {
    this.scheduleDebouncedSave("concernMapSaveTimer");
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
      this.timeData.clear();
      this.recomputeMacOsTrayRecentConcerns();
      console.error("[life-dashboard] Failed to read time totals:", error);
    }
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

  private openQuickTaskModal(): void {
    if (this.tryOpenQuickTaskNativeWindow()) return;
    // Fallback for non-desktop or missing Electron APIs
    const modal = new QuickTaskModal(this.app, (text, priorityEmoji) => {
      void this.addQuickTaskToInbox(text, priorityEmoji);
    });
    modal.open();
  }

  private tryOpenQuickTaskNativeWindow(): boolean {
    try {
      const req = (window as unknown as { require?: (id: string) => unknown }).require;
      if (!req) return false;

      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
      let BrowserWindow: any, screen: any;
      try {
        const m = req("electron/main") as any;
        BrowserWindow = m?.BrowserWindow;
        screen = m?.screen;
      } catch { /* ignore */ }
      if (!BrowserWindow) {
        try {
          const e = req("electron") as any;
          BrowserWindow = e?.BrowserWindow ?? e?.remote?.BrowserWindow;
          screen = e?.screen ?? e?.remote?.screen;
        } catch { /* ignore */ }
      }
      if (!BrowserWindow || !screen) return false;

      const display = screen.getPrimaryDisplay();
      const width = 480;
      const height = 86;
      const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
      const y = Math.round(display.workArea.y + display.workArea.height * 0.25);

      const isDark = document.body.classList.contains("theme-dark");
      const bg = isDark ? "#1e1e2e" : "#ffffff";
      const fg = isDark ? "#cdd6f4" : "#1e1e2e";
      const brd = isDark ? "#45475a" : "#d0d0d0";
      const ibg = isDark ? "#313244" : "#f5f5f5";
      const acc = isDark ? "#89b4fa" : "#4e79a7";

      const html = `<!DOCTYPE html><html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{padding:10px 14px;font-family:-apple-system,sans-serif;background:${bg};color:${fg};display:flex;flex-direction:column;gap:6px;overflow:hidden}
input{width:100%;padding:6px 10px;border:1px solid ${brd};border-radius:6px;background:${ibg};color:${fg};font-size:14px;outline:none}
input:focus{border-color:${acc}}
.r{display:flex;gap:4px;align-items:center}
button{border:1px solid ${brd};border-radius:10px;background:${ibg};color:${fg};font-size:11px;padding:2px 7px;cursor:pointer;opacity:.7}
button:hover{opacity:1}
button.a{border-color:${acc};color:${acc};opacity:1}
.h{font-size:10px;color:${brd};flex:1;text-align:right}
</style></head><body>
<input id="t" placeholder="Task description" autofocus/>
<div class="r"><button data-p="0">p0</button><button data-p="1">p1</button><button data-p="2">p2</button><button data-p="3">p3</button><button id="clr" style="display:none">-</button><span class="h">\u2318+0-3 priority \u00b7 Enter add \u00b7 Esc cancel</span></div>
<script>
let pr=null;
function setPr(p){
  if(pr===p){pr=null}else{pr=p}
  document.querySelectorAll('[data-p]').forEach(x=>x.classList.toggle('a',x.dataset.p===pr));
  document.getElementById('clr').style.display=pr!=null?'':'none';
  document.getElementById('t').focus();
}
document.querySelectorAll('[data-p]').forEach(b=>{b.onclick=()=>setPr(b.dataset.p)});
document.getElementById('clr').onclick=()=>setPr(null);
document.addEventListener('keydown',e=>{
  if(e.metaKey&&e.key>='0'&&e.key<='3'){e.preventDefault();setPr(e.key);return}
  if(e.metaKey&&e.key==='-'){e.preventDefault();setPr(null);return}
  if(e.key==='Enter'){e.preventDefault();sub()}
  if(e.key==='Escape'){window.close()}
});
function sub(){const t=document.getElementById('t').value.trim();if(!t)return;document.title='R:'+JSON.stringify({t,p:pr})}
</script></body></html>`;

      const win = new BrowserWindow({
        width, height, x, y,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        show: false,
        hasShadow: true,
        roundedCorners: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });

      win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      win.webContents.once("page-title-updated", () => {
        const title = win.getTitle();
        if (!title.startsWith("R:")) return;
        try {
          const data = JSON.parse(title.slice(2));
          const emoji = data.p ? (PRIORITY_DIGIT_TO_EMOJI.get(data.p) ?? null) : null;
          void this.addQuickTaskToInbox(data.t, emoji);
        } catch { /* ignore */ }
        if (!win.isDestroyed()) win.close();
      });
      win.once("ready-to-show", () => {
        win.show();
        win.focus();
        win.webContents.focus();
      });
      win.on("blur", () => { if (!win.isDestroyed()) win.close(); });
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */

      return true;
    } catch {
      return false;
    }
  }

  private async addQuickTaskToInbox(text: string, priorityEmoji: string | null): Promise<void> {
    const inboxPath = this.settings.inboxNotePath;
    if (!inboxPath) {
      new Notice("No inbox note configured. Set it in plugin settings.");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(inboxPath);
    if (!(file instanceof TFile)) {
      new Notice(`Inbox note not found: ${inboxPath}`);
      return;
    }

    const prefix = priorityEmoji ? `${priorityEmoji} ` : "";
    const checkboxText = `- [ ] ${prefix}${text}`;

    let inserted = false;
    await this.app.vault.process(file, (content) => {
      const insertIdx = this.findTasksSectionInsertLine(content);
      if (insertIdx < 0) return content;
      inserted = true;
      const lines = content.split("\n");
      lines.splice(insertIdx, 0, checkboxText);
      return lines.join("\n");
    });
    if (inserted) {
      new Notice(`Added to inbox: ${text}`);
    } else {
      new Notice("Inbox note does not have a tasks section.");
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

  private generateConcernId(): string {
    return new Date().toISOString();
  }

  private async ensureTaskIdForFile(file: TFile): Promise<string> {
    const existing = this.getTaskIdForFile(file);
    if (existing) return existing;

    const generated = this.generateConcernId();

    try {
      /* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const current = this.getTaskIdFromFrontmatter(fm);
        if (current) return;
        fm.id = generated;
      });
      /* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not update frontmatter id: ${message}`);
      return "";
    }

    const resolved = this.getTaskIdForFile(file);
    return resolved || generated;
  }

  private async loadSettings(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.timeLogPath = this.getNormalizedTimeLogPath();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
