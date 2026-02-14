# Shared ConcernTreePanel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the Canvas view's per-card tree panel (controls + tree preview) into a reusable `ConcernTreePanel` class, then use it in both Canvas and Calendar views, with the Calendar view getting a left sidebar tree panel that filters the calendar grid.

**Architecture:** A new `ConcernTreePanel` class encapsulates controls rendering, tree data computation, and tree node rendering. Both Canvas and Calendar views create instances of this class, passing a config that controls which UI elements are visible. The host view reacts to filter changes via an `onChange` callback.

**Tech Stack:** TypeScript, Obsidian API (`SearchComponent`, `setTooltip`), esbuild bundler. No test framework — verify with `npm run check` (tsc) and `npm run build`.

---

### Task 1: Add calendar tree panel persistence to settings

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/plugin.ts`

**Step 1: Add `calendarTreePanelState` to settings interface and defaults**

In `src/settings.ts`, add a new field to `LifeDashboardSettings`:

```typescript
calendarTreePanelState: string;  // JSON-serialized tree panel state
```

Add to `DEFAULT_SETTINGS`:

```typescript
calendarTreePanelState: "",
```

**Step 2: Add getter/setter in plugin.ts**

In `src/plugin.ts`, add methods analogous to `getCanvasDraftState`/`setCanvasDraftState`:

```typescript
getCalendarTreePanelState(): string {
  return this.settings.calendarTreePanelState;
}

setCalendarTreePanelState(state: string): void {
  this.settings.calendarTreePanelState = state;
  void this.saveSettings();
}
```

**Step 3: Verify**

Run: `npm run check`
Expected: No type errors.

**Step 4: Commit**

```bash
git add src/settings.ts src/plugin.ts
git commit -m "feat: add calendarTreePanelState to settings"
```

---

### Task 2: Create ConcernTreePanel class with types and skeleton

**Files:**
- Create: `src/ui/concern-tree-panel.ts`
- Modify: `src/ui/life-dashboard-view.ts` (export shared types)

**Step 1: Move shared types out of life-dashboard-view.ts**

The types `OutlineFilterToken`, `OutlineSortMode`, and the constants `OUTLINE_RANGE_OPTIONS`, `OUTLINE_SORT_OPTIONS`, `MIN_TRACKED_SECONDS_PER_PERIOD` are currently defined at the top of `life-dashboard-view.ts`. Export them so the panel can import them:

In `src/ui/life-dashboard-view.ts`, change these declarations from plain to `export`:

```typescript
export type OutlineFilterToken = ...
export type OutlineSortMode = ...
export const OUTLINE_RANGE_OPTIONS = ...
export const OUTLINE_SORT_OPTIONS = ...
export const MIN_TRACKED_SECONDS_PER_PERIOD = ...
```

**Step 2: Create `src/ui/concern-tree-panel.ts` with types and class skeleton**

```typescript
import { SearchComponent, setTooltip } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../models/types";
import type LifeDashboardPlugin from "../plugin";
import type { OutlineTimeRange } from "../plugin";
import {
  type OutlineFilterToken,
  type OutlineSortMode,
  OUTLINE_RANGE_OPTIONS,
  OUTLINE_SORT_OPTIONS,
  MIN_TRACKED_SECONDS_PER_PERIOD
} from "./life-dashboard-view";

export type ConcernTreePanelState = {
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  collapsedNodePaths: Set<string>;
};

export type ConcernTreePanelConfig = {
  plugin: LifeDashboardPlugin;
  container: HTMLElement;
  state: ConcernTreePanelState;
  hideControls?: {
    root?: boolean;
    range?: boolean;
    sort?: boolean;
    trackedOnly?: boolean;
    showParents?: boolean;
    filter?: boolean;
  };
  onChange: (visiblePaths: Set<string>, state: ConcernTreePanelState) => void;
};

type TreePanelRenderState = {
  cumulativeSeconds: Map<string, number>;
  ownSeconds: Map<string, number>;
  matchedPaths: Set<string>;
};

type TaskTreeData = {
  roots: TaskTreeNode[];
  cumulativeSeconds: Map<string, number>;
  ownSeconds: Map<string, number>;
  nodesByPath: Map<string, TaskTreeNode>;
};

type TaskTreeBuildOptions = {
  ownSecondsForPath?: (path: string) => number;
  sortMode?: OutlineSortMode;
  latestTrackedStartForPath?: (path: string) => number;
};

export class ConcernTreePanel {
  private readonly plugin: LifeDashboardPlugin;
  private readonly container: HTMLElement;
  private readonly hideControls: Required<NonNullable<ConcernTreePanelConfig["hideControls"]>>;
  private readonly onChangeCallback: ConcernTreePanelConfig["onChange"];
  private state: ConcernTreePanelState;
  private visiblePaths = new Set<string>();

  constructor(config: ConcernTreePanelConfig) {
    this.plugin = config.plugin;
    this.container = config.container;
    this.state = { ...config.state, collapsedNodePaths: new Set(config.state.collapsedNodePaths) };
    this.hideControls = {
      root: config.hideControls?.root ?? false,
      range: config.hideControls?.range ?? false,
      sort: config.hideControls?.sort ?? false,
      trackedOnly: config.hideControls?.trackedOnly ?? false,
      showParents: config.hideControls?.showParents ?? false,
      filter: config.hideControls?.filter ?? false,
    };
    this.onChangeCallback = config.onChange;
    this.render();
  }

  getVisiblePaths(): Set<string> {
    return new Set(this.visiblePaths);
  }

  getState(): ConcernTreePanelState {
    return { ...this.state, collapsedNodePaths: new Set(this.state.collapsedNodePaths) };
  }

  setState(partial: Partial<ConcernTreePanelState>): void {
    if (partial.rootPath !== undefined) this.state.rootPath = partial.rootPath;
    if (partial.query !== undefined) this.state.query = partial.query;
    if (partial.sortMode !== undefined) this.state.sortMode = partial.sortMode;
    if (partial.range !== undefined) this.state.range = partial.range;
    if (partial.trackedOnly !== undefined) this.state.trackedOnly = partial.trackedOnly;
    if (partial.showParents !== undefined) this.state.showParents = partial.showParents;
    if (partial.collapsedNodePaths !== undefined) this.state.collapsedNodePaths = new Set(partial.collapsedNodePaths);
    this.render();
  }

  render(): void {
    // Will be implemented in Task 3
  }
}
```

**Step 3: Verify**

Run: `npm run check`
Expected: No type errors.

**Step 4: Commit**

```bash
git add src/ui/concern-tree-panel.ts src/ui/life-dashboard-view.ts
git commit -m "feat: create ConcernTreePanel skeleton with types"
```

---

### Task 3: Implement ConcernTreePanel controls and tree rendering

**Files:**
- Modify: `src/ui/concern-tree-panel.ts`

This is the core task. Move the tree data methods and rendering logic from the Canvas view into the panel class.

**Step 1: Add tree data computation methods**

These methods are currently on `LifeDashboardConcernCanvasView` prefixed with `canvas`. Move them to `ConcernTreePanel`, removing the `Canvas` prefix. The methods to port:

- `getCanvasOwnSecondsByPath` → `getOwnSecondsByPath`
- `buildCanvasParentPathMap` → `buildParentPathMap`
- `collectCanvasScopePaths` → `collectScopePaths`
- `collectCanvasPathsWithParents` → `collectPathsWithParents`
- `selectCanvasRoots` → `selectRoots`
- `collectCanvasBranchPaths` → `collectBranchPaths`
- `filterTasksForCanvas` → `filterTasks`
- `createCanvasLatestTrackedStartResolver` → `createLatestTrackedStartResolver`

These methods also need `buildTaskTree` (currently on `LifeDashboardBaseView`). Since we don't want to duplicate it, the panel must either:
- Receive a `buildTaskTree` function via config, or
- Duplicate the tree-building algorithm

**Decision:** Add a `buildTaskTree` method to the panel that duplicates the logic from the base view. The base view's version (~70 lines) is self-contained and the panel needs to be independent. The base view's `resolveParentPath` uses `this.app.metadataCache.getFirstLinkpathDest` which can be accessed via `this.plugin.app.metadataCache`.

Also port `resolveParentPath`, `extractParentCandidates` from the base view (they're needed by `buildParentPathMap`).

Also port `parseFilterTokens` and `taskMatchesFilter` for filtering (used by `filterTasks`). These are on the base view.

Also port the node sorting helpers: `computeSubtreeLatestStartMs`, `compareNodes`, `readPriorityValue`, `comparePriorityValues`, `getPriorityRank`.

**Step 2: Implement `render()` method**

The `render()` method should:
1. Empty the container
2. Render controls section (respecting `hideControls`)
3. Render tree preview (the tree list with expand/collapse)
4. Compute `visiblePaths` and call `onChange`

Port `renderCanvasTreeCard`'s controls section (lines 1661-1758 of `life-dashboard-view.ts`) — the part after the card header chrome and before `renderPreview()`. Skip the card chrome (drag handle, title, collapse/remove buttons).

Port `renderCanvasTreePreview` (lines 1761-1881) → becomes the tree preview section of `render()`.

Port `renderCanvasTreeNode` (lines 2093-2177) → becomes `renderTreeNode`.

The controls rendering structure:
```
controls container (.fmo-tree-panel-controls)
  ├── Root selector row      (if !hideControls.root)
  ├── Options grid           (range if !hideControls.range, sort if !hideControls.sort)
  ├── Flags row              (trackedOnly if !hideControls.trackedOnly, showParents if !hideControls.showParents)
  └── Filter row             (if !hideControls.filter)
preview container (.fmo-tree-panel-preview)
  ├── Top bar (expand all / collapse all + meta)
  └── Tree list (.fmo-tree .fmo-tree-panel-tree)
```

Each control change updates `this.state`, calls `this.renderTree()` (re-render just the preview), and fires `onChange`.

**Step 3: Verify**

Run: `npm run check`
Expected: No type errors.

**Step 4: Commit**

```bash
git add src/ui/concern-tree-panel.ts
git commit -m "feat: implement ConcernTreePanel controls and tree rendering"
```

---

### Task 4: Add shared tree panel CSS classes

**Files:**
- Modify: `styles.css`

**Step 1: Add `.fmo-tree-panel-*` classes**

Add new CSS classes for the shared tree panel. These mirror the existing `.fmo-canvas-controls`, `.fmo-canvas-preview`, `.fmo-canvas-tree`, etc., but with the `.fmo-tree-panel-` prefix. The canvas card chrome classes (`.fmo-canvas-card`, `.fmo-canvas-card-header`, `.fmo-canvas-drag-handle`, etc.) stay as-is.

New classes to add (at the end of the file, before the Calendar section):

```css
/* ── Shared Tree Panel ────────────────────────────────────── */

.frontmatter-outline-view .fmo-tree-panel-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--background-modifier-border);
  background: color-mix(in srgb, var(--background-primary) 88%, var(--background-secondary) 12%);
}

.frontmatter-outline-view .fmo-tree-panel-root-row {
  display: grid;
  grid-template-columns: 52px 1fr;
  align-items: center;
  gap: 8px;
}

.frontmatter-outline-view .fmo-tree-panel-options-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.frontmatter-outline-view .fmo-tree-panel-option {
  display: grid;
  grid-template-columns: 52px 1fr;
  align-items: center;
  gap: 8px;
}

.frontmatter-outline-view .fmo-tree-panel-control-label {
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.frontmatter-outline-view .fmo-tree-panel-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.frontmatter-outline-view .fmo-tree-panel-filter .search-input-container {
  width: 100%;
}

.frontmatter-outline-view .fmo-tree-panel-preview {
  padding: 8px;
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
}

.frontmatter-outline-view .fmo-tree-panel-preview-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.frontmatter-outline-view .fmo-tree-panel-preview-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.frontmatter-outline-view .fmo-tree-panel-preview-btn {
  border: 1px solid var(--background-modifier-border);
  border-radius: 999px;
  background: var(--interactive-normal);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
}

.frontmatter-outline-view .fmo-tree-panel-preview-btn:hover:not(:disabled) {
  background: var(--interactive-hover);
  color: var(--text-normal);
}

.frontmatter-outline-view .fmo-tree-panel-preview-btn:disabled {
  opacity: 0.5;
}

.frontmatter-outline-view .fmo-tree-panel-preview-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.frontmatter-outline-view .fmo-tree-panel-tree {
  padding-left: 0;
}

.frontmatter-outline-view .fmo-tree-panel-tree-item {
  margin: 3px 0;
}

.frontmatter-outline-view .fmo-tree-panel-tree-row {
  gap: 6px;
}

.frontmatter-outline-view .fmo-tree-panel-node-marker {
  color: var(--text-muted);
  width: 14px;
  min-width: 14px;
  text-align: center;
  font-size: 10px;
}

.frontmatter-outline-view .fmo-tree-panel-node-toggle {
  width: 14px;
  min-width: 14px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 0;
  line-height: 1;
  cursor: pointer;
  font-size: 11px;
}

.frontmatter-outline-view .fmo-tree-panel-node-toggle:hover {
  color: var(--text-normal);
}

.frontmatter-outline-view .fmo-tree-panel-tree-children {
  margin-left: 6px;
  border-left: none;
}

.frontmatter-outline-view .fmo-tree-panel-truncated {
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 11px;
  font-style: italic;
}
```

**Step 2: Add calendar sidebar layout classes**

```css
/* ── Calendar: Layout ─────────────────────────────────────── */

.frontmatter-outline-view .fmo-calendar-layout {
  display: flex;
  gap: 0;
  min-height: 0;
  flex: 1;
}

.frontmatter-outline-view .fmo-calendar-sidebar {
  width: 280px;
  min-width: 220px;
  max-width: 340px;
  border-right: 1px solid var(--background-modifier-border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.frontmatter-outline-view .fmo-calendar-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0 8px;
}
```

**Step 3: Verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add styles.css
git commit -m "feat: add shared tree panel and calendar sidebar CSS"
```

---

### Task 5: Refactor Canvas view to use ConcernTreePanel

**Files:**
- Modify: `src/ui/life-dashboard-view.ts`
- Modify: `src/ui/concern-tree-panel.ts` (if adjustments needed)

**Step 1: Import ConcernTreePanel in life-dashboard-view.ts**

```typescript
import { ConcernTreePanel, type ConcernTreePanelState } from "./concern-tree-panel";
```

**Step 2: Refactor `renderCanvasTreeCard`**

Replace the controls + preview rendering section (lines ~1661-1758) with a `ConcernTreePanel` instantiation.

The card chrome (header with drag handle, title, collapse/remove) stays as-is.

After the card chrome, instead of manually building controls and calling `renderCanvasTreePreview`, create a `ConcernTreePanel`:

```typescript
if (tree.collapsed) return;

const panelContainer = card.createEl("div", { cls: "fmo-canvas-card-body" });

const panel = new ConcernTreePanel({
  plugin: this.plugin,
  container: panelContainer,
  state: {
    rootPath: tree.rootPath,
    query: tree.query,
    sortMode: tree.sortMode,
    range: tree.range,
    trackedOnly: tree.trackedOnly,
    showParents: tree.showParents,
    collapsedNodePaths: tree.collapsedNodePaths,
  },
  onChange: (_visiblePaths, newState) => {
    tree.rootPath = newState.rootPath;
    tree.query = newState.query;
    tree.sortMode = newState.sortMode;
    tree.range = newState.range;
    tree.trackedOnly = newState.trackedOnly;
    tree.showParents = newState.showParents;
    tree.collapsedNodePaths = newState.collapsedNodePaths;
    this.persistCanvasTrees();
  },
});
```

**Step 3: Remove canvas tree-specific methods that are now in the panel**

Remove from `LifeDashboardConcernCanvasView`:
- `renderCanvasTreePreview`
- `renderCanvasTreeNode`
- `getCanvasOwnSecondsByPath`
- `createCanvasLatestTrackedStartResolver`
- `buildCanvasParentPathMap`
- `collectCanvasScopePaths`
- `collectCanvasPathsWithParents`
- `selectCanvasRoots`
- `collectCanvasBranchPaths`
- `filterTasksForCanvas`

Keep in `LifeDashboardConcernCanvasView`:
- `ensureCanvasTrees`, `loadPersistedCanvasTrees`, `persistCanvasTrees`
- `createCanvasTreeDraft`, `createInitialCanvasTrees`, serialization/deserialization
- `attachCanvasCardDragging`, `attachCanvasCardResizing`
- `clamp`
- `renderCanvasTreeCard` (refactored to use the panel)
- All the validation/hydration methods

**Step 4: Update CSS class usage**

The canvas card body needs a `.fmo-canvas-card-body` class that allows the panel to fill available space:

```css
.frontmatter-outline-view .fmo-canvas-card-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
```

Add this to `styles.css`.

**Step 5: Verify**

Run: `npm run check && npm run build`
Expected: No errors.

**Step 6: Commit**

```bash
git add src/ui/life-dashboard-view.ts src/ui/concern-tree-panel.ts styles.css
git commit -m "refactor: Canvas view uses ConcernTreePanel"
```

---

### Task 6: Refactor Calendar view to use ConcernTreePanel

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (the `LifeDashboardCalendarView` class)

**Step 1: Add tree panel state management to Calendar view**

Add instance fields for the tree panel state and persistence:

```typescript
private calendarTreePanel: ConcernTreePanel | null = null;
private calendarTreeState: ConcernTreePanelState = {
  rootPath: "",
  query: "",
  sortMode: "recent",
  range: "today",
  trackedOnly: false,
  showParents: true,
  collapsedNodePaths: new Set(),
};
private calendarTreeStateLoaded = false;
```

Add methods to load/persist the tree panel state:

```typescript
private loadTreePanelState(): void {
  if (this.calendarTreeStateLoaded) return;
  this.calendarTreeStateLoaded = true;

  const raw = this.plugin.getCalendarTreePanelState().trim();
  if (!raw) return;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed || typeof parsed !== "object") return;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.rootPath === "string") this.calendarTreeState.rootPath = obj.rootPath;
  if (typeof obj.query === "string") this.calendarTreeState.query = obj.query;
  if (obj.sortMode === "recent" || obj.sortMode === "priority") this.calendarTreeState.sortMode = obj.sortMode;
  if (typeof obj.showParents === "boolean") this.calendarTreeState.showParents = obj.showParents;
  if (Array.isArray(obj.collapsedNodePaths)) {
    this.calendarTreeState.collapsedNodePaths = new Set(
      obj.collapsedNodePaths.filter((p: unknown) => typeof p === "string")
    );
  }
}

private persistTreePanelState(): void {
  const state = {
    rootPath: this.calendarTreeState.rootPath,
    query: this.calendarTreeState.query,
    sortMode: this.calendarTreeState.sortMode,
    showParents: this.calendarTreeState.showParents,
    collapsedNodePaths: [...this.calendarTreeState.collapsedNodePaths],
  };
  this.plugin.setCalendarTreePanelState(JSON.stringify(state));
}
```

**Step 2: Refactor `render()` to use two-column layout with tree panel**

Replace the current `render()` method. The new structure:

```
header (title + Today/Week toggle)
fmo-calendar-layout
  ├── fmo-calendar-sidebar
  │   └── ConcernTreePanel (hideControls: range, trackedOnly)
  └── fmo-calendar-main
      ├── timeline or week grid (filtered by visiblePaths)
      └── summary table (filtered by visiblePaths)
```

Key change: `gatherCalendarEntries()` output is filtered by the tree panel's visible paths before rendering.

The period toggle syncs to the tree panel: when user switches Today/Week, call `panel.setState({ range: newRange })`.

The `onChange` callback:
1. Updates `this.calendarTreeState` with new state
2. Persists state
3. Re-renders the calendar main area with filtered entries

```typescript
async render(): Promise<void> {
  const { contentEl } = this;
  contentEl.empty();
  contentEl.addClass("frontmatter-outline-view");

  this.loadTreePanelState();
  // Sync range from calendar period
  this.calendarTreeState.range = this.period === "today" ? "today" : "week";

  const header = contentEl.createEl("div", { cls: "fmo-header" });
  const headerTop = header.createEl("div", { cls: "fmo-header-top" });
  headerTop.createEl("h3", { text: "Concerns Calendar" });

  const rangeRow = header.createEl("div", { cls: "fmo-outline-range-row" });
  // ... period toggle buttons (same as before, but on change also call panel.setState({ range }))

  const layout = contentEl.createEl("div", { cls: "fmo-calendar-layout" });
  const sidebar = layout.createEl("div", { cls: "fmo-calendar-sidebar" });
  const main = layout.createEl("div", { cls: "fmo-calendar-main" });

  const renderCalendarMain = (visiblePaths: Set<string> | null): void => {
    main.empty();
    const allEntries = this.gatherCalendarEntries();
    const entries = visiblePaths
      ? allEntries.filter((e) => visiblePaths.has(e.path))
      : allEntries;

    if (entries.length === 0) {
      main.createEl("p", { cls: "fmo-empty", text: "No tracked time in this period." });
      return;
    }

    const colorMap = this.buildColorMap(entries);
    if (this.period === "today") {
      this.renderDayTimeline(main, entries, colorMap);
    } else {
      this.renderWeekGrid(main, entries, colorMap);
    }
    this.renderSummaryTable(main, entries, colorMap);
  };

  this.calendarTreePanel = new ConcernTreePanel({
    plugin: this.plugin,
    container: sidebar,
    state: this.calendarTreeState,
    hideControls: { range: true, trackedOnly: true },
    onChange: (visiblePaths, newState) => {
      this.calendarTreeState = newState;
      this.persistTreePanelState();
      renderCalendarMain(visiblePaths);
    },
  });

  renderCalendarMain(this.calendarTreePanel.getVisiblePaths());
}
```

**Step 3: Verify**

Run: `npm run check && npm run build`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/ui/life-dashboard-view.ts
git commit -m "feat: Calendar view uses ConcernTreePanel in sidebar"
```

---

### Task 7: Remove old canvas tree CSS classes (cleanup)

**Files:**
- Modify: `styles.css`
- Modify: `src/ui/life-dashboard-view.ts` (if any old classes still referenced)

**Step 1: Audit which `.fmo-canvas-*` classes are still used**

After Task 5, the canvas card chrome still uses: `.fmo-canvas-view`, `.fmo-canvas-toolbar`, `.fmo-canvas-toolbar-meta`, `.fmo-canvas-viewport`, `.fmo-canvas-stage`, `.fmo-canvas-card`, `.fmo-canvas-card-collapsed`, `.fmo-canvas-card-header`, `.fmo-canvas-drag-handle`, `.fmo-canvas-title`, `.fmo-canvas-card-actions`, `.fmo-canvas-card-btn`, `.fmo-canvas-resize-handle`, `.fmo-canvas-card-body`.

The following `.fmo-canvas-*` classes should no longer be referenced (replaced by `.fmo-tree-panel-*`): `.fmo-canvas-controls`, `.fmo-canvas-root-row`, `.fmo-canvas-options-grid`, `.fmo-canvas-option`, `.fmo-canvas-control-label`, `.fmo-canvas-flags`, `.fmo-canvas-filter`, `.fmo-canvas-preview`, `.fmo-canvas-preview-top`, `.fmo-canvas-preview-actions`, `.fmo-canvas-preview-btn`, `.fmo-canvas-preview-meta`, `.fmo-canvas-tree`, `.fmo-canvas-tree-item`, `.fmo-canvas-tree-row`, `.fmo-canvas-node-marker`, `.fmo-canvas-node-toggle`, `.fmo-canvas-tree-children`, `.fmo-canvas-truncated`.

**Step 2: Remove unused `.fmo-canvas-*` rules from `styles.css`**

Delete the CSS rules for the classes listed above (lines ~595-758 of current styles.css, approximately). Keep all canvas card chrome classes.

**Step 3: Verify**

Run: `npm run build`
Expected: Build succeeds. Grep the codebase for any remaining references to removed class names.

**Step 4: Commit**

```bash
git add styles.css src/ui/life-dashboard-view.ts
git commit -m "cleanup: remove old canvas tree CSS classes replaced by tree panel"
```

---

### Task 8: Final verification and build

**Files:** None (verification only)

**Step 1: Type check**

Run: `npm run check`
Expected: No errors.

**Step 2: Build**

Run: `npm run build`
Expected: Clean build with no warnings.

**Step 3: Grep for stale references**

Search for any remaining references to removed canvas methods or old CSS classes:

```bash
grep -rn "renderCanvasTreePreview\|renderCanvasTreeNode\|getCanvasOwnSeconds\|filterTasksForCanvas\|collectCanvasBranchPaths\|selectCanvasRoots\|collectCanvasPathsWithParents\|collectCanvasScopePaths\|buildCanvasParentPathMap\|createCanvasLatestTrackedStart" src/
grep -rn "fmo-canvas-controls\|fmo-canvas-root-row\|fmo-canvas-options-grid\|fmo-canvas-preview\b\|fmo-canvas-tree\b\|fmo-canvas-node-" src/ styles.css
```

Expected: No matches.

**Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: clean up stale references"
```
