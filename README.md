# Life Dashboard

Track time on hierarchical task notes and visualize progress across six views: timer, outline, canvas, calendar, time log, and kanban board.

## Features

- **Life Timer** - Large circular elapsed-time display with start/stop, today's entries, and task context chain
- **Concerns Outline** - Collapsible tree of filtered concerns with time badges, priority sorting, and advanced filtering
- **Concerns Canvas** - Infinite-scroll canvas with draggable, resizable tree cards
- **Concerns Calendar** - Today/week timeline views plus month and GitHub-style year heatmaps with period navigation and optional sleep/steps overlays from `Me/Tracking`
- **Time Log** - Flat list of all raw time entries with inline editing
- **Kanban Board** - Drag-and-drop board with configurable columns and swimlanes

Additional capabilities:

- Filter notes by frontmatter properties (default: `type=concen`)
- Organize concerns into parent/child trees via the `parent` frontmatter property
- Priority sorting (`urgent`, `high`, `medium`, `low`, `p0`..`pN`)
- Timer notification rules with system notifications and native beep
- Optional macOS menu bar timer (desktop only)
- Auto-stop on system suspend/lock-screen (desktop only)

## Installation

### From community plugins

1. Open **Settings > Community plugins**
2. Search for "Life Dashboard"
3. Click **Install**, then **Enable**

### Manual

Copy `manifest.json`, `main.js`, `styles.css` to `<vault>/.obsidian/plugins/life-dashboard/` and enable in **Settings > Community plugins**.

## Usage

### Getting started

1. Create notes with `type: concen` in frontmatter (or configure a different property/value in settings)
2. Use the **Open Life Dashboard** command to open all views
3. Select a concern and click **Start** to begin tracking time

### Commands

| Command | Description |
|---------|-------------|
| Open Life Dashboard | Opens all views |
| Open Timer | Opens the timer view |
| Open Concerns Outline | Opens the outline view |
| Open Concerns Canvas | Opens the canvas view |
| Open Concerns Calendar | Opens the calendar view |
| Open Time Log | Opens the time log list view |
| Quick Open Concern | Fuzzy search concerns; defaults to non-done, non-archived, and `Tab` or the opening shortcut cycles modes, with done/archived items badged in the broad mode |
| Start task timer | Starts the timer |
| Stop task timer | Stops the timer |
| Reset all concern priorities | Removes priority from all concerns |

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

Checkbox items (`- [ ] text`) listed under a `# Tasks` or `## Tasks` heading inside a concern note appear as subtasks in outline and canvas trees. Checked items (`- [x]`) are automatically hidden.

**Priority emojis** — prefix a task with one of the following to set its priority:

| Emoji | Priority |
|-------|----------|
| 🔺 | p0 (critical) |
| ⏫ | p1 (urgent) |
| 🔼 | p2 (high) |
| 🔽 | p3 (low) |
| ⏬ | p4 (lowest) |

**Hotkeys** — hover over any item in the tree and press `0`–`4` to set priority, or `-` to clear it.

**Promote button** — the `↗` button on an inline task converts the checkbox into a full concern note.

**Filter controls** — two toggles in the tree panel control inline task visibility:

- **Inline tasks** — show or hide inline subtasks in the tree (default: on)
- **Priority only** — show only items that have a priority set (default: off)

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
| Timer notifications | (empty) | Multiline rules: `30m "Message"` |
| macOS menu bar timer | `false` | Shows timer in macOS menu bar (desktop only) |

Timer notification format: `<duration> "message"` (units: `s`, `m`, `h`).

### Time storage format

Sessions are stored in a vault-local JSON file (default: `Data/time/time-tracked.json`):

```json
{
  "uuid-of-note": ["2026.01.26-17:11T21M", "2026.01.26-18:03T2M"]
}
```

Keys are frontmatter UUIDs (auto-generated on first track). Values are time tokens: `YYYY.MM.DD-HH:MMT<minutes>M`.

## Development

```sh
npm install
cp .env.example .env
# Set VAULT_PATH in .env to your vault's absolute path
npm run dev     # watch + sync to vault
npm run build   # production build
npm run check   # type-check
```

## License

[MIT](LICENSE)
