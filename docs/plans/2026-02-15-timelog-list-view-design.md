# Time Log List View Design

## Overview

A simple flat list view of all entries from `time-tracked.json`, with inline editing of start time and duration, sorted newest-first, showing concern names resolved from UUIDs.

## Layout

Each row:

```
[Concern Name]  [2026.01.26-17:11]  [21m]  [🗑]  [uuid (small)]
```

- No field labels
- UUID displayed last, in smaller/muted text
- Sorted by start time descending (newest first)

## Behavior

- **Concern name resolution:** Reverse map UUID → note basename via TaskFilterService items + frontmatter `id`
- **Inline editing:** Click start or duration → becomes `<input>`. On blur/Enter → validate, save, re-render
- **Validation on save:** Use existing `parseIntervalToken()` + `normalizeAndValidateNoteIntervals()` from TimeLogStore. Show error styling if invalid (overlap, bad format)
- **Delete button** per row to remove individual entries

## Integration

- New view class `LifeDashboardTimeLogView` extending `LifeDashboardBaseView`
- View type constant `life-dashboard-timelog-view`
- Registered in `plugin.ts` alongside other views
- Ribbon icon and command added
- Reuses `TimeLogStore` for read/write/validation
