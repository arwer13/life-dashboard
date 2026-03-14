# Timeline View for Project Concerns

## Overview

A new main-pane view that displays a vertical timeline of concerns with `kind: project` that have `start` and `end` date properties. Time flows vertically (top = earliest). Overlapping entries are laid out in swim lanes side-by-side.

## Requirements

- Show only concerns matching `kind: project` in frontmatter
- Read `start` and `end` frontmatter properties (format: `YYYY-MM-DD`)
- Skip concerns missing either property
- Default visible range: 1 year from today
- Concise display: concern name + start/end dates on each bar
- Clickable bars navigate to the concern note
- Swim lane layout for overlapping entries

## Data Model

```typescript
type TimelineEntry = {
  file: TFile;
  name: string;       // file basename
  start: Date;        // parsed from frontmatter `start`
  end: Date;          // parsed from frontmatter `end`
};
```

### Data Collection

1. Get all concern `TaskItem[]` via `plugin.getTaskTreeItems()`
2. Filter to those with `kind: project` using `matchesFrontmatterFilter()`
3. Parse `start` and `end` from frontmatter as `YYYY-MM-DD` strings
4. Skip entries where either date is missing or unparseable
5. Skip entries entirely outside the visible range

## Layout

### Structure

```
┌──────────────────────────────────┐
│ Mar 2026 – Mar 2027      header  │
├──────┬───────────────────────────┤
│ Mar  │ ┌─────┐                   │
│      │ │Trip │                   │
│ Apr  │ │  A  │ ┌──────┐         │
│      │ └─────┘ │Course│         │
│ May  │         │  B   │         │
│      │         │      │         │
│ Jun  │         └──────┘         │
│      │                          │
│ Jul  │ ┌─────┐                  │
│      │ │Trip │                  │
│ Aug  │ │  C  │                  │
│      │ └─────┘                  │
└──────┴──────────────────────────┘
```

- **Header:** Date range label (e.g., "Mar 2026 – Mar 2027")
- **Left axis:** Month labels, positioned at month boundaries
- **Main area:** Swim lanes with entry bars
- **Month grid lines:** Horizontal dashed lines at each month boundary

### Swim Lane Packing

Greedy algorithm: iterate entries sorted by start date, assign each to the leftmost lane where it doesn't overlap any existing entry. Expected lane count: 1-4 for 5-15 entries.

### Bar Rendering

Each bar is a `div` with:
- Absolute positioning within its lane (top/height as percentage of total timeline span)
- Left-border color accent from a color palette (reuses `CALENDAR_COLORS` pattern)
- Semi-transparent background fill matching the accent color
- Concern name as text label inside the bar
- Start date displayed at the top edge, end date at the bottom edge (small, muted `fmo-` styled text)
- `cursor: pointer`

### Interaction

- **Click** a bar: navigate to the concern note via `app.workspace.getLeaf().openFile(file)`
- **Hover** a bar: subtle background highlight
- No drag, resize, or inline editing — read-only view

## View Registration

### New Constant

In `src/models/view-types.ts`:
```typescript
export const VIEW_TYPE_LIFE_DASHBOARD_TIMELINE = "life-dashboard-timeline-view";
```

Added to `LIFE_DASHBOARD_VIEW_TYPES` array to participate in the existing refresh cycle.

### New File

`src/ui/views/timeline-view.ts` — `LifeDashboardTimelineView` extends `LifeDashboardBaseView`.

Methods:
- `getViewType()` → `VIEW_TYPE_LIFE_DASHBOARD_TIMELINE`
- `getDisplayText()` → `"Timeline"`
- `getIcon()` → `"gantt-chart"`
- `async render()` → collects entries, computes layout, renders DOM

### Plugin Integration (`plugin.ts`)

- `registerView(VIEW_TYPE_LIFE_DASHBOARD_TIMELINE, ...)`
- `addCommand({ id: "open-timeline", name: "Open Timeline", ... })`
- `addRibbonIcon("gantt-chart", "Open Timeline", ...)`

### Dashboard View Controller

New method `activateTimelineView()` using `openAndRevealView()` with `"tab"` placement (same pattern as calendar/canvas).

### View Exports

Add to `src/ui/views/index.ts`.

## CSS

All classes use `fmo-timeline-` prefix, added to `styles.css`. Uses Obsidian CSS variables for theming consistency (`--background-secondary`, `--text-muted`, `--background-modifier-border`, etc.).

Key classes:
- `.fmo-timeline-container` — main scrollable container
- `.fmo-timeline-header` — date range label
- `.fmo-timeline-axis` — left month label column
- `.fmo-timeline-lanes` — swim lane area (position: relative)
- `.fmo-timeline-bar` — individual entry bar
- `.fmo-timeline-bar-name` — concern name label
- `.fmo-timeline-bar-date` — start/end date labels
- `.fmo-timeline-grid-line` — horizontal month boundary lines
