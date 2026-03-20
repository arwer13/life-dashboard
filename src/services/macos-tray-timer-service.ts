import { Notice } from "obsidian";

type ElectronTrayLike = {
  setTitle?: (title: string) => void;
  setToolTip?: (toolTip: string) => void;
  setContextMenu?: (menu: unknown) => void;
  destroy?: () => void;
};

type ElectronTrayConstructor = new (image: unknown) => ElectronTrayLike;

type ElectronMenuItemTemplateLike = {
  label?: string;
  type?: "separator";
  enabled?: boolean;
  accelerator?: string;
  click?: () => void;
};

type ElectronMenuLike = {
  buildFromTemplate: (template: ElectronMenuItemTemplateLike[]) => unknown;
};

type ElectronNativeImageLike = {
  createFromDataURL?: (dataUrl: string) => unknown;
  createEmpty?: () => unknown;
};

type ElectronMainLike = {
  Tray?: ElectronTrayConstructor;
  Menu?: ElectronMenuLike;
  nativeImage?: ElectronNativeImageLike;
};

type ElectronWithRemoteLike = {
  Tray?: ElectronTrayConstructor;
  Menu?: ElectronMenuLike;
  nativeImage?: ElectronNativeImageLike;
  remote?: ElectronMainLike;
};

type ElectronTrayBridge = {
  Tray: ElectronTrayConstructor;
  Menu: ElectronMenuLike | null;
  nativeImage: ElectronNativeImageLike | null;
};

const TRANSPARENT_TRAY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7jquQAAAAASUVORK5CYII=";
export const MAX_MACOS_TRAY_RECENT_CONCERNS = 5;

export type MacOsTrayRecentConcern = {
  label: string;
  path: string;
};

export type MacOsTrayTimerViewModel = {
  enabled: boolean;
  isTracking: boolean;
  elapsedLabel: string;
  taskLabel: string;
  recentConcerns: MacOsTrayRecentConcern[];
  inboxShortcut?: string;
};

type MacOsTrayTimerActions = {
  openTimer: () => void;
  startTimer: () => void;
  stopTimer: () => void;
  startRecentConcern: (path: string) => void;
  quickAddTask: () => void;
};

export class MacOsTrayTimerService {
  private tray: ElectronTrayLike | null = null;
  private trayMenu: ElectronMenuLike | null = null;
  private unavailableNotified = false;

  constructor(private readonly actions: MacOsTrayTimerActions) {}

  syncEnabled(enabled: boolean, showUnavailableNotice: boolean): void {
    if (!enabled) {
      this.destroy();
      this.unavailableNotified = false;
      return;
    }

    if (!this.isMacOsDesktop()) {
      this.destroy();
      this.notifyUnavailable(
        showUnavailableNotice,
        "macOS menu bar timer is available only on desktop Obsidian for macOS."
      );
      return;
    }

    if (this.tray) {
      this.unavailableNotified = false;
      return;
    }

    const bridge = this.getElectronTrayBridge();
    if (!bridge) {
      this.notifyUnavailable(showUnavailableNotice, "macOS menu bar timer is unavailable in this Obsidian build.");
      return;
    }

    const icon = this.createTrayIcon(bridge.nativeImage);
    if (icon == null) {
      this.notifyUnavailable(showUnavailableNotice, "Could not initialize macOS menu bar timer icon.");
      return;
    }

    try {
      this.tray = new bridge.Tray(icon);
      this.trayMenu = bridge.Menu;
      this.unavailableNotified = false;
    } catch {
      this.destroy();
      this.notifyUnavailable(showUnavailableNotice, "Could not initialize macOS menu bar timer.");
    }
  }

  update(model: MacOsTrayTimerViewModel): void {
    if (!model.enabled) return;

    this.syncEnabled(true, false);
    if (!this.tray) return;

    const stateLabel = model.isTracking ? `Running ${model.elapsedLabel}` : "Timer idle";
    const recentConcerns = this.clampRecentConcerns(model.recentConcerns);
    const toolTip = this.buildToolTip(stateLabel, model, recentConcerns);

    this.tray.setTitle?.(model.isTracking ? model.elapsedLabel : "-:-");
    this.tray.setToolTip?.(toolTip);

    if (!this.trayMenu) return;

    const template: ElectronMenuItemTemplateLike[] = [
      { label: stateLabel, enabled: false },
      ...this.buildStateDetailItems(model, recentConcerns),
      { type: "separator" },
      {
        label: "Open Timer",
        click: this.actions.openTimer
      },
      {
        label: model.isTracking ? "Stop Timer" : "Start Timer",
        click: model.isTracking ? this.actions.stopTimer : this.actions.startTimer
      },
      { type: "separator" },
      {
        label: "Add to inbox...",
        accelerator: model.inboxShortcut,
        click: this.actions.quickAddTask
      }
    ];

    this.tray.setContextMenu?.(this.trayMenu.buildFromTemplate(template));
  }

  private clampRecentConcerns(concerns: MacOsTrayRecentConcern[]): MacOsTrayRecentConcern[] {
    return concerns.slice(0, MAX_MACOS_TRAY_RECENT_CONCERNS);
  }

  private buildToolTip(
    stateLabel: string,
    model: MacOsTrayTimerViewModel,
    recentConcerns: MacOsTrayRecentConcern[]
  ): string {
    const toolTipLines = ["Life Dashboard Timer", stateLabel];

    if (model.isTracking) {
      if (model.taskLabel) {
        toolTipLines.push(`Task: ${model.taskLabel}`);
      }
      return toolTipLines.join("\n");
    }

    if (recentConcerns.length > 0) {
      toolTipLines.push("Recent concerns:");
      for (const concern of recentConcerns) {
        toolTipLines.push(`- ${concern.label}`);
      }
      return toolTipLines.join("\n");
    }

    if (model.taskLabel) {
      toolTipLines.push(`Task: ${model.taskLabel}`);
    }

    return toolTipLines.join("\n");
  }

  private buildStateDetailItems(
    model: MacOsTrayTimerViewModel,
    recentConcerns: MacOsTrayRecentConcern[]
  ): ElectronMenuItemTemplateLike[] {
    if (model.isTracking) {
      return [
        {
          label: model.taskLabel ? `Task: ${model.taskLabel}` : "Task: none selected",
          enabled: false
        }
      ];
    }

    if (recentConcerns.length > 0) {
      return [
        { label: "Recent concerns:", enabled: false },
        ...recentConcerns.map((concern) => ({
          label: concern.label,
          click: () => this.actions.startRecentConcern(concern.path)
        }))
      ];
    }

    return [
      {
        label: model.taskLabel ? `Task: ${model.taskLabel}` : "Task: none tracked",
        enabled: false
      }
    ];
  }

  destroy(): void {
    if (this.tray) {
      try {
        this.tray.destroy?.();
      } catch {
        // best-effort cleanup
      }
    }
    this.tray = null;
    this.trayMenu = null;
  }

  private isMacOsDesktop(): boolean {
    // eslint-disable-next-line no-undef
    return typeof process !== "undefined" && process.platform === "darwin";
  }

  private notifyUnavailable(showUnavailableNotice: boolean, message: string): void {
    if (!showUnavailableNotice || this.unavailableNotified) return;
    new Notice(message);
    this.unavailableNotified = true;
  }

  private getElectronTrayBridge(): ElectronTrayBridge | null {
    const req = (window as unknown as { require?: (id: string) => unknown }).require;
    if (!req) return null;

    const extractBridge = (source: ElectronMainLike | undefined): ElectronTrayBridge | null => {
      if (!source?.Tray) return null;
      return {
        Tray: source.Tray,
        Menu: source.Menu ?? null,
        nativeImage: source.nativeImage ?? null
      };
    };

    try {
      const electronMain = req("electron/main") as ElectronMainLike | undefined;
      const bridge = extractBridge(electronMain);
      if (bridge) return bridge;
    } catch {
      // ignore and continue
    }

    try {
      const electron = req("electron") as ElectronWithRemoteLike | undefined;
      const directBridge = extractBridge(electron);
      if (directBridge) return directBridge;
      const remoteBridge = extractBridge(electron?.remote);
      if (remoteBridge) return remoteBridge;
    } catch {
      // ignore
    }

    return null;
  }

  private createTrayIcon(nativeImage: ElectronNativeImageLike | null): unknown {
    if (nativeImage?.createFromDataURL) {
      return nativeImage.createFromDataURL(TRANSPARENT_TRAY_PNG_DATA_URL);
    }
    if (nativeImage?.createEmpty) {
      return nativeImage.createEmpty();
    }
    return null;
  }
}
