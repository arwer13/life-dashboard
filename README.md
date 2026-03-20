# Life Dashboard

Track time on hierarchical concern notes and visualize progress across timer, outline, calendar, canvas, concern map, timeline, and kanban views.

## Features

- **Timer** — start/stop clock with live elapsed display, extend/discard session, today's entries, and task context chain
- **Concerns Outline** — collapsible tree of filtered concerns with time badges, priority sorting, recency sections, and advanced filtering
- **Concerns Canvas** — freeform canvas with draggable, resizable tree cards, each with independent filter and sort settings
- **Concerns Calendar** — today/week timeline grids with drag-to-create and resize, month grid with color bars, and GitHub-style year heatmap. Optional sleep/steps overlays from CSV files in `Me/Tracking/`
- **Concern Map** — 2D spatial canvas with draggable boxes, multi-select, marquee selection, priority/status coloring, and automatic position migration
- **Timeline** — Gantt-style chart for project concerns with non-linear time scaling and lane packing
- **Time Log** — flat list of all raw time entries with inline editing, reassignment, and deletion
- **Kanban Board** — Obsidian Bases integration with drag-and-drop columns and swimlanes from configurable frontmatter properties
- **Supplements Grid** — year heatmap tracking daily supplement intake from a Markdown table
- **Beancount** — syntax-highlighted editor for `.beancount` plain-text accounting files

Additional capabilities:

- Filter notes by frontmatter properties (default: `type=concen`)
- Organize concerns into parent/child trees via the `parent` frontmatter property
- Inline subtasks from checkboxes under `# Tasks` headings, with promotion to standalone concerns
- Priority sorting and hotkeys (`urgent`, `high`, `medium`, `low`, `p0`..`p4`, emoji convention)
- Quick add to inbox via native floating window or configurable global shortcut
- Timer notification rules with system notifications and native beep
- Optional macOS menu bar timer with recent concerns and quick add (desktop only)
- Auto-stop on system suspend or lock screen (desktop only)
- Health tracking overlay (sleep, steps) from CSV files

## Installation

### From community plugins

1. Open **Settings > Community plugins**
2. Search for "Life Dashboard"
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/arwer/obsidian-tools/releases).
2. Create a folder `<vault>/.obsidian/plugins/life-dashboard/`.
3. Copy the three files into that folder.
4. Reload Obsidian and enable the plugin in Settings > Community Plugins.

## Usage

### Getting started

1. Create notes with `type: concen` in frontmatter (or configure a different property/value in settings).
2. Use `parent: "[[Parent Note]]"` to build a hierarchy.
3. Open the timer view from the ribbon or command palette and start tracking.

### Commands

| Command | Description |
|---------|-------------|
| Open all views | Opens timer, outline, canvas, and calendar views |
| Open timer | Opens the timer view |
| Open concerns outline | Opens the outline view |
| Open concerns canvas | Opens the canvas view |
| Open concerns calendar | Opens the calendar view |
| Open time log | Opens the time log view |
| Open timeline | Opens the timeline view |
| Open supplements grid | Opens the supplements view |
| Open concern map | Opens the concern map view |
| Quick open concern | Fuzzy search concerns with mode cycling (Tab) |
| Start task timer | Starts the timer |
| Stop task timer | Stops the timer |
| Reset all concern priorities | Removes priority from all concerns |
| Search list entries in current file | Fuzzy search through top-level list items |
| Create concerns kanban board | Creates a `.base` file with kanban configuration |
| Create sub-concern for active note | Creates a child concern for the current note |

### Task filtering

Notes are included as concerns when their frontmatter matches the configured filter:

| Setting | Default | Description |
|---------|---------|-------------|
| Task property name | `type` | Frontmatter key to match |
| Task property value | `concen` | Required value |
| Additional filter property | (empty) | Optional second key |
| Additional filter value | (empty) | Optional second value |
| Case sensitive | `false` | Whether matching is case-sensitive |

Set `parent: "[[NoteName]]"` in frontmatter to create tree relationships.

### Outline filter syntax

| Token | Example | Description |
|-------|---------|-------------|
| bare word | `project` | Matches basename or path |
| `path:` | `path:folder/sub` | Matches file path |
| `file:` | `file:myfile` | Matches file basename |
| `prop:key` | `prop:status` | Checks property exists |
| `prop:key=value` | `prop:status=active` | Checks property equals value |
| `"quoted"` | `"my task"` | Literal phrase |
| `-` prefix | `-archived` | Negation |

### Inline subtasks

Checkbox items (`- [ ] text`) listed under a `# Tasks` or `## Tasks` heading inside a concern note appear as subtasks in outline, canvas, and map views. Checked items (`- [x]`) are automatically hidden.

**Priority emojis** — prefix a task with one of the following to set its priority:

| Emoji | Priority |
|-------|----------|
| 🔺 | p0 (critical) |
| ⏫ | p1 (urgent) |
| 🔼 | p2 (high) |
| 🔽 | p3 (low) |
| ⏬ | p4 (lowest) |

**Hotkeys** — hover over any item in the outline, canvas tree, or concern map and press `0`–`4` to set priority, `-` to clear, or `§`/`>` to reparent.

**Promote button** — the up-right arrow button on an inline task converts the checkbox into a full concern note or moves it to another parent's tasks section.

### Quick add to inbox

Configure an inbox note path in settings. Then:

- Use the **global shortcut** (default `Cmd+Option+Shift+I`) to open a native floating input window from anywhere.
- Or use **Add to inbox** from the macOS tray menu.
- The input window supports priority buttons (p0–p3) with `Cmd+0`–`3` shortcuts.
- Falls back to an Obsidian modal if Electron APIs are unavailable.

### Health tracking

Place CSV files in `Me/Tracking/`:

- `sleep*.csv` with columns: `total_sleep_min`, `bed_start`, `bed_end`, `avg_sleep_hr`, `night_date`
- `steps*.csv` with columns: `date`, `steps`

Data appears in the calendar view as overview cards, per-day indicators, and year heatmap tooltips.

### Settings

All settings are in **Settings > Life Dashboard**.

| Setting | Default | Description |
|---------|---------|-------------|
| Task property name | `type` | Frontmatter key for concern filtering |
| Task property value | `concen` | Required value for concern filtering |
| Additional filter property | (empty) | Optional second frontmatter key |
| Additional filter value | (empty) | Optional second value |
| Case sensitive | `false` | Case-sensitive property matching |
| Time log path | `Data/time/time-tracked.json` | Vault-relative path to JSON log |
| Minimum trackable minutes | `2` | Sessions shorter than this are discarded |
| Week starts on | `monday` | `monday` or `sunday` |
| Outline max rows | `1000` | Truncation limit for tree panels |
| Inbox note path | (empty) | Vault path to the inbox concern note |
| Inbox global shortcut | `CommandOrControl+Alt+Shift+I` | System-wide shortcut for quick add |
| Timer notifications | (empty) | Multiline rules: `30m "Message"` |
| macOS menu bar timer | `false` | Shows timer in macOS menu bar (desktop only) |
| Kanban default column property | `status` | Frontmatter property for kanban columns |
| Kanban default swimlane property | `priority` | Frontmatter property for kanban swimlanes |

Timer notification format: `<duration> "message"` (units: `s`, `m`, `h`).

### Time storage format

Sessions are stored in a vault-local JSON file (default: `Data/time/time-tracked.json`):

```json
{
  "uuid-of-note": ["2026.01.26-17:11T21M", "2026.01.26-18:03T2M"]
}
```

Keys are frontmatter UUIDs (auto-generated on first track). Values are time tokens: `YYYY.MM.DD-HH:MMT<minutes>M`.

## Desktop only

This plugin is marked `isDesktopOnly: true` because it uses Electron APIs (Tray, BrowserWindow, powerMonitor, globalShortcut) for the macOS menu bar timer, native quick-add window, global shortcut, and auto-stop features. All Electron and Node.js API access is gated behind runtime feature detection.

## Development

```sh
npm install
cp .env.example .env
# Set VAULT_PATH in .env to your vault's absolute path
npm run dev     # watch + sync to vault
npm run build   # production build (type-check + bundle)
npm run check   # type-check only
npm run lint    # ESLint with obsidianmd rules
```

### Releasing

Tag-based releases via GitHub Actions. The `npm version` command auto-bumps `manifest.json` and `versions.json` via the `version-bump.mjs` hook.

```sh
npm version patch   # bumps version, updates manifest + versions
git push --follow-tags
```

The release workflow packages `main.js`, `manifest.json`, and `styles.css` as individual GitHub release assets (required by Obsidian).

### Linting

The project uses [`eslint-plugin-obsidianmd`](https://github.com/mProjectsCode/eslint-plugin-obsidianmd) which enforces Obsidian-specific rules across commands, core APIs, settings, UI text, validation, and vault operations. Run `npm run lint` before submitting.

### Known lint suppressions

| Suppression | Location | Reason |
|-------------|----------|--------|
| `no-unsafe-*` | Electron Tray/BrowserWindow code | Dynamic `require("electron")` returns untyped values |
| `no-undef` for `process` | macos-tray-timer-service.ts | Node global available at runtime in Electron |
| `import/no-extraneous-dependencies` | Editor extensions | `@codemirror/*` packages provided by Obsidian at runtime |
| `no-control-regex` | sanitizeFileName | Intentional control character stripping |
| `no-static-styles-assignment` | Calendar/concern map views | Dynamic values for zoom and highlight toggling |

## License

[MIT](LICENSE)
