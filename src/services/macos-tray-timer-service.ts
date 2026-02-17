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

export type MacOsTrayTimerViewModel = {
  enabled: boolean;
  isTracking: boolean;
  elapsedLabel: string;
  taskLabel: string;
};

type MacOsTrayTimerActions = {
  openTimer: () => void;
  startTimer: () => void;
  stopTimer: () => void;
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
    } catch (error) {
      console.warn("[life-dashboard] Failed to create macOS menu bar tray:", error);
      this.destroy();
      this.notifyUnavailable(showUnavailableNotice, "Could not initialize macOS menu bar timer.");
    }
  }

  update(model: MacOsTrayTimerViewModel): void {
    if (!model.enabled) return;

    this.syncEnabled(true, false);
    if (!this.tray) return;

    const stateLabel = model.isTracking ? `Running ${model.elapsedLabel}` : "Timer idle";
    const toolTip = model.taskLabel
      ? `Life Dashboard Timer\n${stateLabel}\nTask: ${model.taskLabel}`
      : `Life Dashboard Timer\n${stateLabel}`;

    this.tray.setTitle?.(model.isTracking ? model.elapsedLabel : "--:--:--");
    this.tray.setToolTip?.(toolTip);

    if (!this.trayMenu) return;

    const template: ElectronMenuItemTemplateLike[] = [
      { label: stateLabel, enabled: false },
      {
        label: model.taskLabel ? `Task: ${model.taskLabel}` : "Task: none selected",
        enabled: false
      },
      { type: "separator" },
      {
        label: "Open Timer",
        click: this.actions.openTimer
      },
      {
        label: model.isTracking ? "Stop Timer" : "Start Timer",
        click: model.isTracking ? this.actions.stopTimer : this.actions.startTimer
      }
    ];

    this.tray.setContextMenu?.(this.trayMenu.buildFromTemplate(template));
  }

  destroy(): void {
    if (this.tray) {
      try {
        this.tray.destroy?.();
      } catch (error) {
        console.warn("[life-dashboard] Failed to destroy macOS menu bar tray:", error);
      }
    }
    this.tray = null;
    this.trayMenu = null;
  }

  private isMacOsDesktop(): boolean {
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

  private createTrayIcon(nativeImage: ElectronNativeImageLike | null): unknown | null {
    if (nativeImage?.createFromDataURL) {
      return nativeImage.createFromDataURL(TRANSPARENT_TRAY_PNG_DATA_URL);
    }
    if (nativeImage?.createEmpty) {
      return nativeImage.createEmpty();
    }
    return null;
  }
}
