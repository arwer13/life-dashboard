# Calendar View Design

## Goal

Add a new calendar view to the Life Dashboard plugin that shows time spent on concerns, with an adaptive layout based on the selected period (Today or This Week).

## Approach

Single adaptive view (`LifeDashboardCalendarView`) with a period toggle. Layout changes based on selection:

- **Today**: Vertical day timeline with colored blocks per entry
- **This Week**: 7-column grid with stacked daily totals per concern

A summary table is always shown below the timeline/grid.

## Data

Reuses existing infrastructure, no new storage:

- `plugin.timeSnapshot.entriesByNoteId` for time entries (startMs, durationMinutes)
- `plugin.getWindowForRange()` for time window computation
- Concern names from vault file basenames
- Colors: fixed palette of 8-10 colors, assigned alphabetically by concern basename

## View Layout

```
┌─────────────────────────────────────┐
│  [Today] [This Week]                │
├─────────────────────────────────────┤
│  Timeline (Today) or Grid (Week)    │
├─────────────────────────────────────┤
│  Summary Table                      │
│  ● Concern A .............. 2h 15m  │
│  ● Concern B .............. 1h 30m  │
│  Total ..................... 3h 45m  │
└─────────────────────────────────────┘
```

### Today Mode

Vertical timeline with 24h axis cropped to active hours. Each time entry is a colored block positioned by start time, height proportional to duration. Concern name label inside or beside the block.

### This Week Mode

7 columns (respects `weekStartsOn` setting). Each column shows stacked colored segments proportional to time spent per concern that day. Day labels at top, total time at bottom.

### Summary Table

- Colored dot + concern basename (clickable, opens note) + formatted duration
- Sorted by most time first
- Total row at bottom

## Registration

- View type: `VIEW_TYPE_LIFE_DASHBOARD_CALENDAR`
- Class: `LifeDashboardCalendarView` extends `LifeDashboardBaseView`
- Command: `open-calendar`
- Added to `open-life-dashboard` combined command
- `DashboardViewController` updated for lifecycle

## Rendering

Pure DOM manipulation, CSS classes for layout, inline styles for dynamic positioning/colors. Follows existing view patterns. Renders on open and on data changes.

## Color Palette

Fixed 8-10 color palette, cycling alphabetically by concern basename. Consistent within a session.
