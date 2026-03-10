# Kanban Bases View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Register a kanban board as a custom Obsidian Bases view, with configurable column/swimlane frontmatter properties and drag-and-drop that updates note frontmatter.

**Architecture:** The view extends `BasesView` (Obsidian 1.10.0+ API) and is registered via `plugin.registerBasesView()`. Bases handles data querying/filtering from `.base` files; our view renders a column+swimlane board and handles drag-and-drop. Two `BasesPropertyOption`s in the toolbar let users pick column and swimlane properties per-board, with defaults from plugin settings.

**Tech Stack:** TypeScript, Obsidian API (`BasesView`, `BasesEntry`, `BasesQueryResult`, `BasesPropertyOption`, `processFrontMatter`), HTML5 Drag and Drop, CSS.

---

### Task 1: Add plugin settings for kanban defaults

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/ui/life-dashboard-setting-tab.ts`

**Step 1: Add two new settings fields**

In `src/settings.ts`, add to the `LifeDashboardSettings` interface:

```typescript
kanbanDefaultColumnProperty: string;
kanbanDefaultSwimlanProperty: string;
```

And add to `DEFAULT_SETTINGS`:

```typescript
kanbanDefaultColumnProperty: "status",
kanbanDefaultSwimlanProperty: "priority",
```

**Step 2: Add settings UI**

In `src/ui/life-dashboard-setting-tab.ts`, add two text settings to the `textSettings` array (before the "Minimum trackable time" entry):

```typescript
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
  getValue: () => this.plugin.settings.kanbanDefaultSwimlanProperty,
  setValue: (value) => {
    this.plugin.settings.kanbanDefaultSwimlanProperty = value;
  },
  transform: (value) => value.trim()
},
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

**Step 4: Commit**

```bash
git add src/settings.ts src/ui/life-dashboard-setting-tab.ts
git commit -m "feat(kanban): add plugin settings for default column and swimlane properties"
```

---

### Task 2: Create the kanban Bases view file with minimal rendering

**Files:**
- Create: `src/ui/bases/kanban-bases-view.ts`

**Step 1: Create the view file**

Create `src/ui/bases/kanban-bases-view.ts`:

```typescript
import {
  BasesView,
  type BasesViewConfig,
  type BasesAllOptions,
  type BasesPropertyOption,
  type BasesToggleOption,
  type BasesPropertyId,
  type BasesEntry,
  type BasesEntryGroup,
  type QueryController,
  NullValue,
  TFile
} from "obsidian";

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

export function createKanbanViewRegistration(plugin: {
  settings: { kanbanDefaultColumnProperty: string; kanbanDefaultSwimlanProperty: string };
  openFile: (path: string) => Promise<void>;
}): {
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
        placeholder: "Select property for columns…"
      } satisfies BasesPropertyOption,
      {
        type: "property" as const,
        key: "swimlaneProperty",
        displayName: "Swimlane property",
        default: `note.${plugin.settings.kanbanDefaultSwimlanProperty}`,
        placeholder: "Select property for swimlanes…"
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
  private plugin: {
    settings: { kanbanDefaultColumnProperty: string; kanbanDefaultSwimlanProperty: string };
    openFile: (path: string) => Promise<void>;
  };

  constructor(
    controller: QueryController,
    containerEl: HTMLElement,
    plugin: {
      settings: { kanbanDefaultColumnProperty: string; kanbanDefaultSwimlanProperty: string };
      openFile: (path: string) => Promise<void>;
    }
  ) {
    super(controller);
    this.containerEl = containerEl;
    this.plugin = plugin;
  }

  onDataUpdated(): void {
    this.renderBoard();
  }

  private getColumnPropertyId(): BasesPropertyId | null {
    return this.config.getAsPropertyId("columnProperty");
  }

  private getSwimlanPropertyId(): BasesPropertyId | null {
    if (!this.config.get("showSwimlanes")) return null;
    return this.config.getAsPropertyId("swimlaneProperty");
  }

  private getEntryStringValue(entry: BasesEntry, propId: BasesPropertyId): string {
    const val = entry.getValue(propId);
    if (!val || val instanceof NullValue || !val.isTruthy()) return UNCATEGORIZED;
    return val.toString().trim() || UNCATEGORIZED;
  }

  private buildBoard(): { columns: KanbanColumn[]; swimlanes: KanbanSwimlane[] } {
    const colPropId = this.getColumnPropertyId();
    const swimPropId = this.getSwimlanPropertyId();
    const entries = this.data.data;

    // Collect distinct column values (preserving first-seen order)
    const columnOrder: string[] = [];
    const columnSet = new Set<string>();

    // Collect distinct swimlane values
    const swimlaneOrder: string[] = [];
    const swimlaneSet = new Set<string>();

    // Build cards
    const cards: KanbanCard[] = [];
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

      cards.push({ entry, columnValue: colVal, swimlaneValue: swimVal });
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
      const laneCards = cards.filter((c) => c.swimlaneValue === sv);
      const byColumn = new Map<string, KanbanCard[]>();
      for (const col of sortedColumns) {
        byColumn.set(col, []);
      }
      for (const card of laneCards) {
        const bucket = byColumn.get(card.columnValue);
        if (bucket) bucket.push(card);
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

    const { columns, swimlanes } = this.buildBoard();
    if (columns.length === 0) {
      this.containerEl.createEl("div", {
        cls: "fmo-kanban-empty",
        text: "No entries to display."
      });
      return;
    }

    const showSwimlanes = this.getSwimlanPropertyId() !== null;

    // Column headers (sticky row)
    const headerRow = this.containerEl.createEl("div", { cls: "fmo-kanban-header-row" });
    if (showSwimlanes) {
      // Spacer for swimlane header column
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

      for (const col of columns) {
        const columnEl = columnsRow.createEl("div", { cls: "fmo-kanban-column" });
        columnEl.dataset.column = col.value;
        columnEl.dataset.swimlane = swimlane.value;

        const laneCards = swimlane.cards.get(col.value) ?? [];
        for (const card of laneCards) {
          this.renderCard(columnEl, card, colPropId);
        }

        // Drop target handling
        this.attachDropTarget(columnEl, col.value, swimlane.value, colPropId);
      }
    }
  }

  private renderCard(
    columnEl: HTMLElement,
    card: KanbanCard,
    colPropId: BasesPropertyId
  ): void {
    const cardEl = columnEl.createEl("div", { cls: "fmo-kanban-card" });
    cardEl.draggable = true;
    cardEl.dataset.filePath = card.entry.file.path;

    // Title
    const titleEl = cardEl.createEl("div", { cls: "fmo-kanban-card-title" });
    titleEl.textContent = card.entry.file.basename;
    titleEl.addEventListener("click", (evt) => {
      evt.preventDefault();
      void this.plugin.openFile(card.entry.file.path);
    });

    // Visible properties (exclude the column property itself)
    const visibleProps = this.config.getOrder().filter((p) => p !== colPropId);
    if (visibleProps.length > 0) {
      const propsEl = cardEl.createEl("div", { cls: "fmo-kanban-card-props" });
      for (const propId of visibleProps) {
        const val = card.entry.getValue(propId);
        if (!val || val instanceof NullValue || !val.isTruthy()) continue;
        const propRow = propsEl.createEl("div", { cls: "fmo-kanban-card-prop" });
        const label = this.config.getDisplayName(propId);
        propRow.createEl("span", { cls: "fmo-kanban-card-prop-label", text: `${label}: ` });
        const valSpan = propRow.createEl("span", { cls: "fmo-kanban-card-prop-value" });
        val.renderTo(valSpan, { app: this.app, sourcePath: card.entry.file.path });
      }
    }

    // Drag events
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
    colPropId: BasesPropertyId
  ): void {
    columnEl.addEventListener("dragover", (evt) => {
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
      columnEl.addClass("fmo-kanban-column-dragover");
    });

    columnEl.addEventListener("dragleave", (evt) => {
      // Only remove if leaving the column itself, not entering a child
      const related = evt.relatedTarget as Node | null;
      if (related && columnEl.contains(related)) return;
      columnEl.removeClass("fmo-kanban-column-dragover");
    });

    columnEl.addEventListener("drop", (evt) => {
      evt.preventDefault();
      columnEl.removeClass("fmo-kanban-column-dragover");

      const filePath = evt.dataTransfer?.getData("text/plain");
      if (!filePath) return;

      void this.moveCard(filePath, columnValue, swimlaneValue, colPropId);
    });
  }

  private async moveCard(
    filePath: string,
    newColumnValue: string,
    newSwimlanValue: string,
    colPropId: BasesPropertyId
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const colPropName = colPropId.split(".").slice(1).join(".");
    const swimPropId = this.getSwimlanPropertyId();
    const swimPropName = swimPropId ? swimPropId.split(".").slice(1).join(".") : null;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      // Update column property
      if (newColumnValue === UNCATEGORIZED) {
        delete fm[colPropName];
      } else {
        fm[colPropName] = newColumnValue;
      }

      // Update swimlane property if applicable
      if (swimPropName) {
        if (newSwimlanValue === UNCATEGORIZED) {
          delete fm[swimPropName];
        } else {
          fm[swimPropName] = newSwimlanValue;
        }
      }
    });
  }
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

**Step 3: Commit**

```bash
git add src/ui/bases/kanban-bases-view.ts
git commit -m "feat(kanban): create KanbanBasesView extending Obsidian BasesView"
```

---

### Task 3: Register the Bases view in the plugin

**Files:**
- Modify: `src/plugin.ts`

**Step 1: Add the import and registration**

At the top of `src/plugin.ts`, add import:

```typescript
import { createKanbanViewRegistration, KANBAN_BASES_VIEW_ID } from "./ui/bases/kanban-bases-view";
```

In the `onload()` method, after the existing `registerView` calls (after line ~113 `this.registerExtensions(["beancount"], ...)`), add:

```typescript
this.registerBasesView(KANBAN_BASES_VIEW_ID, createKanbanViewRegistration(this));
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

**Step 3: Commit**

```bash
git add src/plugin.ts
git commit -m "feat(kanban): register kanban Bases view in plugin onload"
```

---

### Task 4: Add CSS for the kanban board

**Files:**
- Modify: `styles.css`

**Step 1: Add kanban styles**

Append the following to the end of `styles.css`:

```css
/* ── Kanban Bases View ─────────────────────────────────── */

.fmo-kanban-board {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 13px;
}

.fmo-kanban-empty {
  padding: 24px;
  color: var(--text-muted);
  text-align: center;
}

/* Header row (column headers) */
.fmo-kanban-header-row {
  display: flex;
  flex-shrink: 0;
  gap: 0;
  border-bottom: 1px solid var(--background-modifier-border);
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--background-primary);
}

.fmo-kanban-swimlane-header-spacer {
  flex: 0 0 120px;
  min-width: 120px;
}

.fmo-kanban-column-header {
  flex: 1 1 0;
  min-width: 180px;
  padding: 8px 12px;
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  border-right: 1px solid var(--background-modifier-border);
  display: flex;
  align-items: center;
  gap: 6px;
}

.fmo-kanban-column-header:last-child {
  border-right: none;
}

/* Body (scrollable) */
.fmo-kanban-body {
  flex: 1 1 0;
  overflow: auto;
}

/* Swimlane */
.fmo-kanban-swimlane {
  border-bottom: 1px solid var(--background-modifier-border);
}

.fmo-kanban-swimlane:last-child {
  border-bottom: none;
}

.fmo-kanban-swimlane-header {
  position: sticky;
  left: 0;
  padding: 6px 12px;
  background: var(--background-secondary);
  font-weight: 600;
  font-size: 12px;
  color: var(--text-normal);
  border-bottom: 1px solid var(--background-modifier-border);
}

.fmo-kanban-swimlane-columns {
  display: flex;
  gap: 0;
  min-height: 80px;
}

/* Column (drop zone) */
.fmo-kanban-column {
  flex: 1 1 0;
  min-width: 180px;
  min-height: 80px;
  padding: 6px;
  border-right: 1px solid var(--background-modifier-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background 0.15s ease;
}

.fmo-kanban-column:last-child {
  border-right: none;
}

.fmo-kanban-column-dragover {
  background: var(--background-modifier-hover);
}

/* Card */
.fmo-kanban-card {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: grab;
  transition: box-shadow 0.15s ease, opacity 0.15s ease;
}

.fmo-kanban-card:hover {
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}

.fmo-kanban-card-dragging {
  opacity: 0.4;
  cursor: grabbing;
}

.fmo-kanban-card-title {
  font-weight: 500;
  font-size: 13px;
  color: var(--text-normal);
  cursor: pointer;
  word-break: break-word;
}

.fmo-kanban-card-title:hover {
  color: var(--text-accent);
  text-decoration: underline;
}

.fmo-kanban-card-props {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fmo-kanban-card-prop {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.3;
}

.fmo-kanban-card-prop-label {
  font-weight: 500;
}

.fmo-kanban-card-prop-value {
  color: var(--text-normal);
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

**Step 3: Commit**

```bash
git add styles.css
git commit -m "feat(kanban): add CSS styles for kanban board layout"
```

---

### Task 5: Manual smoke test

**Step 1: Test in Obsidian**

1. Build and reload: `npm run build`, then reload Obsidian (Ctrl+R / Cmd+R)
2. Create a `.base` file (e.g. `Kanban.base`) with filter for your concern notes:
   ```json
   {
     "filters": "type = \"concen\"",
     "views": [{ "type": "life-dashboard-kanban", "name": "Kanban" }]
   }
   ```
   Or use Obsidian's UI: create a new Base, add a filter, then switch to the "Kanban" view in the view selector.
3. Verify:
   - Column headers appear based on distinct `status` values
   - Swimlane rows appear based on distinct `priority` values
   - Cards show note basenames and are clickable (open note)
   - Drag a card to a different column → verify frontmatter `status` is updated
   - Check plugin settings show the two new kanban settings
   - Toggle "Show swimlanes" off → swimlane headers disappear, all cards in flat columns

**Step 2: Commit any fixes if needed**

---

### Task 6: Update manifest description

**Files:**
- Modify: `manifest.json`

**Step 1: Update description to mention six views**

Change the `description` field from:

```
"Track time on hierarchical task notes and visualise data across five views: timer, outline, canvas, calendar, and time log."
```

to:

```
"Track time on hierarchical task notes and visualise data across six views: timer, outline, canvas, calendar, time log, and kanban board."
```

**Step 2: Commit**

```bash
git add manifest.json
git commit -m "docs: update manifest description to include kanban view"
```
