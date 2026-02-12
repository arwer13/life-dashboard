import { PluginSettingTab, Setting, type App } from "obsidian";
import type LifeDashboardPlugin from "../plugin";
import { DEFAULT_TIME_LOG_PATH } from "../settings";

type TextSettingConfig = {
  name: string;
  description: string;
  placeholder: string;
  getValue: () => string;
  setValue: (value: string) => void;
  afterSave?: () => Promise<void>;
  transform?: (value: string) => string;
};

type ToggleSettingConfig = {
  name: string;
  description: string;
  getValue: () => boolean;
  setValue: (value: boolean) => void;
  afterSave?: () => Promise<void>;
};

export class LifeDashboardSettingTab extends PluginSettingTab {
  private readonly plugin: LifeDashboardPlugin;

  constructor(app: App, plugin: LifeDashboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Life Dashboard Settings" });

    const refreshFilters = (): Promise<void> => this.plugin.postFilterSettingsChanged();

    const textSettings: TextSettingConfig[] = [
      {
        name: "Task property name",
        description: "Frontmatter key used to identify task notes.",
        placeholder: "type",
        getValue: () => this.plugin.settings.propertyName,
        setValue: (value) => {
          this.plugin.settings.propertyName = value;
        },
        transform: (value) => value.trim(),
        afterSave: refreshFilters
      },
      {
        name: "Task property value",
        description: "Required value for task notes. Leave empty to include any note with the property.",
        placeholder: "concen",
        getValue: () => this.plugin.settings.propertyValue,
        setValue: (value) => {
          this.plugin.settings.propertyValue = value;
        },
        afterSave: refreshFilters
      },
      {
        name: "Additional filter property",
        description: "Optional second frontmatter key to filter task notes.",
        placeholder: "status",
        getValue: () => this.plugin.settings.additionalFilterPropertyName,
        setValue: (value) => {
          this.plugin.settings.additionalFilterPropertyName = value;
        },
        transform: (value) => value.trim(),
        afterSave: refreshFilters
      },
      {
        name: "Additional filter value",
        description: "Optional second filter value. Leave empty to require only additional property presence.",
        placeholder: "active",
        getValue: () => this.plugin.settings.additionalFilterPropertyValue,
        setValue: (value) => {
          this.plugin.settings.additionalFilterPropertyValue = value;
        },
        afterSave: refreshFilters
      },
      {
        name: "Minimum trackable time (minutes)",
        description: "Sessions shorter than this are discarded when pressing Stop.",
        placeholder: "2",
        getValue: () => String(this.plugin.settings.minimumTrackableMinutes),
        setValue: (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.minimumTrackableMinutes = Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
        },
        transform: (value) => value.trim(),
        afterSave: async () => {
          this.plugin.refreshView();
        }
      },
      {
        name: "Time log file path",
        description: "JSON file path in vault where time entries are stored.",
        placeholder: DEFAULT_TIME_LOG_PATH,
        getValue: () => this.plugin.settings.timeLogPath,
        setValue: (value) => {
          this.plugin.settings.timeLogPath = value;
        },
        transform: (value) => value.trim() || DEFAULT_TIME_LOG_PATH,
        afterSave: async () => {
          await this.plugin.reloadTimeTotals();
          this.plugin.refreshView();
        }
      }
    ];

    for (const config of textSettings) {
      this.addTextSetting(containerEl, config);
    }

    this.addToggleSetting(containerEl, {
      name: "Case sensitive",
      description: "If enabled, value matching is case sensitive for all filters.",
      getValue: () => this.plugin.settings.caseSensitive,
      setValue: (value) => {
        this.plugin.settings.caseSensitive = value;
      },
      afterSave: refreshFilters
    });
  }

  private addTextSetting(containerEl: HTMLElement, config: TextSettingConfig): void {
    let saveTimer: number | null = null;
    let dirty = false;
    let persistRunning = false;

    const persistIfNeeded = async (): Promise<void> => {
      if (!dirty || persistRunning) return;

      persistRunning = true;
      dirty = false;
      try {
        await this.persistAndAfterSave(config.afterSave);
      } catch (error) {
        console.error("[life-dashboard] Failed to persist text setting:", error);
      } finally {
        persistRunning = false;
        if (dirty) {
          void persistIfNeeded();
        }
      }
    };

    const schedulePersist = (): void => {
      dirty = true;
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
      }

      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void persistIfNeeded();
      }, 350);
    };

    const flushPersist = (): void => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (!dirty) return;
      void persistIfNeeded();
    };

    new Setting(containerEl)
      .setName(config.name)
      .setDesc(config.description)
      .addText((text) => {
        text
          .setPlaceholder(config.placeholder)
          .setValue(config.getValue())
          .onChange((value) => {
            const transform = config.transform ?? ((next: string) => next);
            config.setValue(transform(value));
            schedulePersist();
          });

        text.inputEl.addEventListener("blur", () => {
          flushPersist();
        });

        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          flushPersist();
        });

        return text;
      });
  }

  private addToggleSetting(containerEl: HTMLElement, config: ToggleSettingConfig): void {
    new Setting(containerEl)
      .setName(config.name)
      .setDesc(config.description)
      .addToggle((toggle) =>
        toggle.setValue(config.getValue()).onChange(async (value) => {
          config.setValue(value);
          await this.persistAndAfterSave(config.afterSave);
        })
      );
  }

  private async persistAndAfterSave(afterSave?: () => Promise<void>): Promise<void> {
    await this.plugin.saveSettings();
    if (afterSave) {
      await afterSave();
    }
  }
}
