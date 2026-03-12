# Calendar View Design

## Goal

Add a new calendar view to the Life Dashboard plugin that shows time spent on concerns, with adaptive layouts for Today, Week, Month, and Year.

## Approach

Single adaptive view (`LifeDashboardCalendarView`) with a period toggle and previous/next navigation for non-day ranges. Layout changes based on selection:

- **Today**: Vertical day timeline with colored blocks per entry
- **Week**: 7-column grid with stacked daily totals per concern
- **Month**: Month grid with per-day intensity based on tracked time
- **Year**: GitHub-style heatmap with one square per day

The sidebar concern tree stays in sync with the active calendar window, including offset week/month/year navigation.

## Data

Reuses existing infrastructure, no new storage:

- `plugin.timeSnapshot.entriesByNoteId` for time entries (startMs, durationMinutes)
- `plugin.getWindowForRange()` for time window computation
- Concern names from vault file basenames
- Colors: fixed palette of 8-10 colors, assigned alphabetically by concern basename

## View Layout

```
┌─────────────────────────────────────┐
│  [Today] [Week] [Month] [Year]      │
│  [‹] Mar 2026 [›]                   │
├─────────────────────────────────────┤
│  Timeline / Week Grid / Month /     │
│  Year Heatmap                       │
└─────────────────────────────────────┘
```

### Today Mode

Vertical timeline with 24h axis cropped to active hours. Each time entry is a colored block positioned by start time, height proportional to duration. Concern name label inside or beside the block.

### Week Mode

7 columns (respects `weekStartsOn` setting). Each column shows stacked colored segments proportional to time spent per concern that day. Day labels at top, total time at bottom.

### Month Mode

Month grid with weekday headers, today highlighting, and background intensity based on total tracked time for that day. Small stacked color bars show which concerns contributed most to the day.

### Year Mode

GitHub-style contribution heatmap. Each day is a square and color intensity reflects total tracked time relative to the busiest day in the displayed year. Month labels align to the week columns and today is outlined.

## Registration

- View type: `VIEW_TYPE_LIFE_DASHBOARD_CALENDAR`
- Class: `LifeDashboardCalendarView` extends `LifeDashboardBaseView`
- Command: `open-calendar`
- Added to `open-life-dashboard` combined command
- `DashboardViewController` updated for lifecycle

## Rendering

Pure DOM manipulation, CSS classes for layout, inline styles for dynamic positioning/colors. Follows existing view patterns. Renders on open, on calendar period navigation, and on data changes.

## Color Palette

Fixed 8-10 color palette, cycling alphabetically by concern basename. Consistent within a session.
