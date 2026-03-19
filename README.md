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
2. Use the **Open all views** command to open all views
3. Select a concern and click **Start** to begin tracking time

### Commands

| Command | Description |
|---------|-------------|
| Open all views | Opens all views |
| Open timer | Opens the timer view |
| Open concerns outline | Opens the outline view |
| Open concerns canvas | Opens the canvas view |
| Open concerns calendar | Opens the calendar view |
| Open time log | Opens the time log list view |
| Quick open concern | Fuzzy search concerns; defaults to non-done, non-archived, and `Tab` or the opening shortcut cycles modes, with done/archived items badged in the broad mode |
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

**Priority emojis** - prefix a task with one of the following to set its priority:

| Emoji | Priority |
|-------|----------|
| 🔺 | p0 (critical) |
| ⏫ | p1 (urgent) |
| 🔼 | p2 (high) |
| 🔽 | p3 (low) |
| ⏬ | p4 (lowest) |

**Hotkeys** - hover over any item in the tree and press `0`-`4` to set priority, or `-` to clear it.

**Promote button** - the up-right arrow button on an inline task converts the checkbox into a full concern note.

**Filter controls** - two toggles in the tree panel control inline task visibility:

- **Inline tasks** - show or hide inline subtasks in the tree (default: on)
- **Priority only** - show only items that have a priority set (default: off)

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
npm run build   # production build (type-check + bundle)
npm run check   # type-check only
npm run lint    # ESLint with obsidianmd rules
```

### Releasing

Tag-based releases via GitHub Actions. The `npm version` command auto-bumps `manifest.json` and `versions.json` via the `version-bump.mjs` hook.

```sh
npm version patch   # bumps 0.1.1 -> 0.1.2, updates manifest + versions
git push --follow-tags
```

The release workflow packages `main.js`, `manifest.json`, and `styles.css` as individual GitHub release assets (required by Obsidian).

## Obsidian plugin guidelines

This plugin follows the [official Obsidian plugin development guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and the [developer policies](https://docs.obsidian.md/Developer+policies). The sections below document the constraints that must be respected during development.

### Desktop only

This plugin is marked `isDesktopOnly: true` because it uses Electron APIs (Tray, BrowserWindow, powerMonitor) for the macOS menu bar timer and auto-stop features. Any code path that touches Electron or Node.js APIs must be gated behind runtime feature detection - never import them statically.

### Manifest rules

- `id` must not contain "obsidian" and must match the plugin folder name
- `version` must be semver without a "v" prefix (`0.1.1`, not `v0.1.1`)
- `description` must be under 250 characters, sentence case, end with a period, no emoji
- Release tag must exactly match `version` in `manifest.json`
- Release assets must be individual files (`main.js`, `manifest.json`, `styles.css`), not inside a zip

### Command rules

- Command IDs must not contain the plugin ID (Obsidian auto-prefixes it)
- Command names must not contain the plugin name (Obsidian shows it next to the command)
- No default hotkeys (causes conflicts with other plugins)
- Use the appropriate callback type: `callback`, `checkCallback`, `editorCallback`, or `editorCheckCallback`

### UI text

All user-facing strings must use **sentence case** (not Title Case). This is enforced by the `obsidianmd/ui/sentence-case` ESLint rule.

- "Open timer" not "Open Timer"
- "Quick open concern" not "Quick Open Concern"
- Proper nouns and acronyms stay capitalized

Settings headings must not contain the word "settings" and must use `new Setting(el).setName('heading').setHeading()`, not raw HTML heading elements.

### DOM and styling

- Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML` with user input - use Obsidian's `createEl()`, `createDiv()`, `createSpan()` helpers
- Avoid `element.style.*` for static styles - use CSS classes. Dynamic positioning (`left`, `top`, `width`, `height` from calculations) is acceptable
- Use Obsidian CSS variables for all colors and spacing to maintain theme compatibility
- Use `el.empty()` to clear element contents

### API usage

- Use `this.app` not the global `app` object (may be removed in future)
- Use `requestUrl()` instead of `fetch()` for network requests (bypasses CORS)
- Use `Vault.getFileByPath()` instead of iterating all files
- Use `FileManager.processFrontMatter()` for YAML edits (atomic)
- Use `Vault.process()` for background file modifications (atomic)
- Use `Editor` API for edits to the active file, not `Vault.modify()`
- Use `normalizePath()` for all user-defined paths
- Use `Platform.isIosApp`, `Platform.isAndroidApp` for platform detection, not `navigator`
- Only `console.warn`, `console.error`, `console.debug` - no `console.log`

### Resource management

- Clean up all resources in `onunload()` using `registerEvent()`, `addCommand()` for automatic cleanup
- Do **not** detach leaves in `onunload` (they get reinitialized on plugin update)
- Do **not** store references to custom views in the plugin instance (use `Workspace.getActiveLeavesOfType()`)
- `onunload()` is synchronous (`void`) - async cleanup is fire-and-forget

### Prohibited

- Obfuscated or minified source code in the repository
- Dynamic ads loaded over the network
- Client-side telemetry of any kind
- Self-update mechanisms
- `eval()` or remote code execution
- Using `var` (use `const`/`let`)

### Requires disclosure in README

- Network usage (which remote services and why)
- Accessing files outside the vault
- Account creation required for features
- Payment required for features

### Linting

The project uses [`eslint-plugin-obsidianmd`](https://github.com/mProjectsCode/eslint-plugin-obsidianmd) which enforces 29 Obsidian-specific rules across commands, core APIs, settings, UI text, validation, and vault operations. Run `npm run lint` before submitting. CI runs lint on Node 20.x and 22.x.

### Known lint suppressions

The following eslint-disable comments are intentional and documented:

| Suppression | Location | Reason |
|-------------|----------|--------|
| `no-unsafe-*` | Electron Tray/BrowserWindow code | Dynamic `require("electron")` returns untyped values; no type declarations available |
| `no-undef` for `process` | macos-tray-timer-service.ts | Node global available at runtime in Electron but not in browser type environment |
| `no-undef` for `createFragment` | beancount-view.ts | Obsidian global not in type declarations |
| `import/no-extraneous-dependencies` | editor extensions | `@codemirror/*` packages are provided by Obsidian at runtime, not bundled |
| `no-control-regex` | sanitizeFileName in plugin.ts | Intentional control character stripping for file name sanitization |
| `no-static-styles-assignment` | calendar/concern-map views | Dynamic transform/opacity values used for zoom gestures and highlight toggling |

## License

[MIT](LICENSE)
