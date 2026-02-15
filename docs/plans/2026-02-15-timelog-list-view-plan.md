# Time Log List View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a flat list view of all time-tracked.json entries with inline editing, sorted newest-first, showing concern names.

**Architecture:** New `LifeDashboardTimeLogView` class in `life-dashboard-view.ts` following the same pattern as other views. Expose a public `writeTimeLogMap()` on `TimeLogStore` so the view can save edits. Add a `saveTimeLog()` bridge method on the plugin. The view builds a reverse UUID-to-basename map from `getTaskTreeItems()` frontmatter.

**Tech Stack:** Obsidian API (ItemView), TypeScript, existing TimeLogStore validation.

---

### Task 1: Add public writeTimeLogMap to TimeLogStore

**Files:**
- Modify: `src/services/time-log-store.ts:165-169`

**Step 1: Add public method**

Add after the existing `readTimeLogMap()` method (after line 33):

```typescript
async writeTimeLogMap(data: TimeLogByNoteId): Promise<void> {
  const normalized = this.normalizeAndValidateTimeLogMap(data);
  await this.writeTimeLog(normalized);
}
```

**Step 2: Commit**

```bash
git add src/services/time-log-store.ts
git commit -m "feat: expose writeTimeLogMap on TimeLogStore"
```

---

### Task 2: Add saveTimeLog bridge and UUID reverse map on plugin

**Files:**
- Modify: `src/plugin.ts`

**Step 1: Add saveTimeLog method**

Add after `reloadTimeTotals()` (after line 321):

```typescript
async readTimeLog(): Promise<Record<string, string[]>> {
  return this.timeLogStore.readTimeLogMap();
}

async saveTimeLog(data: Record<string, string[]>): Promise<void> {
  await this.timeLogStore.writeTimeLogMap(data);
  await this.reloadTimeTotals();
  this.refreshView();
}

buildNoteIdToBasenameMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const task of this.getTaskTreeItems()) {
    const cache = this.app.metadataCache.getFileCache(task.file);
    const id = cache?.frontmatter?.id;
    if (id) map.set(String(id).trim(), task.file.basename);
  }
  return map;
}
```

**Step 2: Commit**

```bash
git add src/plugin.ts
git commit -m "feat: add saveTimeLog and buildNoteIdToBasenameMap to plugin"
```

---

### Task 3: Register the new view

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (add constant)
- Modify: `src/plugin.ts` (register view, add command)
- Modify: `src/services/dashboard-view-controller.ts` (add to ALL_VIEW_TYPES, add activateTimeLogView)

**Step 1: Add view type constant**

In `src/ui/life-dashboard-view.ts`, after line 20 add:

```typescript
export const VIEW_TYPE_LIFE_DASHBOARD_TIMELOG = "life-dashboard-timelog-view";
```

**Step 2: Add empty view class stub**

At the end of `src/ui/life-dashboard-view.ts` (before the closing), add:

```typescript
export class LifeDashboardTimeLogView extends LifeDashboardBaseView {
  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_TIMELOG;
  }

  getDisplayText(): string {
    return "Time Log";
  }

  getIcon(): string {
    return "list";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Time Log (loading...)" });
  }
}
```

**Step 3: Register in plugin.ts**

In `src/plugin.ts`, add import of `LifeDashboardTimeLogView` and `VIEW_TYPE_LIFE_DASHBOARD_TIMELOG` to the existing import block (line 13-21).

Add after line 80:

```typescript
this.registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMELOG, (leaf) => new LifeDashboardTimeLogView(leaf, this));
```

Add command after the "open-calendar" command block (after line 124):

```typescript
this.addCommand({
  id: "open-time-log",
  name: "Open Time Log",
  callback: () => {
    void this.viewController.activateTimeLogView();
  }
});
```

**Step 4: Update DashboardViewController**

In `src/services/dashboard-view-controller.ts`:

Add `VIEW_TYPE_LIFE_DASHBOARD_TIMELOG` to the import (line 4) and add to `LifeDashboardTimeLogView` import.

Add to `ALL_VIEW_TYPES` array (line 78):

```typescript
VIEW_TYPE_LIFE_DASHBOARD_TIMELOG
```

Add method:

```typescript
async activateTimeLogView(): Promise<void> {
  await this.openAndRevealView(VIEW_TYPE_LIFE_DASHBOARD_TIMELOG, "tab");
}
```

**Step 5: Commit**

```bash
git add src/ui/life-dashboard-view.ts src/plugin.ts src/services/dashboard-view-controller.ts
git commit -m "feat: register time log view stub with command"
```

---

### Task 4: Implement the time log list view render

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (LifeDashboardTimeLogView.render)

**Step 1: Implement full render method**

Replace the stub `render()` with:

```typescript
async render(): Promise<void> {
  const { contentEl } = this;
  contentEl.empty();
  contentEl.addClass("frontmatter-outline-view");

  const header = contentEl.createEl("div", { cls: "fmo-header" });
  const headerTop = header.createEl("div", { cls: "fmo-header-top" });
  headerTop.createEl("h3", { text: "Time Log" });

  const nameMap = this.plugin.buildNoteIdToBasenameMap();

  let data: Record<string, string[]>;
  try {
    data = await this.plugin.readTimeLog();
  } catch (err) {
    contentEl.createEl("p", { cls: "fmo-empty", text: "Failed to load time log." });
    return;
  }

  // Flatten into a list of { noteId, token, startMs }
  type FlatEntry = { noteId: string; token: string; startMs: number; durationMinutes: number };
  const entries: FlatEntry[] = [];
  const tokenRegex = /^(\d{4}\.\d{2}\.\d{2}-\d{2}:\d{2})T(?:(?:P)?T)?(\d+)M$/;

  for (const [noteId, tokens] of Object.entries(data)) {
    for (const token of tokens) {
      const m = tokenRegex.exec(token.trim());
      if (!m) continue;
      const startStr = m[1];
      const durationMinutes = Number(m[2]);
      const parts = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2}):(\d{2})$/.exec(startStr);
      if (!parts) continue;
      const startMs = new Date(
        Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]),
        Number(parts[4]), Number(parts[5])
      ).getTime();
      entries.push({ noteId, token, startMs, durationMinutes });
    }
  }

  // Sort newest first
  entries.sort((a, b) => b.startMs - a.startMs);

  if (entries.length === 0) {
    contentEl.createEl("p", { cls: "fmo-empty", text: "No time entries." });
    return;
  }

  const list = contentEl.createEl("div", { cls: "fmo-timelog-list" });

  for (const entry of entries) {
    const row = list.createEl("div", { cls: "fmo-timelog-row" });

    // Concern name
    const name = nameMap.get(entry.noteId) ?? "unknown";
    row.createEl("span", { cls: "fmo-timelog-name", text: name });

    // Start time (editable)
    const startStr = entry.token.replace(/T(?:(?:P)?T)?\d+M$/, "");
    const startEl = row.createEl("span", { cls: "fmo-timelog-start", text: startStr });
    startEl.setAttribute("tabindex", "0");
    startEl.addEventListener("click", () => {
      this.makeEditable(startEl, startStr, (newVal) => {
        this.updateEntry(data, entry.noteId, entry.token, newVal, entry.durationMinutes);
      });
    });

    // Duration (editable)
    const durText = `${entry.durationMinutes}m`;
    const durEl = row.createEl("span", { cls: "fmo-timelog-duration", text: durText });
    durEl.setAttribute("tabindex", "0");
    durEl.addEventListener("click", () => {
      this.makeEditable(durEl, String(entry.durationMinutes), (newVal) => {
        const newDur = parseInt(newVal, 10);
        if (!Number.isFinite(newDur) || newDur <= 0) {
          new (await import("obsidian")).Notice("Duration must be a positive number of minutes.");
          void this.render();
          return;
        }
        this.updateEntry(data, entry.noteId, entry.token, startStr, newDur);
      });
    });

    // Delete button
    const delBtn = row.createEl("button", { cls: "fmo-timelog-delete", text: "\u00d7" });
    delBtn.setAttribute("aria-label", "Delete entry");
    delBtn.addEventListener("click", () => {
      this.deleteEntry(data, entry.noteId, entry.token);
    });

    // UUID (small, last)
    row.createEl("span", { cls: "fmo-timelog-id", text: entry.noteId });
  }
}

private makeEditable(el: HTMLElement, currentValue: string, onSave: (newVal: string) => void): void {
  const input = document.createElement("input");
  input.type = "text";
  input.value = currentValue;
  input.className = "fmo-timelog-input";
  el.empty();
  el.appendChild(input);
  input.focus();
  input.select();

  const commit = (): void => {
    const val = input.value.trim();
    if (val && val !== currentValue) {
      onSave(val);
    } else {
      void this.render();
    }
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); void this.render(); }
  });
}

private updateEntry(
  data: Record<string, string[]>,
  noteId: string,
  oldToken: string,
  newStart: string,
  newDuration: number
): void {
  const newToken = `${newStart}T${newDuration}M`;
  const tokens = data[noteId] ?? [];
  const idx = tokens.indexOf(oldToken);
  if (idx >= 0) {
    tokens[idx] = newToken;
  }
  data[noteId] = tokens;
  void this.plugin.saveTimeLog(data).then(() => void this.render());
}

private deleteEntry(
  data: Record<string, string[]>,
  noteId: string,
  token: string
): void {
  const tokens = data[noteId] ?? [];
  data[noteId] = tokens.filter((t) => t !== token);
  if (data[noteId].length === 0) delete data[noteId];
  void this.plugin.saveTimeLog(data).then(() => void this.render());
}
```

**Step 2: Commit**

```bash
git add src/ui/life-dashboard-view.ts
git commit -m "feat: implement time log list view with inline editing"
```

---

### Task 5: Add CSS styles

**Files:**
- Modify: `styles.css`

**Step 1: Add timelog styles**

Append to `styles.css`:

```css
/* Time Log View */
.fmo-timelog-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
}

.fmo-timelog-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
}

.fmo-timelog-row:hover {
  background: var(--background-modifier-hover);
}

.fmo-timelog-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.fmo-timelog-start,
.fmo-timelog-duration {
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: var(--font-monospace);
  font-size: 12px;
  white-space: nowrap;
}

.fmo-timelog-start:hover,
.fmo-timelog-duration:hover {
  background: var(--background-modifier-hover);
  outline: 1px solid var(--background-modifier-border);
}

.fmo-timelog-input {
  width: 140px;
  font-family: var(--font-monospace);
  font-size: 12px;
  padding: 2px 4px;
  border: 1px solid var(--interactive-accent);
  border-radius: 3px;
  background: var(--background-primary);
  color: var(--text-normal);
}

.fmo-timelog-duration .fmo-timelog-input {
  width: 50px;
}

.fmo-timelog-delete {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 16px;
  padding: 0 4px;
  line-height: 1;
  border-radius: 3px;
}

.fmo-timelog-delete:hover {
  color: var(--text-error);
  background: var(--background-modifier-hover);
}

.fmo-timelog-id {
  color: var(--text-faint);
  font-size: 10px;
  font-family: var(--font-monospace);
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

**Step 2: Commit**

```bash
git add styles.css
git commit -m "feat: add time log view styles"
```
