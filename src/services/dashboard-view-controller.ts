import type { App, WorkspaceLeaf } from "obsidian";
import { LifeDashboardView, VIEW_TYPE_LIFE_DASHBOARD } from "../ui/life-dashboard-view";
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

  refreshView(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardView) {
        void view.render();
      }
    }
  }

  pushLiveTimerUpdate(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof LifeDashboardView) {
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

  private isDashboardVisible(): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFE_DASHBOARD).length > 0;
  }
}
