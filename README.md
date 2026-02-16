# Life Dashboard (Obsidian plugin)

Life Dashboard is an Obsidian plugin for tracking time on hierarchical task notes and visualising tracked data across five coordinated views.

Core capabilities:

- Track time on notes filtered by frontmatter properties (default: `type=concen`)
- Organise concerns into parent/child trees via the `parent` frontmatter property
- Persist tracked sessions to a vault-local JSON file
- Visualise tracked time in a timer, outline tree, draggable canvas, calendar, and flat time log

## Views

### Life Timer

Large circular elapsed-time display with Start/Stop control.

- Shows tracking start time (`HH:mm`) and a `+5m` button to shift start earlier (capped to avoid overlaps)
- Active task context chain with cumulative and own-time badges
- Today's entries list (`HH:mm Xm`), plus `This week` and `Yesterday` totals; click any entry to jump to it in the Time Log view
- `Change task…` opens a fuzzy-search modal over filtered tasks
- Auto-selects active note when idle if it matches task filters
- Timer notification rules trigger system notifications and native beep

### Concerns Outline

Collapsible tree of all filtered concerns with time badges.

- Range selector: today, today+yesterday, this week, this month, all time
- Sort modes: recent tracked activity or frontmatter priority
- `Show only tracked this period` checkbox (hides < 1 min entries)
- `Show parents` checkbox (includes ancestor nodes of matched concerns)
- Done filter for `status:done` notes
- Expand/collapse all
- Recency grouping: Today, Yesterday, This Week, Earlier
- Priority badges next to concern names (`p0`..`pN`, or truncated custom priority value)
- Hover + hotkeys: `0`..`4` set `priority: p0`..`p4`, `-` removes `priority`
- Advanced filter syntax (see [Outline filter syntax](#outline-filter-syntax))

### Concerns Canvas

Infinite-scroll canvas (3600 × 2400 px) with draggable, resizable tree cards.

- Each card embeds an independent ConcernTreePanel with its own root, range, sort, tracked-only, parents, and filter controls
- Add Card / Reset Layout buttons
- All card positions, sizes, and tree states persist between sessions via plugin settings
- Same hover priority hotkeys as Outline (`0`..`4`, `-`) inside each tree panel

### Concerns Calendar

Two-column layout: sidebar tree panel + main calendar grid.

- Period toggle: Today (day timeline) or This Week (7-day grid)
- Day timeline: hour-aligned coloured blocks; each block shows start time and concern name (e.g. `14:30 MyTask (25m)`)
- Week grid: stacked coloured segments per day column
- Summary table below the grid, sorted by total tracked time with colour dots
- Sidebar tree panel filters which concerns appear on the grid and only shows concerns with tracked time in the selected period
- Collapsed-parent rollup: when a tree node is collapsed, its children's calendar entries appear under the parent's colour and label; expanding restores them
- Sidebar tree panel supports the same hover priority hotkeys (`0`..`4`, `-`)

### Time Log

Flat list of all raw time entries from the JSON log, sorted newest-first.

- Each row shows concern name, start timestamp, duration, and note UUID
- Inline editing: click start time or duration to edit in place; click concern name to reassign the entry to a different task via fuzzy search
- Delete button per entry
- Saves changes back to the JSON log and refreshes all views
- Highlight-and-scroll: clicking a today entry in the Timer view opens the Time Log and briefly highlights the matching row with an accent fade animation

## Architecture

### Project structure

```
src/
  main.ts                           plugin entrypoint (re-exports default)
  plugin.ts                         LifeDashboardPlugin — lifecycle, event wiring, time-window math
  settings.ts                       LifeDashboardSettings interface and defaults
  version.ts                        build-stamped DISPLAY_VERSION constant
  models/
    types.ts                        TaskItem, TaskTreeNode, TimeLogEntry, TimeLogByNoteId, etc.
    view-types.ts                   shared view constants and types (VIEW_TYPE_*, filter/sort types)
  services/
    task-filter-service.ts          scans vault for notes matching frontmatter filter
    time-log-store.ts               reads/writes/validates JSON time log, computes snapshots
    time-window-service.ts          shared date-window math, overlap-safe period calculations, duration formatting
    timer-notification-service.ts   parses notification rules and tracks per-session threshold state
    tracking-service.ts             start/stop lifecycle, session persistence, UUID provisioning
    dashboard-view-controller.ts    multi-view orchestration (open, reveal, refresh, live-update)
    task-tree-builder.ts            tree construction, parent resolution, priority sorting
    outline-filter.ts               filter token parsing and task matching
  ui/
    views/
      base-view.ts                  abstract base class for all dashboard views
      timer-view.ts                 Life Timer view
      outline-view.ts               Concerns Outline view
      canvas-view.ts                Concerns Canvas view
      calendar-view.ts              Concerns Calendar view
      time-log-view.ts              Time Log list view
      index.ts                      barrel re-export
    concern-tree-panel.ts           reusable tree widget (controls + collapsible preview)
    task-select-modal.ts            FuzzySuggestModal for task selection
    life-dashboard-setting-tab.ts   Settings tab UI
scripts/
  sync-plugin.mjs                   version bump, build, vault sync
esbuild.config.mjs                  bundler config (watch + production modes)
styles.css                          all component styles (~21 KB)
```

### Services

**TaskFilterService** — Scans all markdown files and returns `TaskItem[]` matching the configured frontmatter property/value pair (plus optional secondary filter). Used by every view to obtain the concern list.
Caches results between refreshes and invalidates on vault/metadata events.

**TimeLogStore** — Reads and writes `Data/time/time-tracked.json` (configurable). Each note is keyed by a frontmatter UUID; values are arrays of time tokens (`YYYY.MM.DD-HH:MMT<minutes>M`). Validates intervals to prevent overlap, normalises ordering, and produces `TimeLogSnapshot` with per-note totals and detailed entries.

**TimeWindowService** — Owns all period/window calculations (`today`, `week`, etc.), overlap-aware entry math for boundary-crossing sessions, and shared duration/time-range formatting helpers.

**TimerNotificationService** — Parses timer notification rules and tracks per-session threshold crossings so notifications/beeps are emitted once per threshold.

**TrackingService** — Manages the active timer session. On start: validates selection, ensures UUID in frontmatter, stores start timestamp. On stop: enforces minimum duration, appends to TimeLogStore, reloads totals. Flushes any active session on plugin unload.

**DashboardViewController** — Opens/reveals the five view types in the workspace. Provides `refreshView()` (full re-render of all views) and `pushLiveTimerUpdate()` (1 Hz tick for the timer display only).

### ConcernTreePanel

Reusable widget used by both the Canvas (per-card) and Calendar (sidebar) views.

Controls (each independently hideable):
- Root selector (scope tree to a single concern and its descendants)
- Range selector (today / this week / this month / all time)
- Sort mode (recent or priority)
- Tracked only checkbox
- Show parents checkbox
- Filter search input

Outputs:
- `visiblePaths: Set<string>` — the set of concern paths that pass all filters
- `displayPathMap: Map<string, string>` — maps each visible path to its closest displayed ancestor (accounts for collapsed nodes)

The panel fires `onChange(visiblePaths, state)` whenever filters, sort, or collapse state change.

### Data flow

```
Vault notes
  → TaskFilterService.getTaskTreeItems()
  → TaskItem[] (filtered by frontmatter property)

Time log JSON
  → TimeLogStore.loadSnapshot()
  → TimeLogSnapshot { totals, entriesByNoteId }

TaskItem[] + TimeLogSnapshot
  → buildTaskTree() — resolves parent/child via frontmatter, sorts, computes cumulative seconds
  → TaskTreeNode[] roots

Timer start/stop
  → TrackingService → TimeLogStore.appendTimeEntry() → reloadTotalsAndRefresh()

Vault events (metadata change, rename, delete, create)
  → plugin event handlers → refreshView() or reloadTotalsAndRefresh()
  → all views re-render from current data

File system watcher on time log
  → debounced reload with user notice (handles external edits)
```

### Event handling

| Event | Handler |
|-------|---------|
| `metadataCache.changed` | `refreshView()` |
| `vault.rename` | `reloadTotalsAndRefresh()` |
| `vault.delete` | `reloadTotalsAndRefresh()` |
| `vault.create` | `refreshView()` |
| `vault.modify` (time log file) | debounced `reloadTotalsAndRefresh()` |
| `active-leaf-change` | `maybeAutoSelectFromActive()` |
| OS suspend / lock-screen | auto-stop active tracking via power monitor |

## Time tracking

### Storage format

Default file: `Data/time/time-tracked.json` (vault-relative, configurable in settings).

```json
{
  "2a6c0ec4-2c4f-471f-8b35-13fbe5f15932": [
    "2026.01.26-17:11T21M",
    "2026.01.26-18:03T2M"
  ]
}
```

- Keys are frontmatter UUIDs (auto-generated on first track)
- Values are time tokens: `YYYY.MM.DD-HH:MMT<minutes>M`
- Per-note arrays are sorted by start time ascending
- Intervals are validated to prevent overlap

### Tracking lifecycle

1. User clicks **Start** (or uses command palette)
2. Plugin ensures the note has a frontmatter `id` (UUID); generates one if missing
3. Start timestamp stored in settings (survives plugin reload)
4. Timer ticks at 1 Hz; notification rules checked each tick
5. User clicks **Stop**
6. Duration validated against minimum trackable minutes (default 2)
7. Entry appended to JSON log; totals reloaded; all views refresh

## Task filtering

Notes are included as concerns when their frontmatter matches the configured filter:

| Setting | Default | Description |
|---------|---------|-------------|
| Task property name | `type` | Frontmatter key to match |
| Task property value | `concen` | Required value |
| Additional filter property | (empty) | Optional second key |
| Additional filter value | (empty) | Optional second value |
| Case sensitive | `false` | Whether matching is case-sensitive |

### Parent/child hierarchy

Set `parent: "[[NoteName]]"` in frontmatter to create tree relationships. The plugin resolves wiki-link syntax, aliases (`|`), and anchors (`#`), and supports arrays for multiple candidates.

### Outline filter syntax

The outline and tree panel support advanced filter tokens:

| Token | Example | Description |
|-------|---------|-------------|
| bare word | `project` | Matches basename or path |
| `path:` | `path:folder/sub` | Matches file path |
| `file:` | `file:myfile` | Matches file basename |
| `prop:key` | `prop:status` | Checks property exists |
| `prop:key=value` | `prop:status=active` | Checks property equals value |
| `"quoted"` | `"my task"` | Literal phrase |
| `-` prefix | `-archived` | Negation |

### Priority sorting

When sort mode is "priority", frontmatter `priority` (or `prio`, `p`) is ranked:

| Value | Rank |
|-------|------|
| `urgent` | 0 |
| `high` | 1 |
| `medium` / `med` | 2 |
| `low` | 3 |
| `p0`, `p1`, … | numeric |
| numeric | as-is |
| absent/unknown | 100 |

Ties broken by most-recent tracked activity, then path.

## Settings

All settings are in **Settings → Life Dashboard**.

| Setting | Default | Description |
|---------|---------|-------------|
| Task property name | `type` | Frontmatter key for concern filtering |
| Task property value | `concen` | Required value for concern filtering |
| Additional filter property | (empty) | Optional second frontmatter key |
| Additional filter value | (empty) | Optional second value |
| Case sensitive | `false` | Case-sensitive property matching |
| Time log path | `Data/time/time-tracked.json` | Vault-relative path to JSON log |
| Minimum trackable minutes | `2` | Sessions shorter than this are discarded |
| Week starts on | `monday` | `monday` or `sunday`; affects week ranges |
| Timer notifications | (empty) | Multiline rules: `30m "Message"` |

Timer notification format: `<duration> "message"` — units `s`, `m`, `h`. Triggers system notification + native beep.

## Commands

| Command | Description |
|---------|-------------|
| Open Life Dashboard | Opens all five views |
| Open Timer | Opens the timer view |
| Open Concerns Outline | Opens the outline view |
| Open Concerns Canvas | Opens the canvas view |
| Open Calendar | Opens the calendar view |
| Open Time Log | Opens the time log list view |
| Start Time Tracking | Starts the timer |
| Stop Time Tracking | Stops the timer |

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Set `VAULT_PATH='/absolute/path/to/your/vault'` in `.env`

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | esbuild watch + sync to vault plugin folder |
| `npm run build` | One-shot production build (`main.js` only) |
| `npm run deploy` | Bump version, build, touch `.hotreload`, sync to vault |
| `npm run check` | TypeScript type-check (`tsc --noEmit`) |

## Manual install

Copy to `<Vault>/.obsidian/plugins/life-dashboard/`:

- `manifest.json`
- `main.js`
- `styles.css`
- `versions.json`

Enable in **Settings → Community plugins**.

## Debugging

- On load: `[life-dashboard] loaded v<version> at <ISO timestamp>` in console
- Hot-reload triggers when `main.js` or `styles.css` changes and `.hotreload` exists
- `npm run deploy` for one-shot builds without background watchers
