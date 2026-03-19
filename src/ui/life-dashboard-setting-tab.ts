import { PluginSettingTab, Setting, type App } from "obsidian";
import type LifeDashboardPlugin from "../plugin";
import { DEFAULT_TIME_LOG_PATH } from "../settings";
import { FileSuggest } from "./file-suggest";

type TextSettingConfig = {
  name: string;
  description: string;
  placeholder: string;
  getValue: () => string;
  setValue: (value: string) => void;
  afterSave?: () => Promise<void>;
  transform?: (value: string) => string;
  fileSuggest?: boolean;
};

type TextAreaSettingConfig = {
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

type DropdownSettingConfig = {
  name: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  getValue: () => string;
  setValue: (value: string) => void;
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
        name: "Kanban default column property",
        description: "Frontmatter property used for kanban columns when creating a new board view.",
        placeholder: "status",
        getValue: () => this.plugin.settings.kanbanDefaultColumnProperty,
        setValue: (value) => {
          this.plugin.settings.kanbanDefaultColumnProperty = value;
        },
        transform: (value) => value.trim() || "status"
      },
      {
        name: "Kanban default swimlane property",
        description: "Frontmatter property used for kanban swimlanes when creating a new board view. Leave empty to disable swimlanes by default.",
        placeholder: "priority",
        getValue: () => this.plugin.settings.kanbanDefaultSwimlaneProperty,
        setValue: (value) => {
          this.plugin.settings.kanbanDefaultSwimlaneProperty = value;
        },
        transform: (value) => value.trim()
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
        name: "Outline max rows",
        description: "Maximum number of rows displayed in canvas/outline tree panels before truncating.",
        placeholder: "1000",
        getValue: () => String(this.plugin.settings.outlineMaxRows),
        setValue: (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.outlineMaxRows = Number.isFinite(parsed) && parsed >= 50 ? parsed : 1000;
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
          await this.plugin.onTimeLogPathSettingChanged();
        }
      },
      {
        name: "Inbox note path",
        description: "Vault path to the inbox concern note (e.g., \"Inbox.md\"). Used by the tray Quick Task action.",
        placeholder: "Inbox.md",
        getValue: () => this.plugin.settings.inboxNotePath,
        setValue: (value) => {
          this.plugin.settings.inboxNotePath = value;
        },
        transform: (value) => value.trim(),
        fileSuggest: true
      },
      {
        name: "Inbox global shortcut",
        description: "System-wide shortcut to open the Add to inbox window. Uses Electron accelerator format (e.g., CommandOrControl+Alt+Shift+I). Leave empty to disable.",
        placeholder: "CommandOrControl+Alt+Shift+I",
        getValue: () => this.plugin.settings.inboxGlobalShortcut,
        setValue: (value) => {
          this.plugin.settings.inboxGlobalShortcut = value;
        },
        transform: (value) => value.trim(),
        afterSave: async () => {
          this.plugin.onInboxGlobalShortcutSettingChanged();
        }
      }
    ];

    for (const config of textSettings) {
      this.addTextSetting(containerEl, config);
    }

    this.addTextAreaSetting(containerEl, {
      name: "Timer notifications",
      description:
        "One rule per line. Format: 30m \"Message\" (also supports s/h). Example: 30m \"Hey, the time is up!\"",
      placeholder:
        "30m \"Hey, the time is up!\"\n35m \"You don't wanna miss the opportunity!\"",
      getValue: () => this.plugin.settings.timerNotificationRules,
      setValue: (value) => {
        this.plugin.settings.timerNotificationRules = value;
      },
      afterSave: async () => {
        this.plugin.refreshView();
      }
    });

    this.addToggleSetting(containerEl, {
      name: "macOS menu bar timer (experimental)",
      description:
        "Shows the running timer in the macOS menu bar while Obsidian is open. Requires desktop Obsidian on macOS.",
      getValue: () => this.plugin.settings.macOsTrayTimerEnabled,
      setValue: (value) => {
        this.plugin.settings.macOsTrayTimerEnabled = value;
      },
      afterSave: async () => {
        this.plugin.onMacOsTrayTimerSettingChanged();
      }
    });

    this.addToggleSetting(containerEl, {
      name: "Case sensitive",
      description: "If enabled, value matching is case sensitive for all filters.",
      getValue: () => this.plugin.settings.caseSensitive,
      setValue: (value) => {
        this.plugin.settings.caseSensitive = value;
      },
      afterSave: refreshFilters
    });

    this.addDropdownSetting(containerEl, {
      name: "Week starts on",
      description: "Used for This week totals in timer summaries and outline range filtering.",
      options: [
        { value: "monday", label: "Monday" },
        { value: "sunday", label: "Sunday" }
      ],
      getValue: () => this.plugin.settings.weekStartsOn,
      setValue: (value) => {
        this.plugin.settings.weekStartsOn = value === "sunday" ? "sunday" : "monday";
      },
      afterSave: async () => {
        this.plugin.refreshView();
      }
    });
  }

  private createDebouncedPersist(afterSave?: () => Promise<void>): {
    schedulePersist: () => void;
    flushPersist: () => void;
  } {
    let saveTimer: number | null = null;
    let dirty = false;
    let persistRunning = false;

    const persistIfNeeded = async (): Promise<void> => {
      if (!dirty || persistRunning) return;
      persistRunning = true;
      dirty = false;
      try {
        await this.persistAndAfterSave(afterSave);
      } catch (error) {
        console.error("[life-dashboard] Failed to persist setting:", error);
      } finally {
        persistRunning = false;
        if (dirty) void persistIfNeeded();
      }
    };

    return {
      schedulePersist: () => {
        dirty = true;
        if (saveTimer !== null) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          saveTimer = null;
          void persistIfNeeded();
        }, 350);
      },
      flushPersist: () => {
        if (saveTimer !== null) {
          window.clearTimeout(saveTimer);
          saveTimer = null;
        }
        if (!dirty) return;
        void persistIfNeeded();
      }
    };
  }

  private addTextSetting(containerEl: HTMLElement, config: TextSettingConfig): void {
    const { schedulePersist, flushPersist } = this.createDebouncedPersist(config.afterSave);

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

        if (config.fileSuggest) {
          new FileSuggest(this.app, text.inputEl);
        }

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

  private addTextAreaSetting(containerEl: HTMLElement, config: TextAreaSettingConfig): void {
    const { schedulePersist, flushPersist } = this.createDebouncedPersist(config.afterSave);

    new Setting(containerEl)
      .setName(config.name)
      .setDesc(config.description)
      .addTextArea((area) => {
        area
          .setPlaceholder(config.placeholder)
          .setValue(config.getValue())
          .onChange((value) => {
            const transform = config.transform ?? ((next: string) => next);
            config.setValue(transform(value));
            schedulePersist();
          });

        area.inputEl.rows = 3;
        area.inputEl.addEventListener("blur", () => {
          flushPersist();
        });

        return area;
      });
  }

  private addDropdownSetting(containerEl: HTMLElement, config: DropdownSettingConfig): void {
    new Setting(containerEl)
      .setName(config.name)
      .setDesc(config.description)
      .addDropdown((dropdown) => {
        for (const option of config.options) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown.setValue(config.getValue()).onChange(async (value) => {
          config.setValue(value);
          await this.persistAndAfterSave(config.afterSave);
        });
      });
  }

  private async persistAndAfterSave(afterSave?: () => Promise<void>): Promise<void> {
    await this.plugin.saveSettings();
    if (afterSave) {
      await afterSave();
    }
  }
}
