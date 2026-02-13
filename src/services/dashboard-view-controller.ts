import type { App, WorkspaceLeaf } from "obsidian";
import {
  LifeDashboardConcernCanvasView,
  LifeDashboardOutlineView,
  LifeDashboardTimerView,
  VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  VIEW_TYPE_LIFE_DASHBOARD_TIMER
} from "../ui/life-dashboard-view";
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
    await this.persistVisibilityState(true);
    this.refreshView();
  }

  refreshView(): void {
    this.refreshTimerView();
    this.refreshOutlineView();
    this.refreshCanvasView();
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

  private refreshTimerView(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD_TIMER);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardTimerView) {
        void view.render();
      }
    }
  }

  private refreshOutlineView(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD_OUTLINE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardOutlineView) {
        void view.render();
      }
    }
  }

  private refreshCanvasView(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD_CANVAS);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardConcernCanvasView) {
        void view.render();
      }
    }
  }

  private isDashboardVisible(): boolean {
    return (
      this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD_TIMER).length > 0 ||
      this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD_OUTLINE).length > 0 ||
      this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD_CANVAS).length > 0
    );
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
