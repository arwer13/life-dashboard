import type { App, WorkspaceLeaf } from "obsidian";
import { LifeDashboardBaseView } from "../ui/views/base-view";
import { LifeDashboardTimerView } from "../ui/views/timer-view";
import {
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  VIEW_TYPE_LIFE_DASHBOARD_TIMELOG,
  VIEW_TYPE_LIFE_DASHBOARD_TIMER
} from "../models/view-types";
import type { LifeDashboardSettings } from "../settings";

export class DashboardViewController {
  private readonly app: App;
  private readonly settings: LifeDashboardSettings;
  private readonly saveSettings: () => Promise<void>;
  private lastPersistedVisibility = false;

  constructor(app: App, settings: LifeDashboardSettings, saveSettings: () => Promise<void>) {
    this.app = app;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.lastPersistedVisibility = Boolean(this.settings.viewWasVisible);
  }

  syncLastPersistedVisibility(): void {
    this.lastPersistedVisibility = Boolean(this.settings.viewWasVisible);
  }

  async activateView(): Promise<void> {
    const timerLeaf = await this.ensureViewLeaf(VIEW_TYPE_LIFE_DASHBOARD_TIMER, false, false);
    if (!timerLeaf) return;

    const outlineLeaf = await this.ensureViewLeaf(VIEW_TYPE_LIFE_DASHBOARD_OUTLINE, true, true);
    if (!outlineLeaf) return;

    this.app.workspace.revealLeaf(outlineLeaf);
    const canvasLeaf = await this.ensureViewLeaf(
      VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
      false,
      false,
      "tab"
    );
    if (!canvasLeaf) return;

    this.app.workspace.revealLeaf(canvasLeaf);
    const calendarLeaf = await this.ensureViewLeaf(
      VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
      false,
      false,
      "tab"
    );
    if (calendarLeaf) {
      this.app.workspace.revealLeaf(calendarLeaf);
    }
    await this.persistVisibilityState(true);
    this.refreshView();
  }

  async activateCanvasView(): Promise<void> {
    await this.openAndRevealView(VIEW_TYPE_LIFE_DASHBOARD_CANVAS, "tab");
  }

  async activateTimerView(): Promise<void> {
    await this.openAndRevealView(VIEW_TYPE_LIFE_DASHBOARD_TIMER);
  }

  async activateOutlineView(): Promise<void> {
    await this.openAndRevealView(VIEW_TYPE_LIFE_DASHBOARD_OUTLINE);
  }

  async activateCalendarView(): Promise<void> {
    await this.openAndRevealView(VIEW_TYPE_LIFE_DASHBOARD_CALENDAR, "tab");
  }

  async activateTimeLogView(): Promise<void> {
    await this.openAndRevealView(VIEW_TYPE_LIFE_DASHBOARD_TIMELOG, "tab");
  }

  private static readonly ALL_VIEW_TYPES = [
    VIEW_TYPE_LIFE_DASHBOARD_TIMER,
    VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
    VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
    VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
    VIEW_TYPE_LIFE_DASHBOARD_TIMELOG
  ] as const;

  private static readonly TASK_STRUCTURE_VIEW_TYPES = [
    VIEW_TYPE_LIFE_DASHBOARD_TIMER,
    VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
    VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
    VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
    VIEW_TYPE_LIFE_DASHBOARD_TIMELOG
  ] as const;

  private static readonly TIME_TRACKING_VIEW_TYPES = [
    VIEW_TYPE_LIFE_DASHBOARD_TIMER,
    VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
    VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
    VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
    VIEW_TYPE_LIFE_DASHBOARD_TIMELOG
  ] as const;

  refreshView(): void {
    this.refreshViews(DashboardViewController.ALL_VIEW_TYPES);
  }

  refreshTaskStructureViews(): void {
    this.refreshViews(DashboardViewController.TASK_STRUCTURE_VIEW_TYPES);
  }

  refreshTimeTrackingViews(): void {
    this.refreshViews(DashboardViewController.TIME_TRACKING_VIEW_TYPES);
  }

  pushLiveTimerUpdate(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD_TIMER);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardTimerView) {
        view.updateLiveTimer();
      }
    }
  }

  async persistVisibilityState(force = false): Promise<void> {
    const visible = this.isDashboardVisible();
    if (!force && visible === this.lastPersistedVisibility) return;

    this.settings.viewWasVisible = visible;
    this.lastPersistedVisibility = visible;
    await this.saveSettings();
  }

  private refreshViewByType(viewType: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      if (leaf.view instanceof LifeDashboardBaseView && "render" in leaf.view) {
        void (leaf.view as LifeDashboardBaseView & { render(): Promise<void> }).render();
      }
    }
  }

  private refreshViews(viewTypes: readonly string[]): void {
    for (const viewType of viewTypes) {
      this.refreshViewByType(viewType);
    }
  }

  private isDashboardVisible(): boolean {
    return DashboardViewController.ALL_VIEW_TYPES.some(
      (t) => this.app.workspace.getLeavesOfType(t).length > 0
    );
  }

  private async openAndRevealView(
    viewType: string,
    placement: "right" | "tab" = "right"
  ): Promise<void> {
    const leaf = await this.ensureViewLeaf(viewType, false, true, placement);
    if (!leaf) return;
    this.app.workspace.revealLeaf(leaf);
    await this.persistVisibilityState(true);
    this.refreshViewByType(viewType);
  }

  private async ensureViewLeaf(
    viewType: string,
    split: boolean,
    active: boolean,
    placement: "right" | "tab" = "right"
  ): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const leaf =
      workspace.getLeavesOfType(viewType)[0] ??
      (placement === "tab" ? workspace.getLeaf("tab") : workspace.getRightLeaf(split));
    if (!leaf) return null;

    if (leaf.getViewState().type !== viewType) {
      await leaf.setViewState({ type: viewType, active });
    }

    return leaf;
  }
}
