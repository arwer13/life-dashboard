# Life Dashboard Plugin — Features

> **Convention:** Items marked with `[IMPROVEMENT]` are proposed enhancements, not current features.

## Design Intent

This plugin appears built around the philosophy that a person's life is a tree of **concerns** — ongoing responsibilities, projects, goals, habits, and tensions that compete for attention and time. The creator's likely intents:

1. **Make time visible.** Know exactly where hours go each day, week, and month — not as a guilt tool, but as a mirror. The calendar, timer, and time log exist so the user can compare felt time against actual time.

2. **Keep the full picture accessible.** A single person juggles dozens of concerns at different scales (career, health, relationships, side projects, errands). The outline, canvas, and concern map are different lenses on the same tree — zoomed-in focus vs. birds-eye situational awareness.

3. **Reduce friction to start and stop tracking.** The tray timer, global shortcut, auto-select from active note, and one-click start/stop are all about making tracking cheap enough that the user actually does it instead of reconstructing the day from memory.

4. **Capture tasks at the speed of thought.** The global inbox shortcut and native floating window exist because ideas arrive when Obsidian isn't in focus. The priority buttons (p0–p3) let the user triage on capture, not later.

5. **Let priorities drive attention, not just urgency.** The priority system, priority-only filters, priority sort mode, and priority color overlays are designed so the user can answer "what matters most?" at a glance, separate from "what was tracked recently?"

6. **Support hierarchical decomposition.** Concerns nest: a life area contains projects, projects contain tasks, tasks contain subtasks. The parent links, sub-concern creation, inline checkbox tasks, and promote-to-concern flow support breaking things down without leaving the vault.

7. **Bridge tracked time and health data.** Sleep, heart rate, and step counts shown alongside time-tracking data suggest the creator wants to correlate productivity patterns with physical state — not just "how much did I work?" but "how was I when I worked?"

8. **Stay inside Obsidian.** Rather than using external time trackers, kanban tools, or calendar apps, everything lives in the vault as plain Markdown and JSON. The beancount view extends this to finances. The design intent is one tool, one source of truth.

9. **Support both focused work and periodic review.** The timer and today view serve the "doing" mode. The week/month/year views, outline recency sections, and concern map serve the "reviewing" mode — weekly reviews, monthly retrospectives, or just end-of-day reflection.

10. **Remain non-destructive and portable.** Concerns are regular notes with frontmatter. Time data is a JSON file. Health data is CSV. Nothing proprietary locks the user in — the plugin adds views and automation on top of data the user already owns.

---

## Core Concept

Life Dashboard turns Obsidian notes into **concerns** — trackable items identified by a frontmatter property (default: `type: concen`). Concerns form a tree via `parent: "[[Parent Note]]"` frontmatter links. The plugin provides time tracking, multiple visualization views, and organizational tools around this tree.

- `[IMPROVEMENT]` **Onboarding wizard.** First-run modal that walks through setting the property name/value, creating a root concern, and starting the first timer. Currently a new user must discover the settings tab and understand the concern model before anything works.
- `[IMPROVEMENT]` **Example vault or template.** Ship a starter vault (or a command to scaffold one) with a few sample concerns, an inbox note, and a `Me/Tracking/` folder — lets users see the plugin in action before configuring their own data.

---

## Concern Management

### Concern Identification
- Notes are recognized as concerns when a configurable frontmatter property matches a configurable value (e.g., `type: concen`).
- Optional second filter property for additional narrowing (e.g., `status: active`).
- Case sensitivity is configurable.
- `[IMPROVEMENT]` **Multiple filter rules.** Allow an arbitrary list of property=value filter rules (not just two) so users can build more expressive concern queries without resorting to outline filter syntax.

### Concern Hierarchy
- Parent-child relationships defined via `parent: "[[Note Name]]"` frontmatter.
- Supports wikilink format with aliases (`[[Note|Alias]]`) and heading links.
- Array parents are supported (multiple candidates resolved in order).
- `[IMPROVEMENT]` **Cycle detection warning.** If a parent chain forms a cycle (`A → B → A`), show a notice or badge instead of silently breaking tree rendering. The code has cycle guards, but the user never learns about the problem.
- `[IMPROVEMENT]` **Visual parent-child edge lines on the Concern Map.** Draw lines or arrows between parent and child boxes to make the hierarchy visible at a glance.

### Sub-Concern Creation
- Command: **Create sub-concern for active note** — prompts for a name, creates a new note with `parent` pointing to the current concern.
- Header button (plus icon) appears in the view actions bar of concern notes.
- File context menu: right-click a concern file to create a sub-concern.
- `[IMPROVEMENT]` **Template support for new concerns.** Allow specifying a template note (or inline template) used when creating sub-concerns, so new notes get standard headings (`# Tasks`, `# Notes`, etc.) automatically.

### Inline Tasks
- Unchecked checkboxes (`- [ ] text`) under `# Tasks` or `## Tasks` headings in concern notes are parsed as inline task items.
- Inline tasks appear in the concern tree alongside file-based concerns.
- Priority emojis on inline tasks are recognized (see Priority System below).
- Inline tasks can be moved between parent concerns or promoted to standalone concern notes.
- `[IMPROVEMENT]` **Checked task tracking.** Optionally parse checked checkboxes (`- [x]`) as completed items and show a done/total count or completion progress bar on the parent concern.
- `[IMPROVEMENT]` **Due date support on inline tasks.** Recognize Tasks-plugin due date emoji (📅) or a `@date` syntax and surface overdue/upcoming items in the outline and timer.

### Quick Open Concern
- Command: **Quick open concern** — fuzzy search across all concerns.
- Two search modes (cycle with Tab or the same hotkey): open concerns only, or all concerns including done/archived.
- Done and archived concerns are visually dimmed with badges.
- Supports EN/RU keyboard layout transliteration in search.
- `[IMPROVEMENT]` **Recent concerns mode.** Add a third search mode showing the most recently tracked concerns (ordered by last tracked time), so switching back to what you were just working on is one keystroke.
- `[IMPROVEMENT]` **Preview on hover.** Show a note preview popup when hovering over a suggestion, like Obsidian's Quick Switcher.

---

## Time Tracking

### Timer
- Start/stop timer from the Timer view, commands, or the macOS menu bar.
- Timer auto-selects the active concern note or the currently selected concern.
- Live elapsed time display updated every second.
- Extend active session: "+5m" button moves the start time earlier (limited by the latest saved entry to prevent overlaps).
- Discard button: cancel the current session without saving.
- Auto-stop on system suspend or lock screen (via Electron power monitor).
- Minimum trackable duration is configurable (default: 2 minutes); shorter sessions are discarded on stop.
- `[IMPROVEMENT]` **Idle detection.** Detect when the user has been idle for N minutes (no mouse/keyboard activity) and offer to trim the session or split it — the most common source of inaccurate time logs.
- `[IMPROVEMENT]` **Pomodoro mode.** Optional fixed-duration timer (e.g., 25m work + 5m break) with automatic stop and notification at the end of each interval. The notification rules are close to this, but there is no auto-stop or break cycle.
- `[IMPROVEMENT]` **Global start/stop shortcut.** Register a system-wide hotkey for start/stop (like the inbox shortcut), so the user can toggle tracking without switching to Obsidian.

### Time Log Storage
- Time entries stored in a JSON file (default: `Data/time/time-tracked.json`).
- Each entry: note ID + UTC start timestamp + duration in minutes.
- Overlapping intervals for the same note are automatically merged.
- Corrupted JSON files are backed up automatically with a notice.
- External file changes detected via `fs.watch` with SHA-256 hash deduplication.
- `[IMPROVEMENT]` **Export to CSV/JSON.** One-click export of time data for a date range, grouped by concern — useful for invoicing, reporting, or importing into external tools.
- `[IMPROVEMENT]` **Time log undo.** Keep a short undo stack (last 3-5 mutations) so accidental deletes or edits in the time log view can be reversed.

### Timer Notifications
- Configurable rules: one per line, format `30m "Message"` (supports `s`, `m`, `h` units).
- Desktop notification + system beep when elapsed time crosses a threshold.
- Notification permission is requested once if not already granted.
- `[IMPROVEMENT]` **Recurring notifications.** Support `every 30m "Take a break"` syntax — fire every N minutes, not just at a single threshold. Useful for Pomodoro-style reminders without full Pomodoro mode.

---

## Views

### Timer View
- Live clock display with Start/Stop and Discard buttons.
- Active tracking start time shown with "+5m" extend button.
- Context chain: shows the tracked concern and its parent hierarchy with cumulative time badges.
- Period summary: today's entries (clickable to jump to time log), yesterday total, week total.
- Change task button to pick a different concern.
- `[IMPROVEMENT]` **Daily target indicator.** Optional configurable daily tracking goal (e.g., "6h focused work") with a progress ring or bar in the timer view. Helps answer "am I done for the day?" at a glance.
- `[IMPROVEMENT]` **Session history in timer.** Show the last 3-5 sessions (concern + duration) below the timer so the user can see what they did today without switching to the time log.

### Concerns Outline
- Hierarchical tree of all concerns with collapsible nodes.
- Time range selector: today, today+yesterday, this week, this month, all time.
- Sort modes: recent tracked, priority.
- Filters: text search (path:, file:, prop:key=value, negation with -), tracked-only toggle, show parents toggle, show closed toggle, status done filter.
- Recency sections: concerns grouped by Today, Yesterday, This week, Earlier.
- Priority badges and time badges on each node.
- Priority hotkeys: hover a concern and press 0-4 to set priority, - to clear, § or > to reparent.
- `[IMPROVEMENT]` **Drag-and-drop reparenting.** Drag a concern onto another to change its parent, instead of using the § hotkey → picker flow.
- `[IMPROVEMENT]` **Inline time bar.** Show a small horizontal bar behind each concern proportional to its tracked time relative to siblings — makes time distribution visible without reading numbers.
- `[IMPROVEMENT]` **Saved filter presets.** Allow saving named filter+sort+range combinations (e.g., "Weekly review", "Active priorities") and switching between them with a dropdown or hotkey.

### Concerns Canvas
- Multiple draggable tree cards on a large stage (3600x2400).
- Each card has independent root, filter, sort, range, and collapse state.
- Cards can be added, removed, collapsed, resized, and repositioned.
- Default layout: "Focus now" (tracked today+yesterday) and "Priority map" (all, sorted by priority).
- Layout and per-card state persisted across sessions.
- `[IMPROVEMENT]` **Card linking/arrows.** Draw arrows between cards to show relationships (e.g., "this project feeds into that goal") — turns the canvas into a lightweight dependency map.
- `[IMPROVEMENT]` **Card color/label.** Allow tagging cards with a color or emoji label for visual grouping (e.g., red = blocked, green = on track).

### Concerns Calendar
- Four period modes: Today, Week, Month, Year.
- Navigation: previous/next period buttons, click label to return to current.
- **Today/Week**: vertical time grid with colored blocks per time entry. Blocks are clickable (opens note) and resizable (drag bottom edge, snaps to 5-minute increments).
- **Drag-to-create**: drag on empty grid space to create a new time segment, then pick a concern.
- **Month**: grid with intensity shading, concern color bars per day, time totals.
- **Year**: GitHub-style heatmap with weekly columns and day rows.
- Zoom: drag resize handle on day/week grids to adjust vertical scale (0.5x–2.5x).
- Sidebar concern tree panel with filter/sort controls; hovering highlights corresponding calendar blocks.
- Health overlay: sleep duration, avg sleep HR, steps, coverage metrics from CSV files in `Me/Tracking/`.
- Color map: stable colors per concern based on alphabetical basename ordering.
- `[IMPROVEMENT]` **Drag to move blocks.** Allow dragging existing calendar blocks to a different time (not just resizing the bottom edge) — the most natural way to correct a misplaced entry.
- `[IMPROVEMENT]` **Block split.** Right-click a block to split it at a time point — useful when you forgot to switch tasks and need to divide a session retroactively.
- `[IMPROVEMENT]` **Week/month totals row.** Show a summary row at the bottom of the week view with total hours per day and a week grand total, and similarly for month view — currently the user must mentally sum the per-day figures.
- `[IMPROVEMENT]` **Color legend.** Show a small legend mapping colors to concern names, either as a floating panel or at the bottom of the calendar. Currently the only way to identify a color is hovering/clicking blocks.

### Time Log
- Flat list of all time entries, newest first.
- Each entry shows: concern name, start time (local), duration, note ID.
- Inline editing: click start time or duration to edit in place.
- Reassign: click concern name to move the entry to a different concern.
- Delete: remove individual entries.
- Highlighted entry support: clicking a today entry in the Timer view jumps to it.
- `[IMPROVEMENT]` **Pagination or virtual scroll.** For vaults with thousands of entries, rendering the full flat list is slow. Add pagination or virtual scrolling.
- `[IMPROVEMENT]` **Date/concern filter.** Add a date range picker and concern filter at the top of the time log to narrow the list without scrolling.
- `[IMPROVEMENT]` **Bulk actions.** Multi-select entries (checkboxes) with bulk delete or bulk reassign.
- `[IMPROVEMENT]` **Delete confirmation.** Show a confirmation prompt (or at least an undo toast) before permanently removing a time entry.

### Timeline
- Gantt-style chart for project concerns (frontmatter `kind: project` with `start`/`end` date arrays).
- Non-linear time axis: active regions use sqrt-day scaling, gaps are compressed.
- Lane packing: overlapping projects placed in separate horizontal lanes.
- Today line indicator.
- Also available as a code block: ` ```life-dashboard-timeline``` `.
- `[IMPROVEMENT]` **Edit dates from timeline.** Drag bar edges to change project start/end dates (write back to frontmatter) — currently the timeline is read-only.
- `[IMPROVEMENT]` **Milestone markers.** Support a `milestones` frontmatter field (list of dates + labels) and render them as diamonds or dots on the bar.
- `[IMPROVEMENT]` **Completion percentage.** Show a filled portion of each bar based on `progress` frontmatter or elapsed fraction of the date range.

### Concern Map
- 2D canvas with draggable boxes for each concern.
- Multi-select (Ctrl/Cmd+click) and marquee selection (drag on empty space).
- Double-click to open the note.
- Positions stored as viewport-relative fractions; responsive to window resize.
- Filter controls: root, range, sort, tracked only, parents, inline tasks, priority only, show closed, status, text filter.
- Visual options: font size slider, priority color mode, status color mode, parent label on boxes.
- Tools: Reset positions (grid layout), Fix overlaps (push apart), Fit into canvas (scale to viewport).
- Priority hotkeys: hover + 0-4 / - / § same as outline.
- Smart position migration: when inline tasks shift lines or move between files, positions are preserved via basename matching and line-order matching.
- `[IMPROVEMENT]` **Edge lines between parent-child.** Draw connector lines/arrows from parent boxes to children — the "map" metaphor is incomplete without visible relationships.
- `[IMPROVEMENT]` **Auto-layout algorithms.** In addition to grid layout, offer force-directed or hierarchical (top-down/left-right) automatic layouts that respect the parent-child tree structure.
- `[IMPROVEMENT]` **Time badge on boxes.** Show tracked time (e.g., "2h 15m") as a small label on each box, like the outline view does — currently the map only shows priority and status.
- `[IMPROVEMENT]` **Minimap.** When the map has many concerns spread across a large area, show a small overview minimap in the corner for navigation.

### Supplements Grid
- Year heatmap for supplement intake tracking.
- Reads definitions and daily log from `supplements-intake.md` (Markdown tables under `## Pharma` and `## Log` sections).
- Color-coded cells showing which supplements were taken each day.
- `[IMPROVEMENT]` **Quick-log today.** A button or command to open a modal listing defined supplements with checkboxes, appending today's row to the log table on save — currently the user must edit the Markdown table manually.
- `[IMPROVEMENT]` **Streak/consistency metrics.** Show how many consecutive days each supplement was taken and a per-supplement compliance percentage.

### Beancount View
- Syntax-highlighted editor for `.beancount` files.
- Registered as the default handler for `.beancount` file extension.
- Highlights: dates, accounts, amounts, currencies, strings, comments, directives.
- `[IMPROVEMENT]` **Account autocomplete.** Suggest account names from the file while typing — the most common beancount editing friction.
- `[IMPROVEMENT]` **Balance summary sidebar.** Show a read-only sidebar with per-account balances computed from the file, or at minimum a "run bean-check" button that shows validation errors inline.

### Kanban Board (Bases View)
- Obsidian Bases integration: registered as a custom Bases view type.
- Columns from a configurable frontmatter property (default: `status`).
- Swimlanes from a configurable frontmatter property (default: `priority`).
- Drag and drop cards between columns (updates frontmatter).
- Command: **Create concerns kanban board** — creates a `.base` file pre-configured.
- `[IMPROVEMENT]` **WIP limits.** Allow setting a maximum number of cards per column (e.g., 3 in "in-progress") with a visual warning when exceeded — a core kanban principle currently missing.
- `[IMPROVEMENT]` **Card preview.** Show a snippet of the note body or key frontmatter fields (status, priority, tracked time) on each card, not just the title.

---

## Editor Extensions

### Sub-Concerns Inline Widget
- In concern notes, shows child concerns as inline links below the frontmatter.
- Auto-updates when the concern tree changes.
- `[IMPROVEMENT]` **Child count badge in file explorer.** Show the number of sub-concerns as a badge next to concern files in the Obsidian file explorer sidebar.

### Checkbox Promote Button
- In concern notes with `# Tasks` sections, unchecked checkboxes get a small promote button (↗).
- Click to promote the checkbox to a standalone concern note or move it to another concern's Tasks section.
- `[IMPROVEMENT]` **Bulk promote.** Select multiple checkboxes and promote them all at once to the same parent, instead of one at a time.

---

## macOS Menu Bar (Tray)

- Optional system tray icon showing elapsed time or idle state.
- Context menu: timer status, Start/Stop, Open Timer, recent concerns (up to 5 most recently tracked), Add to inbox.
- Tooltip shows task label and recent concerns.
- Requires desktop Obsidian on macOS.
- `[IMPROVEMENT]` **Windows/Linux tray support.** The tray code is macOS-only (`process.platform === "darwin"` check). Electron's Tray API works on all desktop platforms — widen the guard to enable it on Windows and Linux.
- `[IMPROVEMENT]` **Tray concern switching.** Allow clicking a recent concern in the tray to both select it and start the timer in one action (currently it does this, but confirming the UX works as expected and adding a "switch active timer" option when already tracking a different concern).

---

## Quick Add to Inbox

- Adds a checkbox task to the configured inbox note's `# Tasks` section.
- **Tray menu**: "Add to inbox..." opens a native floating input window (Electron BrowserWindow) with priority buttons (p0–p3) and keyboard shortcuts (Cmd+0-3).
- **Global shortcut**: system-wide shortcut (default: Cmd+Option+Shift+I) opens the same input window from anywhere. Configurable in settings; leave empty to disable.
- Falls back to an Obsidian modal if Electron APIs are unavailable.
- `[IMPROVEMENT]` **Target picker.** Allow choosing which concern's Tasks section to add to (not just the inbox), either via a dropdown in the input window or a modifier key variant of the shortcut.
- `[IMPROVEMENT]` **Multi-line capture.** Support shift+enter for multi-line task descriptions, or a "notes" field that gets appended as indented text below the checkbox.
- `[IMPROVEMENT]` **Confirmation feedback.** After adding a task, briefly show the added text in the native window (or a system notification) before closing, so the user has confidence the capture succeeded.

---

## Priority System

- Frontmatter priority: `priority: p0` through `p4`, or named values (`urgent`, `high`, `medium`, `low`).
- Inline task priority: Tasks-plugin emoji convention — 🔺 (highest/0), ⏫ (high/1), 🔼 (medium/2), 🔽 (low/3), ⏬ (lowest/4).
- Priority hotkeys in Outline, Canvas tree panels, and Concern Map: hover a concern and press 0-4 to assign, - to clear.
- Reparent hotkey: § (en layout) or > (ru layout) — opens a picker to change the concern's parent.
- Priority badges displayed in outline tree, canvas tree panels, and concern map boxes.
- Priority color mode in Concern Map: boxes colored by priority rank.
- Priority sort mode: sort concerns by priority rank in outline, canvas, and map views.
- `[IMPROVEMENT]` **Priority aging.** Auto-escalate priority if a concern has been at the same level for N days without being tracked — surfaces neglected items.
- `[IMPROVEMENT]` **Effort/impact matrix view.** A 2x2 grid view mapping concerns by priority (y-axis) vs. tracked time or estimated effort (x-axis) — the classic Eisenhower/impact-effort quadrant, built from existing data.

---

## Health Tracking Integration

- Reads CSV files from `Me/Tracking/` folder:
  - `sleep*.csv`: columns `total_sleep_min`, `bed_start`, `bed_end`, `avg_sleep_hr`, `night_date`.
  - `steps*.csv`: columns `date`, `steps`.
- Displayed in the Calendar view: overview cards (sleep, sleep HR, steps, coverage), per-day signals in month/week views, year heatmap tooltips.
- Auto-reloads when tracking files change.
- `[IMPROVEMENT]` **Configurable tracking folder path.** Currently hardcoded to `Me/Tracking/`. Make it a setting.
- `[IMPROVEMENT]` **Additional health metrics.** Support weight, HRV, mood, or custom numeric CSV columns — render them as additional cards in the health overview and as optional year-heatmap layers.
- `[IMPROVEMENT]` **Correlation hints.** On the week/month views, show a simple visual correlation between tracked work hours and sleep quality (e.g., "you tracked 8h+ on days when you slept > 7h") — the whole point of bridging these datasets.
- `[IMPROVEMENT]` **CSV import wizard.** A one-time helper to map arbitrary CSV column names to the expected schema (total_sleep_min, steps, etc.) — avoids requiring users to rename columns to match the plugin's expectations.

---

## Commands

| Command | Description |
|---|---|
| Open all views | Opens timer, outline, canvas, and calendar views |
| Open concerns canvas | Opens the canvas view |
| Open timer | Opens the timer view |
| Open concerns outline | Opens the outline view |
| Open concerns calendar | Opens the calendar view |
| Open time log | Opens the time log view |
| Open timeline | Opens the timeline view |
| Open supplements grid | Opens the supplements view |
| Open concern map | Opens the concern map view |
| Quick open concern | Fuzzy search to open a concern note |
| Start task timer | Starts time tracking |
| Stop task timer | Stops time tracking |
| Reset all concern priorities | Clears the priority field from all concerns |
| Search list entries in current file | Fuzzy search through top-level list items |
| Create concerns kanban board | Creates a .base file with kanban configuration |
| Create sub-concern for active note | Creates a child concern for the current note |

- `[IMPROVEMENT]` **Toggle timer command.** A single command that starts if stopped and stops if running — more natural for a single hotkey binding than separate start/stop commands.
- `[IMPROVEMENT]` **Switch concern command.** A command that opens the concern picker and, if tracking, seamlessly stops the current timer and starts a new one on the selected concern in one action.
- `[IMPROVEMENT]` **Quick status change command.** Open a picker to set a concern's status frontmatter (done, active, blocked, etc.) from anywhere, without opening the note.

---

## Settings

| Setting | Description | Default |
|---|---|---|
| Task property name | Frontmatter key identifying concerns | `type` |
| Task property value | Required value for concern notes | `concen` |
| Additional filter property | Optional second filter key | (empty) |
| Additional filter value | Optional second filter value | (empty) |
| Case sensitive | Case-sensitive matching for all filters | off |
| Week starts on | Monday or Sunday | Monday |
| Minimum trackable time | Sessions shorter than this are discarded | 2 minutes |
| Outline max rows | Truncation limit for tree panels | 1000 |
| Time log file path | JSON file for time entries | `Data/time/time-tracked.json` |
| Inbox note path | Vault path to the inbox concern note | (empty) |
| Inbox global shortcut | System-wide shortcut for Add to inbox | `CommandOrControl+Alt+Shift+I` |
| Timer notifications | Rules for timed alerts (e.g., `30m "Break!"`) | (empty) |
| macOS menu bar timer | Show timer in macOS menu bar | off |
| Kanban default column property | Frontmatter property for kanban columns | `status` |
| Kanban default swimlane property | Frontmatter property for kanban swimlanes | `priority` |

- `[IMPROVEMENT]` **Settings validation.** Show inline warnings for invalid values (e.g., non-existent inbox note path, malformed notification rules) instead of silent failures.
- `[IMPROVEMENT]` **Settings organization.** Group settings into collapsible sections (General, Time Tracking, Views, Integrations) — the current flat list will grow unwieldy as features are added.

---

## Ribbon Icons

| Icon | Action |
|---|---|
| list-tree | Open all views |
| network | Open concerns canvas |
| timer | Open timer |
| list | Open concerns outline |
| calendar | Open concerns calendar |
| history | Open time log |
| gantt-chart | Open timeline |
| pill | Open supplements grid |
| map | Open concern map |

- `[IMPROVEMENT]` **Configurable ribbon icons.** Allow users to choose which ribbon icons appear — 9 icons is a lot. A single "Life Dashboard" icon with a submenu, or settings to hide unused views, would reduce ribbon clutter.
