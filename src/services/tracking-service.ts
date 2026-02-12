import { Notice, TFile, type App } from "obsidian";
import type { LifeDashboardSettings } from "../settings";

type TrackingServiceDeps = {
  app: App;
  settings: LifeDashboardSettings;
  saveSettings: () => Promise<void>;
  refreshView: () => void;
  fileMatchesTaskFilter: (file: TFile) => boolean;
  ensureTaskIdForFile: (file: TFile) => Promise<string>;
  appendTimeEntry: (noteId: string, startMs: number, endMs: number) => Promise<void>;
  reloadTimeTotals: () => Promise<void>;
};

type FinalizeResult =
  | { status: "ok" }
  | { status: "invalid-state" }
  | { status: "below-minimum"; minimumMinutes: number }
  | { status: "append-failed"; message: string }
  | { status: "reload-failed"; message: string };

export class TrackingService {
  private readonly deps: TrackingServiceDeps;

  constructor(deps: TrackingServiceDeps) {
    this.deps = deps;
  }

  getActiveTaskPath(): string {
    if (this.deps.settings.activeTrackingStart && this.deps.settings.activeTrackingTaskPath) {
      return this.deps.settings.activeTrackingTaskPath;
    }
    return this.deps.settings.selectedTaskPath || "";
  }

  getCurrentElapsedSeconds(): number {
    if (!this.deps.settings.activeTrackingStart) return 0;
    const now = Date.now();
    const start = Number(this.deps.settings.activeTrackingStart);
    if (!Number.isFinite(start) || start <= 0) return 0;
    return Math.max(0, Math.floor((now - start) / 1000));
  }

  async startTracking(): Promise<void> {
    if (this.deps.settings.activeTrackingStart) return;

    let taskPath = this.deps.settings.selectedTaskPath;
    if (!taskPath) {
      const activeFile = this.deps.app.workspace.getActiveFile();
      if (activeFile instanceof TFile && this.deps.fileMatchesTaskFilter(activeFile)) {
        taskPath = activeFile.path;
      }
    }

    if (!taskPath) {
      new Notice("Select a task first (Change task...) or open a task note.");
      return;
    }

    const taskFile = this.deps.app.vault.getAbstractFileByPath(taskPath);
    if (!(taskFile instanceof TFile)) {
      new Notice("Selected task note was not found.");
      return;
    }

    const taskId = await this.deps.ensureTaskIdForFile(taskFile);
    if (!taskId) {
      new Notice("Could not prepare task id for tracking.");
      return;
    }

    this.deps.settings.selectedTaskPath = taskPath;
    this.deps.settings.activeTrackingTaskPath = taskPath;
    this.deps.settings.activeTrackingTaskId = taskId;
    this.deps.settings.activeTrackingStart = Date.now();
    await this.deps.saveSettings();
    this.deps.refreshView();
  }

  async stopTracking(): Promise<void> {
    const result = await this.finalizeActiveTracking({
      reloadTotals: true,
      preserveActiveOnFailure: false,
      enforceMinimumDuration: true
    });

    if (result.status === "append-failed") {
      new Notice(`Stopped timer, but failed to save time entry: ${result.message}`);
    } else if (result.status === "reload-failed") {
      new Notice(`Stopped timer, but failed to refresh totals: ${result.message}`);
    } else if (result.status === "invalid-state") {
      new Notice("Stopped timer. Previous active tracking state was invalid.");
    } else if (result.status === "below-minimum") {
      new Notice(`Session was shorter than ${result.minimumMinutes} minute(s), so it was not saved.`);
    }

    if (result.status !== "ok") {
      // View is not refreshed via normal success path for failure cases.
      this.deps.refreshView();
      return;
    }
  }

  async flushActiveTrackingOnUnload(): Promise<void> {
    await this.finalizeActiveTracking({
      reloadTotals: false,
      preserveActiveOnFailure: true,
      enforceMinimumDuration: false
    });
  }

  private async finalizeActiveTracking(options: {
    reloadTotals: boolean;
    preserveActiveOnFailure: boolean;
    enforceMinimumDuration: boolean;
  }): Promise<FinalizeResult> {
    if (!this.deps.settings.activeTrackingStart) return { status: "ok" };

    const startMs = Number(this.deps.settings.activeTrackingStart);
    const endMs = Date.now();
    const taskId = this.deps.settings.activeTrackingTaskId;
    const minimumMinutes = Math.max(1, Math.floor(this.deps.settings.minimumTrackableMinutes || 2));

    if (!taskId || !Number.isFinite(startMs) || startMs <= 0 || endMs < startMs) {
      if (!options.preserveActiveOnFailure) {
        this.clearActiveState();
        await this.deps.saveSettings();
      }
      return { status: "invalid-state" };
    }

    if (options.enforceMinimumDuration) {
      const elapsedMs = endMs - startMs;
      if (elapsedMs < minimumMinutes * 60_000) {
        this.clearActiveState();
        await this.deps.saveSettings();
        return { status: "below-minimum", minimumMinutes };
      }
    }

    try {
      await this.deps.appendTimeEntry(taskId, startMs, endMs);
    } catch (error) {
      if (!options.preserveActiveOnFailure) {
        this.clearActiveState();
        await this.deps.saveSettings();
      }

      return {
        status: "append-failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }

    this.clearActiveState();
    await this.deps.saveSettings();

    this.deps.refreshView();

    if (!options.reloadTotals) {
      return { status: "ok" };
    }

    try {
      await this.deps.reloadTimeTotals();
      this.deps.refreshView();
      return { status: "ok" };
    } catch (error) {
      return {
        status: "reload-failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private clearActiveState(): void {
    this.deps.settings.activeTrackingStart = null;
    this.deps.settings.activeTrackingTaskPath = "";
    this.deps.settings.activeTrackingTaskId = "";
  }
}
