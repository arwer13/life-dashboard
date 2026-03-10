import {
  BasesView,
  type BasesViewConfig,
  type BasesAllOptions,
  type BasesPropertyOption,
  type BasesToggleOption,
  type BasesPropertyId,
  type BasesEntry,
  type QueryController,
  NullValue,
  TFile,
  parsePropertyId
} from "obsidian";

type KanbanPluginDeps = {
  settings: { kanbanDefaultColumnProperty: string; kanbanDefaultSwimlaneProperty: string };
  openFile: (path: string) => Promise<void>;
};

type KanbanCard = {
  entry: BasesEntry;
  columnValue: string;
  swimlaneValue: string;
};

type KanbanColumn = {
  value: string;
  label: string;
};

type KanbanSwimlane = {
  value: string;
  label: string;
  cards: Map<string, KanbanCard[]>; // columnValue -> cards
};

const UNCATEGORIZED = "\0__uncategorized__";
const UNCATEGORIZED_LABEL = "(uncategorized)";

export const KANBAN_BASES_VIEW_ID = "life-dashboard-kanban";

export function createKanbanViewRegistration(plugin: KanbanPluginDeps): {
  name: string;
  icon: string;
  factory: (controller: QueryController, containerEl: HTMLElement) => BasesView;
  options: (config: BasesViewConfig) => BasesAllOptions[];
} {
  return {
    name: "Kanban",
    icon: "columns-3",
    factory: (controller: QueryController, containerEl: HTMLElement) => {
      return new KanbanBasesView(controller, containerEl, plugin);
    },
    options: (config: BasesViewConfig) => [
      {
        type: "property" as const,
        key: "columnProperty",
        displayName: "Column property",
        default: `note.${plugin.settings.kanbanDefaultColumnProperty}`,
        placeholder: "Select property for columns\u2026"
      } satisfies BasesPropertyOption,
      {
        type: "property" as const,
        key: "swimlaneProperty",
        displayName: "Swimlane property",
        default: `note.${plugin.settings.kanbanDefaultSwimlaneProperty}`,
        placeholder: "Select property for swimlanes\u2026"
      } satisfies BasesPropertyOption,
      {
        type: "toggle" as const,
        key: "showSwimlanes",
        displayName: "Show swimlanes",
        default: true
      } satisfies BasesToggleOption
    ]
  };
}

class KanbanBasesView extends BasesView {
  type = KANBAN_BASES_VIEW_ID;
  private containerEl: HTMLElement;
  private plugin: KanbanPluginDeps;

  constructor(controller: QueryController, containerEl: HTMLElement, plugin: KanbanPluginDeps) {
    super(controller);
    this.containerEl = containerEl;
    this.plugin = plugin;
  }

  onDataUpdated(): void {
    this.renderBoard();
  }

  private resolvePropertyId(key: string, fallbackPropName: string): BasesPropertyId | null {
    const fromConfig = this.config.getAsPropertyId(key);
    if (fromConfig) return fromConfig;
    // config.get() returns undefined when the user hasn't explicitly set it yet
    // (the `default` on BasesPropertyOption is only a UI hint, not a stored value)
    const raw = this.config.get(key);
    const name = typeof raw === "string" && raw ? raw : fallbackPropName;
    if (!name) return null;
    const candidate = name.includes(".") ? name : `note.${name}`;
    if (this.allProperties.includes(candidate as BasesPropertyId)) {
      return candidate as BasesPropertyId;
    }
    return null;
  }

  private getColumnPropertyId(): BasesPropertyId | null {
    return this.resolvePropertyId("columnProperty", this.plugin.settings.kanbanDefaultColumnProperty);
  }

  private getSwimlanePropertyId(): BasesPropertyId | null {
    const show = this.config.get("showSwimlanes");
    if (show !== undefined && !show) return null;
    return this.resolvePropertyId("swimlaneProperty", this.plugin.settings.kanbanDefaultSwimlaneProperty);
  }

  private getEntryStringValue(entry: BasesEntry, propId: BasesPropertyId): string {
    const val = entry.getValue(propId);
    if (!val || val instanceof NullValue || !val.isTruthy()) return UNCATEGORIZED;
    return val.toString().trim() || UNCATEGORIZED;
  }

  private buildBoard(
    colPropId: BasesPropertyId | null,
    swimPropId: BasesPropertyId | null
  ): { columns: KanbanColumn[]; swimlanes: KanbanSwimlane[] } {
    const entries = this.data.data;

    const columnOrder: string[] = [];
    const columnSet = new Set<string>();
    const swimlaneOrder: string[] = [];
    const swimlaneSet = new Set<string>();

    // Index cards by swimlane during initial loop (avoids O(swimlanes × cards) re-filter)
    const cardsBySwimlane = new Map<string, KanbanCard[]>();

    for (const entry of entries) {
      const colVal = colPropId ? this.getEntryStringValue(entry, colPropId) : UNCATEGORIZED;
      const swimVal = swimPropId ? this.getEntryStringValue(entry, swimPropId) : UNCATEGORIZED;

      if (!columnSet.has(colVal)) {
        columnSet.add(colVal);
        columnOrder.push(colVal);
      }
      if (!swimlaneSet.has(swimVal)) {
        swimlaneSet.add(swimVal);
        swimlaneOrder.push(swimVal);
      }

      const card: KanbanCard = { entry, columnValue: colVal, swimlaneValue: swimVal };
      let bucket = cardsBySwimlane.get(swimVal);
      if (!bucket) {
        bucket = [];
        cardsBySwimlane.set(swimVal, bucket);
      }
      bucket.push(card);
    }

    // Move UNCATEGORIZED to end
    const sortWithUncategorizedLast = (arr: string[]): string[] => {
      const withoutUncat = arr.filter((v) => v !== UNCATEGORIZED);
      const hasUncat = arr.includes(UNCATEGORIZED);
      return hasUncat ? [...withoutUncat, UNCATEGORIZED] : withoutUncat;
    };

    const sortedColumns = sortWithUncategorizedLast(columnOrder);
    const sortedSwimlanes = sortWithUncategorizedLast(swimlaneOrder);

    const columns: KanbanColumn[] = sortedColumns.map((v) => ({
      value: v,
      label: v === UNCATEGORIZED ? UNCATEGORIZED_LABEL : v
    }));

    const swimlanes: KanbanSwimlane[] = sortedSwimlanes.map((sv) => {
      const laneCards = cardsBySwimlane.get(sv) ?? [];
      const byColumn = new Map<string, KanbanCard[]>();
      for (const col of sortedColumns) {
        byColumn.set(col, []);
      }
      for (const card of laneCards) {
        const colBucket = byColumn.get(card.columnValue);
        if (colBucket) colBucket.push(card);
      }
      return {
        value: sv,
        label: sv === UNCATEGORIZED ? UNCATEGORIZED_LABEL : sv,
        cards: byColumn
      };
    });

    return { columns, swimlanes };
  }

  private renderBoard(): void {
    this.containerEl.empty();
    this.containerEl.addClass("fmo-kanban-board");

    const colPropId = this.getColumnPropertyId();
    if (!colPropId) {
      this.containerEl.createEl("div", {
        cls: "fmo-kanban-empty",
        text: "Select a column property from the view options to display the kanban board."
      });
      return;
    }

    const swimPropId = this.getSwimlanePropertyId();
    const { columns, swimlanes } = this.buildBoard(colPropId, swimPropId);
    if (columns.length === 0) {
      this.containerEl.createEl("div", {
        cls: "fmo-kanban-empty",
        text: "No entries to display."
      });
      return;
    }

    const showSwimlanes = swimPropId !== null;
    const visibleProps = this.config.getOrder().filter((p) => p !== colPropId);
    const displayNames = new Map(visibleProps.map((p) => [p, this.config.getDisplayName(p)]));

    // Column headers (sticky row)
    const headerRow = this.containerEl.createEl("div", { cls: "fmo-kanban-header-row" });
    if (showSwimlanes) {
      headerRow.createEl("div", { cls: "fmo-kanban-swimlane-header-spacer" });
    }
    for (const col of columns) {
      const headerCell = headerRow.createEl("div", { cls: "fmo-kanban-column-header" });
      headerCell.createEl("span", { cls: "fmo-kanban-column-header-label", text: col.label });
    }

    // Body
    const body = this.containerEl.createEl("div", { cls: "fmo-kanban-body" });

    for (const swimlane of swimlanes) {
      const laneEl = body.createEl("div", { cls: "fmo-kanban-swimlane" });

      if (showSwimlanes) {
        const laneHeader = laneEl.createEl("div", { cls: "fmo-kanban-swimlane-header" });
        laneHeader.createEl("span", {
          cls: "fmo-kanban-swimlane-label",
          text: swimlane.label
        });
      }

      const columnsRow = laneEl.createEl("div", { cls: "fmo-kanban-swimlane-columns" });
      if (showSwimlanes) {
        columnsRow.createEl("div", { cls: "fmo-kanban-swimlane-header-spacer" });
      }

      for (const col of columns) {
        const columnEl = columnsRow.createEl("div", { cls: "fmo-kanban-column" });

        const laneCards = swimlane.cards.get(col.value) ?? [];
        for (const card of laneCards) {
          this.renderCard(columnEl, card, visibleProps, displayNames);
        }

        this.attachDropTarget(columnEl, col.value, swimlane.value, colPropId, swimPropId);
      }
    }
  }

  private renderCard(
    columnEl: HTMLElement,
    card: KanbanCard,
    visibleProps: BasesPropertyId[],
    displayNames: Map<BasesPropertyId, string>
  ): void {
    const cardEl = columnEl.createEl("div", { cls: "fmo-kanban-card" });
    cardEl.draggable = true;

    const titleEl = cardEl.createEl("div", { cls: "fmo-kanban-card-title" });
    titleEl.textContent = card.entry.file.basename;
    titleEl.addEventListener("click", (evt) => {
      evt.preventDefault();
      void this.plugin.openFile(card.entry.file.path);
    });

    if (visibleProps.length > 0) {
      const propsEl = cardEl.createEl("div", { cls: "fmo-kanban-card-props" });
      for (const propId of visibleProps) {
        const val = card.entry.getValue(propId);
        if (!val || val instanceof NullValue || !val.isTruthy()) continue;
        const propRow = propsEl.createEl("div", { cls: "fmo-kanban-card-prop" });
        const label = displayNames.get(propId) ?? propId;
        propRow.createEl("span", { cls: "fmo-kanban-card-prop-label", text: `${label}: ` });
        const valSpan = propRow.createEl("span", { cls: "fmo-kanban-card-prop-value" });
        val.renderTo(valSpan, { app: this.app, sourcePath: card.entry.file.path });
      }
    }

    cardEl.addEventListener("dragstart", (evt) => {
      if (!evt.dataTransfer) return;
      evt.dataTransfer.setData("text/plain", card.entry.file.path);
      evt.dataTransfer.effectAllowed = "move";
      cardEl.addClass("fmo-kanban-card-dragging");
    });

    cardEl.addEventListener("dragend", () => {
      cardEl.removeClass("fmo-kanban-card-dragging");
    });
  }

  private attachDropTarget(
    columnEl: HTMLElement,
    columnValue: string,
    swimlaneValue: string,
    colPropId: BasesPropertyId,
    swimPropId: BasesPropertyId | null
  ): void {
    columnEl.addEventListener("dragover", (evt) => {
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
      columnEl.addClass("fmo-kanban-column-dragover");
    });

    columnEl.addEventListener("dragleave", (evt) => {
      const related = evt.relatedTarget as Node | null;
      if (related && columnEl.contains(related)) return;
      columnEl.removeClass("fmo-kanban-column-dragover");
    });

    columnEl.addEventListener("drop", (evt) => {
      evt.preventDefault();
      columnEl.removeClass("fmo-kanban-column-dragover");

      const filePath = evt.dataTransfer?.getData("text/plain");
      if (!filePath) return;

      void this.moveCard(filePath, columnValue, swimlaneValue, colPropId, swimPropId);
    });
  }

  private async moveCard(
    filePath: string,
    newColumnValue: string,
    newSwimlaneValue: string,
    colPropId: BasesPropertyId,
    swimPropId: BasesPropertyId | null
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const colPropName = parsePropertyId(colPropId).name;
    const swimPropName = swimPropId ? parsePropertyId(swimPropId).name : null;

    const setOrDelete = (fm: Record<string, unknown>, key: string, value: string): void => {
      if (value === UNCATEGORIZED) delete fm[key];
      else fm[key] = value;
    };

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      setOrDelete(fm, colPropName, newColumnValue);
      if (swimPropName) setOrDelete(fm, swimPropName, newSwimlaneValue);
    });
  }
}
