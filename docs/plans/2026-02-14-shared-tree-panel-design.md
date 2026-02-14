# Shared ConcernTreePanel Widget

## Problem

The Calendar view uses a flat summary list for tracked concerns. The Canvas view has a rich tree panel with filtering, collapsing/expanding, root selection, and sorting. We want the Calendar view to use the same tree panel, and we want to avoid reimplementing it.

## Decision

Extract a `ConcernTreePanel` class from the Canvas view's per-card tree logic. Both Canvas and Calendar views instantiate this widget, passing configuration for which controls to show/hide.

## Architecture

### ConcernTreePanel class (`src/ui/concern-tree-panel.ts`)

A plain class (not an Obsidian view) that renders into a provided container element.

```typescript
type ConcernTreePanelConfig = {
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

type ConcernTreePanelState = {
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  collapsedNodePaths: Set<string>;
};
```

Key methods:
- `constructor(config)` — renders controls + initial tree
- `render()` — re-renders tree with current state
- `getVisiblePaths(): Set<string>` — current visible concern paths
- `getState(): ConcernTreePanelState` — for persistence
- `setState(partial)` — update state externally (e.g., calendar syncing range)

### What moves from Canvas view to the panel

- Controls rendering (root selector, range, sort, flags, filter)
- `renderCanvasTreePreview()` → `renderTree()`
- `renderCanvasTreeNode()` → `renderTreeNode()`
- Tree data methods: `getCanvasOwnSecondsByPath()`, `buildCanvasParentPathMap()`, `collectCanvasScopePaths()`, `collectCanvasPathsWithParents()`, `selectCanvasRoots()`, `collectCanvasBranchPaths()`, `filterTasksForCanvas()`

### What stays in Canvas view

- Card chrome: drag handle, title input, collapse/remove buttons, resize handle
- Canvas stage/viewport layout
- Persistence of card geometry (x, y, width, height)
- `ensureCanvasTrees()`, serialization/deserialization of `CanvasTreeDraft`
- Card creates a `ConcernTreePanel` inside its body area

### Calendar view layout

Two-column flexbox layout:

```
┌──────────────────────────────────────────────┐
│  Concerns Calendar    [Today] [This Week]    │
├─────────────┬────────────────────────────────┤
│ TreePanel   │  Timeline / Week Grid          │
│ (sidebar)   │                                │
│ ~280px wide │  Summary table                 │
└─────────────┴────────────────────────────────┘
```

- Left sidebar: single `ConcernTreePanel` with `hideControls: { range: true, trackedOnly: true }`
- Range is driven by the calendar period toggle (Today/This Week), synced to tree panel via `setState({ range })`
- `trackedOnly` hidden because calendar inherently only shows concerns with time entries
- `onChange` callback receives `visiblePaths`, re-renders calendar grid filtering entries to matching paths only
- Summary table also filters by visible paths

### Persistence

- **Canvas:** No change. Canvas reads persisted `CanvasTreeDraft`, extracts panel state fields, passes to `ConcernTreePanel`. Gets updated state back via `onChange`, merges with geometry, persists.
- **Calendar:** New `calendarTreePanelState` field in plugin settings. Stores `rootPath`, `query`, `sortMode`, `showParents`, `collapsedNodePaths` (range excluded — derived from calendar period).

### CSS changes

- Shared tree panel controls/tree styles: rename `.fmo-canvas-*` to `.fmo-tree-panel-*` for the shared widget classes
- New calendar layout classes: `.fmo-calendar-layout` (flexbox), `.fmo-calendar-sidebar` (~280px, overflow-y scroll), `.fmo-calendar-main` (flex: 1)
- Canvas view continues to use card-specific classes for chrome

### Filter → calendar grid interaction

When the tree panel's visible paths change:
1. `onChange` fires with new `visiblePaths` set
2. Calendar re-runs `gatherCalendarEntries()` filtering by `visiblePaths`
3. Calendar re-renders timeline/grid + summary table with filtered entries
4. Color map rebuilds from filtered entries only
