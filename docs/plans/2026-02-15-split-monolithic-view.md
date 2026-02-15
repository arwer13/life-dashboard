# Split Monolithic View File — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the 2,427-line `src/ui/life-dashboard-view.ts` into focused modules, extract duplicated computation into shared services, and eliminate ~320 lines of copy-pasted code in `concern-tree-panel.ts`.

**Architecture:** Extract pure computation (tree building, filtering, priority sorting) into standalone service functions. Split each view class into its own file under `src/ui/views/`. Update `concern-tree-panel.ts` to use shared services instead of its local copies. Add a re-export barrel so existing consumers need minimal import changes.

**Tech Stack:** TypeScript, Obsidian API (`obsidian` npm package), esbuild bundler

---

### Task 1: Add shared view types and constants to models

**Files:**
- Create: `src/models/view-types.ts`
- Modify: `src/models/types.ts` (no changes needed — it already has TaskItem, TaskTreeNode, TimeLogEntry)

**Step 1: Create the shared types file**

Create `src/models/view-types.ts` with all types and constants that are imported by multiple consumers (views, concern-tree-panel, dashboard-view-controller):

- Types: `TaskTreeData`, `TaskTreeBuildOptions`, `OutlineFilterToken`, `OutlineSortMode`, `TreeRenderState`
- Constants: `VIEW_TYPE_*` (5 constants), `OUTLINE_RANGE_OPTIONS`, `OUTLINE_SORT_OPTIONS`, `MIN_TRACKED_SECONDS_PER_PERIOD`
- Import `OutlineTimeRange` from `../plugin` (type-only), `TaskTreeNode` and `TaskItem` from `./types`

Note: `RecencySection` stays in outline-view (only used there). `CanvasTreeDraft`, `PersistedCanvasTreeDraft`, `PersistedCanvasDraftState` stay in canvas-view (only used there). `CalendarPeriod`, `CalendarEntry`, `HourRange` stay in calendar-view.

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (new file has no consumers yet, just needs to compile on its own)

---

### Task 2: Extract task-tree-builder service

**Files:**
- Create: `src/services/task-tree-builder.ts`

**Step 1: Create task-tree-builder.ts**

Extract these functions as standalone exports (converting from class methods to functions):

```typescript
import type { MetadataCache } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../models/types";
import type { TaskTreeData, TaskTreeBuildOptions, OutlineSortMode } from "../models/view-types";

export function buildTaskTree(
  tasks: TaskItem[],
  resolveParentPath: (parentRaw: unknown, sourcePath: string) => string | null,
  options: TaskTreeBuildOptions = {}
): TaskTreeData

export function resolveParentPath(
  parentRaw: unknown,
  sourcePath: string,
  metadataCache: MetadataCache
): string | null

// Internal helpers (not exported):
// - extractParentCandidates(value: unknown): string[]
// - computeSubtreeLatestStartMs(...)
// - compareNodes(...)
// - readPriorityValue(...)
// - comparePriorityValues(...)
// - getPriorityRank(...)
```

Key change: `buildTaskTree` takes `resolveParentPath` as a parameter (function injection) instead of calling `this.app.metadataCache` directly. Each call site creates its bound resolver via the exported `resolveParentPath` helper.

The functions are character-for-character identical in logic to the existing code in both `life-dashboard-view.ts:116-327` and `concern-tree-panel.ts:608-813`. The only change is converting `this.method()` calls to direct function calls.

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 3: Extract outline-filter service

**Files:**
- Create: `src/services/outline-filter.ts`

**Step 1: Create outline-filter.ts**

Extract filter functions as standalone exports:

```typescript
import { prepareSimpleSearch } from "obsidian";
import type { TaskItem } from "../models/types";
import type { OutlineFilterToken } from "../models/view-types";

export function parseFilterTokens(query: string): OutlineFilterToken[]
export function filterTasksByQuery(tasks: TaskItem[], query: string): TaskItem[]
export function matchesFrontmatterFilter(
  frontmatter: TaskItem["frontmatter"],
  key: string,
  expectedValue: string | null
): boolean
export function flattenFrontmatterValues(value: unknown): string[]
```

Internal: `taskMatchesFilter(task, tokens)` (used only by `filterTasksByQuery`).

Logic is identical to `life-dashboard-view.ts:329-438` and `concern-tree-panel.ts:815-930`.

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 4: Create base-view.ts

**Files:**
- Create: `src/ui/views/base-view.ts`

**Step 1: Create the thin base view**

```typescript
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type LifeDashboardPlugin from "../../plugin";
import { buildTaskTree, resolveParentPath } from "../../services/task-tree-builder";
import { filterTasksByQuery, parseFilterTokens, matchesFrontmatterFilter, flattenFrontmatterValues } from "../../services/outline-filter";
import type { TaskItem } from "../../models/types";
import type { TaskTreeData, TaskTreeBuildOptions } from "../../models/view-types";

export abstract class LifeDashboardBaseView extends ItemView {
  protected readonly plugin: LifeDashboardPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  protected buildTaskTree(tasks: TaskItem[], options: TaskTreeBuildOptions = {}): TaskTreeData {
    return buildTaskTree(
      tasks,
      (parentRaw, sourcePath) => resolveParentPath(parentRaw, sourcePath, this.app.metadataCache),
      options
    );
  }

  protected filterTasksByQuery(tasks: TaskItem[], query: string): TaskItem[] {
    return filterTasksByQuery(tasks, query);
  }

  protected parseFilterTokens(query: string) {
    return parseFilterTokens(query);
  }

  protected matchesFrontmatterFilter(
    frontmatter: TaskItem["frontmatter"],
    key: string,
    expectedValue: string | null
  ): boolean {
    return matchesFrontmatterFilter(frontmatter, key, expectedValue);
  }

  protected flattenFrontmatterValues(value: unknown): string[] {
    return flattenFrontmatterValues(value);
  }

  protected resolveParentPath(parentRaw: unknown, sourcePath: string): string | null {
    return resolveParentPath(parentRaw, sourcePath, this.app.metadataCache);
  }
}
```

The base view becomes a thin delegation layer. Each view continues calling `this.buildTaskTree(...)` etc. unchanged.

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 5: Split timer-view.ts

**Files:**
- Create: `src/ui/views/timer-view.ts`

**Step 1: Move LifeDashboardTimerView**

Move lines 441-749 from `life-dashboard-view.ts` into `src/ui/views/timer-view.ts`.

Imports needed:
```typescript
import { TFile, setTooltip, type WorkspaceLeaf } from "obsidian";
import type { TaskItem, TaskTreeNode } from "../../models/types";
import { VIEW_TYPE_LIFE_DASHBOARD_TIMER, type TaskTreeData } from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";
import { TaskSelectModal } from "../task-select-modal";
```

Also move the `TRACKING_ADJUST_MINUTES` constant (line 94, used only by timer).

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 6: Split outline-view.ts

**Files:**
- Create: `src/ui/views/outline-view.ts`

**Step 1: Move LifeDashboardOutlineView**

Move lines 751-1263 from `life-dashboard-view.ts` into `src/ui/views/outline-view.ts`.

This view also needs:
- The `RecencySection` type (defined at line 45, used only here)
- Import `Modal`, `SearchComponent`, `setTooltip` from obsidian
- Import `DISPLAY_VERSION`
- Import `OUTLINE_RANGE_OPTIONS`, `OUTLINE_SORT_OPTIONS`, `MIN_TRACKED_SECONDS_PER_PERIOD`, `OutlineSortMode`, `TreeRenderState`, `OutlineTimeRange` from view-types/plugin

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 7: Split canvas-view.ts

**Files:**
- Create: `src/ui/views/canvas-view.ts`

**Step 1: Move LifeDashboardConcernCanvasView**

Move lines 1265-1779 from `life-dashboard-view.ts` into `src/ui/views/canvas-view.ts`.

This view also needs the canvas-specific types and constants (kept private to this file):
- `CanvasTreeDraft`, `PersistedCanvasTreeDraft`, `PersistedCanvasDraftState` types
- `CANVAS_STAGE_WIDTH`, `CANVAS_STAGE_HEIGHT`, `CANVAS_CARD_*`, `CANVAS_DRAFT_VERSION` constants
- Import `ConcernTreePanel` from `../concern-tree-panel`

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 8: Split calendar-view.ts

**Files:**
- Create: `src/ui/views/calendar-view.ts`

**Step 1: Move LifeDashboardCalendarView**

Move lines 1781-2263 from `life-dashboard-view.ts` into `src/ui/views/calendar-view.ts`.

This view also needs its local types and constants:
- `CalendarPeriod`, `CalendarEntry`, `HourRange` types
- `CALENDAR_COLORS`, `BASE_DAY_PX_PER_HOUR`, `BASE_WEEK_PX_PER_HOUR`, `MIN_ZOOM`, `MAX_ZOOM`, `BLOCK_MIN_HEIGHT_PX` constants
- `pad2` helper
- Import `ConcernTreePanel`, `ConcernTreePanelState`

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 9: Split time-log-view.ts

**Files:**
- Create: `src/ui/views/time-log-view.ts`

**Step 1: Move LifeDashboardTimeLogView**

Move lines 2265-2427 from `life-dashboard-view.ts` into `src/ui/views/time-log-view.ts`.

Imports needed:
- `parseIntervalToken` from `../../services/time-log-store`
- `Notice` from obsidian

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 10: Create barrel index and delete old file

**Files:**
- Create: `src/ui/views/index.ts`
- Delete: `src/ui/life-dashboard-view.ts`

**Step 1: Create barrel re-export**

```typescript
export { LifeDashboardTimerView } from "./timer-view";
export { LifeDashboardOutlineView } from "./outline-view";
export { LifeDashboardConcernCanvasView } from "./canvas-view";
export { LifeDashboardCalendarView } from "./calendar-view";
export { LifeDashboardTimeLogView } from "./time-log-view";
```

**Step 2: Delete the old monolithic file**

Remove `src/ui/life-dashboard-view.ts`.

**Step 3: Update consumer imports**

Update these 3 files:

1. `src/plugin.ts` — change import from `"./ui/life-dashboard-view"` to import view classes from `"./ui/views"` and types/constants from `"./models/view-types"`

2. `src/services/dashboard-view-controller.ts` — change import from `"../ui/life-dashboard-view"` to import `LifeDashboardTimerView` from `"../ui/views"` and `VIEW_TYPE_*` from `"../models/view-types"`

3. `src/ui/concern-tree-panel.ts` — change import from `"./life-dashboard-view"` to import types/constants from `"../models/view-types"`

**Step 4: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 11: Update concern-tree-panel.ts to use shared services

**Files:**
- Modify: `src/ui/concern-tree-panel.ts`

**Step 1: Replace duplicated code with service calls**

Remove the entire duplicated section (~320 lines):
- Lines 608-813: `buildTaskTree`, `resolveParentPath`, `extractParentCandidates`, `computeSubtreeLatestStartMs`, `compareNodes`, `readPriorityValue`, `comparePriorityValues`, `getPriorityRank`
- Lines 815-930: `filterTasks`, `filterTasksByQuery`, `parseFilterTokens`, `taskMatchesFilter`, `matchesFrontmatterFilter`, `flattenFrontmatterValues`

Replace with imports from the new services:
```typescript
import { buildTaskTree, resolveParentPath } from "../services/task-tree-builder";
import { filterTasksByQuery } from "../services/outline-filter";
```

Update call sites:
- `this.buildTaskTree(tasks, options)` → `buildTaskTree(tasks, (raw, src) => resolveParentPath(raw, src, this.plugin.app.metadataCache), options)`
- `this.resolveParentPath(raw, src)` → `resolveParentPath(raw, src, this.plugin.app.metadataCache)`
- `this.filterTasksByQuery(tasks, query)` → `filterTasksByQuery(tasks, query)`

Also remove the duplicated local type declarations:
- `TaskTreeData` (lines 13-18) — import from `../models/view-types`
- `TaskTreeBuildOptions` (lines 20-24) — import from `../models/view-types`
- `TreeRenderState` (lines 26-30) — import from `../models/view-types`

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 12: Formalize render contract in DashboardViewController

**Files:**
- Modify: `src/services/dashboard-view-controller.ts`

**Step 1: Replace duck-typing with proper type narrowing**

Current code (line 114):
```typescript
if ("render" in leaf.view && typeof (leaf.view as Record<string, unknown>).render === "function") {
  void (leaf.view as { render(): Promise<void> }).render();
}
```

Replace with check against the known base class:
```typescript
import { LifeDashboardBaseView } from "../ui/views/base-view";

// ...
if (leaf.view instanceof LifeDashboardBaseView && "render" in leaf.view) {
  void (leaf.view as LifeDashboardBaseView & { render(): Promise<void> }).render();
}
```

This is type-safe because all 5 view classes extend `LifeDashboardBaseView`.

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

---

### Task 13: Final verification and build

**Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Run production build**

Run: `npm run build`
Expected: `main.js` produced successfully

**Step 3: Verify line counts**

Run: `wc -l src/ui/views/*.ts src/services/task-tree-builder.ts src/services/outline-filter.ts src/models/view-types.ts src/ui/concern-tree-panel.ts`

Expected approximate counts:
- `base-view.ts`: ~50 lines
- `timer-view.ts`: ~320 lines
- `outline-view.ts`: ~530 lines
- `canvas-view.ts`: ~530 lines
- `calendar-view.ts`: ~500 lines
- `time-log-view.ts`: ~170 lines
- `index.ts`: ~6 lines
- `task-tree-builder.ts`: ~200 lines
- `outline-filter.ts`: ~120 lines
- `view-types.ts`: ~50 lines
- `concern-tree-panel.ts`: ~600 lines (down from 937 — ~320 lines of duplication removed)

No single file should exceed ~530 lines. The old 2,427-line file is gone.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: split monolithic view file into focused modules

- Extract task-tree-builder and outline-filter services
- Split 5 view classes into individual files under src/ui/views/
- Eliminate ~320 lines of duplicated code in concern-tree-panel
- Add shared view types module (src/models/view-types.ts)
- Formalize render dispatch with instanceof check"
```
