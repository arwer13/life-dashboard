# Inline Checkbox Subtasks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show `- [ ] text` checkbox items under `# Tasks` / `## Tasks` headings as lightweight subtasks in concern outlines, with priority from Tasks-plugin emojis and an inline editor button to promote them to full concern notes.

**Architecture:** TaskItem becomes a discriminated union (`FileTaskItem | InlineTaskItem`). A new `InlineTaskParser` service reads concern files for checkbox items in Tasks sections. Both item types flow through the tree builder, outline filter, and renderers. A new CodeMirror extension adds a promote button next to each unchecked checkbox in Tasks sections. Promotion opens the standard concern picker for parent selection, creates a `kind: task` note, and replaces the checkbox line with a wikilink.

**Tech Stack:** TypeScript, Obsidian API, CodeMirror 6 (decorations/widgets)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/models/types.ts` | Discriminated union `TaskItem = FileTaskItem \| InlineTaskItem`, helper guards |
| Create | `src/services/inline-task-parser.ts` | Parse `# Tasks` / `## Tasks` sections for unchecked checkbox items, extract priority emojis, return `InlineTaskItem[]` for a given concern file |
| Modify | `src/services/task-filter-service.ts` | Tag produced items as `kind: "file"`, return type stays `TaskItem[]` |
| Modify | `src/services/task-tree-builder.ts` | Use `item.path` / `item.basename` via helpers; handle inline parent resolution; adapt priority reading |
| Modify | `src/services/outline-filter.ts` | Handle both item types in `taskMatchesFilter` |
| Modify | `src/services/priority-utils.ts` | Add `getItemPriority(item: TaskItem)` to unify priority access |
| Modify | `src/plugin.ts` | Merge inline items into `getTaskTreeItems()`, register promote extension, add `promoteCheckboxToConcern()` method |
| Modify | `src/ui/concern-tree-panel.ts` | Render inline items with dimmed style + checkbox indicator; click opens parent |
| Modify | `src/ui/views/outline-view.ts` | Same rendering changes for inline items |
| Modify | `src/ui/views/timer-view.ts` | Type guard for `item.file` access |
| Modify | `src/ui/views/canvas-view.ts` | Type guard for `item.file` access |
| Modify | `src/ui/views/calendar-view.ts` | Type guard for `item.file` access |
| Modify | `src/ui/views/time-log-view.ts` | Type guard for `item.file` access |
| Modify | `src/ui/views/timeline-view.ts` | Type guard for `item.file` access |
| Modify | `src/ui/editor/sub-concerns-extension.ts` | Filter to file items only via type guard |
| Create | `src/ui/editor/checkbox-promote-extension.ts` | CodeMirror extension: decorates unchecked checkboxes in `# Tasks` / `## Tasks` sections with a promote button widget |
| Modify | `styles.css` | CSS classes for inline task rows in tree, promote button styling |

---

## Chunk 1: Data Model & Core Services

### Task 1: Discriminated Union TaskItem

**Files:**
- Modify: `src/models/types.ts`

- [ ] **Step 1: Replace TaskItem interface with discriminated union**

```typescript
// src/models/types.ts
import type { FrontMatterCache, TFile } from "obsidian";

export interface FileTaskItem {
  kind: "file";
  file: TFile;
  path: string;        // file.path (denormalized for uniform access)
  basename: string;    // file.basename
  parentRaw: unknown;
  frontmatter: FrontMatterCache | undefined;
}

export interface InlineTaskItem {
  kind: "inline";
  path: string;        // synthetic key: "${parentPath}#checkbox:${line}"
  basename: string;    // display text (checkbox text stripped of priority emoji)
  parentPath: string;  // concern file containing the checkbox
  text: string;        // raw checkbox text (with priority emoji)
  line: number;        // 0-based line number in the source file
  priority: number | null;  // numeric rank (0=highest..4=lowest), null if unset
}

export type TaskItem = FileTaskItem | InlineTaskItem;

export function isFileItem(item: TaskItem): item is FileTaskItem {
  return item.kind === "file";
}

export function isInlineItem(item: TaskItem): item is InlineTaskItem {
  return item.kind === "inline";
}
```

Keep `TaskTreeNode`, `TimeLogByNoteId`, `TimeLogEntry`, `TimeLogSnapshot`, `ListEntry` unchanged.

- [ ] **Step 2: Verify project compiles**

Run: `npx tsc --noEmit`
Expected: compilation errors in many files that still access `item.file` directly (this is expected — they'll be fixed in subsequent tasks)

- [ ] **Step 3: Commit**

```bash
git add src/models/types.ts
git commit -m "feat: convert TaskItem to discriminated union (FileTaskItem | InlineTaskItem)"
```

---

### Task 2: Adapt TaskFilterService

**Files:**
- Modify: `src/services/task-filter-service.ts`

- [ ] **Step 1: Update imports and produce FileTaskItem with `kind`, `path`, `basename` fields**

In `getTaskTreeItems()`, change the push to:
```typescript
tasks.push({
  kind: "file",
  file,
  path: file.path,
  basename: file.basename,
  parentRaw: fm?.parent,
  frontmatter: fm
});
```

Update the import from `"../models/types"` to import `TaskItem` (unchanged name but now a union).

- [ ] **Step 2: Verify project compiles (this file only)**

Run: `npx tsc --noEmit 2>&1 | grep task-filter-service || echo "OK"`

- [ ] **Step 3: Commit**

```bash
git add src/services/task-filter-service.ts
git commit -m "feat: TaskFilterService produces FileTaskItem with kind/path/basename fields"
```

---

### Task 3: Create InlineTaskParser service

**Files:**
- Create: `src/services/inline-task-parser.ts`

- [ ] **Step 1: Write the inline task parser**

```typescript
import type { App } from "obsidian";
import type { InlineTaskItem } from "../models/types";

/**
 * Priority emoji → numeric rank mapping (Tasks plugin convention).
 * 🔺 = highest (0), ⏫ = high (1), 🔼 = medium (2), 🔽 = low (3), ⏬ = lowest (4)
 */
const PRIORITY_EMOJI_MAP: Record<string, number> = {
  "\u{1F53A}": 0, // 🔺
  "\u23EB": 1,    // ⏫
  "\u{1F53C}": 2, // 🔼
  "\u{1F53D}": 3, // 🔽
  "\u23EC": 4,    // ⏬
};

const PRIORITY_EMOJI_PATTERN = /[\u{1F53A}\u23EB\u{1F53C}\u{1F53D}\u23EC]/gu;

const TASKS_HEADING_RE = /^#{1,2}\s+Tasks\s*$/i;
const UNCHECKED_CHECKBOX_RE = /^(\s*)- \[ \]\s+(.+)$/;
const NEXT_HEADING_RE = /^#{1,2}\s+/;

export function parseInlineTasksForFile(
  parentPath: string,
  content: string
): InlineTaskItem[] {
  const lines = content.split("\n");
  const results: InlineTaskItem[] = [];
  let insideTasksSection = false;
  let tasksHeadingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for Tasks heading
    const headingMatch = TASKS_HEADING_RE.exec(line);
    if (headingMatch) {
      insideTasksSection = true;
      tasksHeadingLevel = line.startsWith("## ") ? 2 : 1;
      continue;
    }

    // Check if we left the Tasks section (another heading of same or higher level)
    if (insideTasksSection && NEXT_HEADING_RE.test(line)) {
      const currentLevel = line.startsWith("## ") ? 2 : 1;
      if (currentLevel <= tasksHeadingLevel) {
        insideTasksSection = false;
      }
      continue;
    }

    if (!insideTasksSection) continue;

    const checkboxMatch = UNCHECKED_CHECKBOX_RE.exec(line);
    if (!checkboxMatch) continue;

    const rawText = checkboxMatch[2].trim();
    const { text, priority } = extractPriority(rawText);
    if (!text) continue;

    results.push({
      kind: "inline",
      path: `${parentPath}#checkbox:${i}`,
      basename: text,
      parentPath,
      text: rawText,
      line: i,
      priority,
    });
  }

  return results;
}

function extractPriority(text: string): { text: string; priority: number | null } {
  let priority: number | null = null;
  const cleaned = text.replace(PRIORITY_EMOJI_PATTERN, (match) => {
    if (priority === null && match in PRIORITY_EMOJI_MAP) {
      priority = PRIORITY_EMOJI_MAP[match];
    }
    return "";
  }).trim();

  return { text: cleaned, priority };
}
```

- [ ] **Step 2: Verify this file compiles**

Run: `npx tsc --noEmit 2>&1 | grep inline-task-parser || echo "OK"`

- [ ] **Step 3: Commit**

```bash
git add src/services/inline-task-parser.ts
git commit -m "feat: add InlineTaskParser service to parse checkbox items from Tasks sections"
```

---

### Task 4: Adapt priority-utils for unified priority access

**Files:**
- Modify: `src/services/priority-utils.ts`

- [ ] **Step 1: Add `getItemPriorityRank` helper**

Add at the end of the file:
```typescript
import type { TaskItem } from "../models/types";

/** Unified priority rank extraction for both file and inline items. */
export function getItemPriorityRank(item: TaskItem): number {
  if (item.kind === "inline") {
    return item.priority ?? 100;
  }
  const raw = item.frontmatter?.priority ?? item.frontmatter?.prio ?? item.frontmatter?.p;
  return getPriorityRankFromValue(raw);
}

/** Exposed for tree builder sort. */
export function getPriorityRankFromValue(value: unknown): number {
  if (value == null) return 100;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return 100;
  if (normalized === "urgent") return 0;
  if (normalized === "high") return 1;
  if (normalized === "medium" || normalized === "med") return 2;
  if (normalized === "low") return 3;
  const pMatch = /^p([0-9]+)$/.exec(normalized);
  if (pMatch?.[1]) return Number.parseInt(pMatch[1], 10);
  const parsed = Number.parseFloat(normalized);
  if (Number.isFinite(parsed)) return Math.max(0, parsed);
  return 100;
}
```

Also refactor the existing private `getPriorityRank` function in `task-tree-builder.ts` to use this shared `getPriorityRankFromValue` (done in Task 5).

- [ ] **Step 2: Add `getItemPriorityBadge` helper**

```typescript
/** Unified priority badge text for both file and inline items. */
export function getItemPriorityBadge(item: TaskItem): string | null {
  if (item.kind === "inline") {
    return item.priority != null ? `p${item.priority}` : null;
  }
  return formatPriorityBadgeText(item.frontmatter?.priority);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/priority-utils.ts
git commit -m "feat: add unified getItemPriorityRank/Badge helpers for both item types"
```

---

### Task 5: Adapt task-tree-builder

**Files:**
- Modify: `src/services/task-tree-builder.ts`

- [ ] **Step 1: Update to use `item.path` instead of `item.file.path`**

Replace all occurrences of `item.file.path` with `item.path` throughout the file.

- [ ] **Step 2: Update parent resolution for inline items**

In the parent resolution loop, add inline handling before the generic call:
```typescript
for (const node of nodesByPath.values()) {
  let parentPath: string | null;
  if (node.item.kind === "inline") {
    parentPath = node.item.parentPath;
  } else {
    parentPath = resolveParentPathFn(node.item.parentRaw, node.item.path);
  }
  if (!parentPath || parentPath === node.path || !nodesByPath.has(parentPath)) continue;
  node.parentPath = parentPath;
  nodesByPath.get(parentPath)?.children.push(node);
}
```

- [ ] **Step 3: Update priority reading to use shared helper**

Import and use `getItemPriorityRank` from priority-utils:
```typescript
import { getItemPriorityRank } from "./priority-utils";
```

Replace `readPriorityValue` + `comparePriorityValues` + `getPriorityRank` with:
```typescript
function compareNodes(
  a: TaskTreeNode,
  b: TaskTreeNode,
  sortMode: OutlineSortMode,
  subtreeLatestByPath: Map<string, number>
): number {
  if (sortMode === "priority") {
    const priorityCmp = getItemPriorityRank(a.item) - getItemPriorityRank(b.item);
    if (priorityCmp !== 0) return priorityCmp;
  }
  // ... rest unchanged (subtree latest, path tiebreak uses node.path which is already correct)
}
```

The tiebreak `a.item.file.path.localeCompare(b.item.file.path)` becomes `a.path.localeCompare(b.path)`.

Remove the now-unused `readPriorityValue`, `comparePriorityValues`, `getPriorityRank` private functions (their logic is now in `priority-utils.ts`).

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: errors only in files not yet adapted (plugin.ts, views, etc.)

- [ ] **Step 5: Commit**

```bash
git add src/services/task-tree-builder.ts
git commit -m "feat: adapt tree builder for discriminated union TaskItem"
```

---

### Task 6: Adapt outline-filter

**Files:**
- Modify: `src/services/outline-filter.ts`

- [ ] **Step 1: Update `taskMatchesFilter` to handle both item types**

```typescript
function taskMatchesFilter(task: TaskItem, tokens: OutlineFilterToken[]): boolean {
  // For inline items, match against the display text and parent path
  const pathText = task.path.toLowerCase();
  const basename = task.basename;
  const fileText = task.kind === "file"
    ? `${task.file.basename} ${task.file.name}`.toLowerCase()
    : basename.toLowerCase();
  const anyText = task.kind === "file"
    ? `${task.file.basename} ${task.file.path}`.toLowerCase()
    : `${basename} ${task.path}`.toLowerCase();

  for (const token of tokens) {
    if (token.key === "prop") {
      // Inline items have no frontmatter — prop filters don't match them
      const fm = task.kind === "file" ? task.frontmatter : undefined;
      const matches = matchesFrontmatterFilter(fm, token.prop, token.value);
      if (token.negated ? matches : !matches) {
        return false;
      }
      continue;
    }

    const matcher = prepareSimpleSearch(token.value.toLowerCase());
    const target = token.key === "path" ? pathText : token.key === "file" ? fileText : anyText;
    const matches = matcher(target) !== null;
    if (token.negated ? matches : !matches) {
      return false;
    }
  }

  return true;
}
```

Update the `matchesFrontmatterFilter` signature — it currently accepts `TaskItem["frontmatter"]` which won't work for the union. Change to `FrontMatterCache | undefined`:

```typescript
export function matchesFrontmatterFilter(
  frontmatter: FrontMatterCache | undefined,
  key: string,
  expectedValue: string | null
): boolean {
  // ... body unchanged
}
```

Add import for `FrontMatterCache` from obsidian, add import for `isFileItem` from types if needed.

- [ ] **Step 2: Commit**

```bash
git add src/services/outline-filter.ts
git commit -m "feat: adapt outline filter for discriminated union TaskItem"
```

---

## Chunk 2: Plugin Integration & Tree Rendering

### Task 7: Plugin — merge inline items into getTaskTreeItems

**Files:**
- Modify: `src/plugin.ts`

- [ ] **Step 1: Add inline task collection method**

Add a new method to collect inline tasks from all concern files:
```typescript
import { parseInlineTasksForFile } from "./services/inline-task-parser";
import type { InlineTaskItem, FileTaskItem } from "./models/types";
import { isFileItem } from "./models/types";
```

Add a method:
```typescript
private async collectInlineTaskItems(fileItems: TaskItem[]): Promise<InlineTaskItem[]> {
  const inlineItems: InlineTaskItem[] = [];
  for (const item of fileItems) {
    if (!isFileItem(item)) continue;
    const content = await this.app.vault.cachedRead(item.file);
    const parsed = parseInlineTasksForFile(item.file.path, content);
    inlineItems.push(...parsed);
  }
  return inlineItems;
}
```

- [ ] **Step 2: Expose merged task items**

Since `cachedRead` is async but `getTaskTreeItems()` is sync, we need to cache inline items. Add a cached field and an invalidation hook:

```typescript
private cachedInlineItems: InlineTaskItem[] = [];
private inlineItemsCacheVersion = -1;
```

Override `getTaskTreeItems()` to merge:
```typescript
getTaskTreeItems(): TaskItem[] {
  return [...this.taskFilterService.getTaskTreeItems(), ...this.cachedInlineItems];
}
```

Add an async method that populates the cache on each structure change:
```typescript
private async refreshInlineTaskCache(): Promise<void> {
  const fileItems = this.taskFilterService.getTaskTreeItems();
  this.cachedInlineItems = [];
  for (const item of fileItems) {
    if (!isFileItem(item)) continue;
    try {
      const content = await this.app.vault.cachedRead(item.file);
      const parsed = parseInlineTasksForFile(item.file.path, content);
      this.cachedInlineItems.push(...parsed);
    } catch {
      // File may have been deleted between filter and read
    }
  }
  this.treeStructureVersion++;
  this.refreshTaskStructureViews();
}
```

Call `refreshInlineTaskCache()` from `handleTaskStructureChange()` (replacing the direct `treeStructureVersion++` and `refreshTaskStructureViews()` that are now inside the async method):
```typescript
private handleTaskStructureChange(): void {
  this.taskFilterService.invalidateCache();
  this.recomputeMacOsTrayRecentConcerns();
  void this.refreshInlineTaskCache();
}
```

- [ ] **Step 3: Fix all `item.file` references in plugin.ts**

Many places in plugin.ts access `item.file` directly. These need guards. Key sites:

- `collectConcernQuickOpenSearchData`: filter to file items only since the modal needs `TFile`:
  ```typescript
  for (const item of concernItems) {
    if (!isFileItem(item)) continue;
    allConcernFiles.push(item.file);
    // ... rest unchanged
  }
  ```

- `openConcernPicker`: filter to file items:
  ```typescript
  const taskFiles = this.getTaskTreeItems().filter(isFileItem).map((item) => item.file);
  ```

- `resetAllConcernPriorities`: filter to file items:
  ```typescript
  const paths = concernItems
    .filter(isFileItem)
    .filter(...)
    .map((item) => item.file.path);
  ```

- `findSingleReferencingConcern`: filter to file items:
  ```typescript
  for (const concern of this.taskFilterService.getTaskTreeItems().filter(isFileItem)) {
  ```

- `buildNoteIdToTaskInfoMap` (if it exists) and any other `item.file` access: add guards.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -40`

- [ ] **Step 5: Commit**

```bash
git add src/plugin.ts
git commit -m "feat: merge inline checkbox items into getTaskTreeItems with caching"
```

---

### Task 8: Adapt concern-tree-panel rendering

**Files:**
- Modify: `src/ui/concern-tree-panel.ts`

- [ ] **Step 1: Update item access to use `.path`/`.basename` and helpers**

Import helpers:
```typescript
import { isFileItem, isInlineItem } from "../models/types";
import { getItemPriorityBadge } from "../services/priority-utils";
```

In `renderControls` — the root selector dropdown iterates `tasks`. Filter to file items only (inline items shouldn't appear as selectable roots):
```typescript
const tasksByName = [...tasks].filter(isFileItem).sort((a, b) =>
  a.basename.localeCompare(b.basename, undefined, { sensitivity: "base" })
);
```

And use `task.path` / `task.basename` for option value/text.

- [ ] **Step 2: Update renderTreeNode for inline items**

In `renderTreeNode`, detect inline items and render them differently:

```typescript
const isInline = isInlineItem(node.item);
const isParentOnly = !ctx.state.matchedPaths.has(node.path);

const li = containerEl.createEl("li", { cls: "fmo-tree-item fmo-tree-panel-tree-item" });
const rowCls = [
  "fmo-tree-row",
  "fmo-tree-panel-tree-row",
  isParentOnly ? "fmo-tree-row-parent" : "",
  isInline ? "fmo-tree-row-inline" : ""
].filter(Boolean).join(" ");

const row = li.createEl("div", { cls: rowCls });
```

For inline items:
- No toggle (they have no children)
- Show a checkbox indicator `☐` before the text
- Click opens parent file instead of the inline path:
```typescript
if (isInline) {
  createTreeToggleSpacer(row);
  row.createEl("span", { cls: "fmo-inline-task-checkbox", text: "\u2610" }); // ☐
  const link = row.createEl("a", {
    cls: "fmo-note-link fmo-note-link-inline",
    text: node.item.basename,
    href: "#"
  });
  link.addEventListener("click", (evt) => {
    evt.preventDefault();
    void this.plugin.openFile(node.item.parentPath);
  });
} else {
  // existing toggle + link logic, using node.item.basename
}
```

Replace `formatPriorityBadgeText(node.item.frontmatter?.priority)` with `getItemPriorityBadge(node.item)`.

For time badge: inline items show nothing (or "—"):
```typescript
if (!isInline) {
  const total = ctx.state.cumulativeSeconds.get(node.path) ?? 0;
  const own = ctx.state.ownSeconds.get(node.path) ?? 0;
  row.createEl("span", {
    cls: "fmo-time-badge",
    text: this.plugin.timeData.formatShortDuration(total),
    attr: { ... }
  });
}
```

- [ ] **Step 3: Update remaining `.file.path` references**

In `getOwnSecondsByPath`, `buildParentPathMap`, `collectScopePaths` — replace `task.file.path` with `task.path`. In `buildParentPathMap`, handle inline items:

```typescript
for (const task of tasks) {
  if (isInlineItem(task)) {
    if (allPaths.has(task.parentPath) && task.parentPath !== task.path) {
      parentByPath.set(task.path, task.parentPath);
    }
    continue;
  }
  const parentPath = resolveParentPath(task.parentRaw, task.path, this.plugin.app.metadataCache);
  if (!parentPath || !allPaths.has(parentPath) || parentPath === task.path) continue;
  parentByPath.set(task.path, parentPath);
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/ui/concern-tree-panel.ts
git commit -m "feat: render inline checkbox items in concern tree panel with dimmed style"
```

---

### Task 9: Adapt outline-view rendering

**Files:**
- Modify: `src/ui/views/outline-view.ts`

- [ ] **Step 1: Update all `item.file.path` → `item.path` references**

Throughout the file, replace:
- `item.file.path` → `item.path`
- `item.file.basename` → `item.basename`
- `node.item.file.basename` → `node.item.basename`
- `node.item.file.path` → `node.item.path`

- [ ] **Step 2: Update renderTreeNode for inline items**

Same pattern as Task 8 Step 2:
- Import `isInlineItem`, `getItemPriorityBadge`
- Add `fmo-tree-row-inline` class for inline items
- Show `☐` checkbox indicator
- Click opens parent file
- Replace `formatPriorityBadgeText(node.item.frontmatter?.priority)` with `getItemPriorityBadge(node.item)`
- Skip time badge for inline items

- [ ] **Step 3: Update `buildParentPathMap`**

Same pattern as Task 8 Step 3.

- [ ] **Step 4: Update `getOwnSecondsByPath`**

For inline items, set 0 seconds:
```typescript
for (const item of tasks) {
  if (isInlineItem(item)) {
    ownSecondsByPath.set(item.path, 0);
    continue;
  }
  ownSecondsByPath.set(item.path, this.plugin.timeData.getTrackedSecondsForRange(item.path, range));
}
```

- [ ] **Step 5: Priority hotkeys — skip inline items**

In `applyHoveredPriority` / `clearHoveredPriority`, inline items can't have frontmatter priority set. The existing `setConcernPriority` already guards on TFile, so this should naturally no-op, but add an early return for inline paths:
```typescript
if (hoveredPath.includes("#checkbox:")) return;
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/views/outline-view.ts
git commit -m "feat: adapt outline view for inline checkbox subtasks"
```

---

### Task 10: Adapt remaining views (timer, canvas, calendar, time-log, timeline)

**Files:**
- Modify: `src/ui/views/timer-view.ts`
- Modify: `src/ui/views/canvas-view.ts`
- Modify: `src/ui/views/calendar-view.ts`
- Modify: `src/ui/views/time-log-view.ts`
- Modify: `src/ui/views/timeline-view.ts`

These views only use file-based items. Add `isFileItem` filter where they access `item.file`.

- [ ] **Step 1: timer-view.ts**

`node.item.file.basename` → `node.item.basename`
`node.item.file.path` → `node.item.path`

(Timer view renders tree nodes from buildTaskTree. Since inline items are in the tree, the node rendering needs the same guards. However, timer view only shows the selected concern's tree. If the selected concern has inline children, they'd appear. Apply the same inline-aware rendering: use `node.item.basename`/`node.item.path`, skip timer controls for inline items.)

- [ ] **Step 2: canvas-view.ts**

Replace `task.file.path` with `task.path` throughout.
In places that need TFile (e.g., computing tracked seconds), the path-based lookup should still work since `timeData.getTrackedSeconds` takes a path string.

- [ ] **Step 3: calendar-view.ts**

In `getEntriesForPath` usage and task mapping, filter to file items:
```typescript
const fileTasks = tasks.filter(isFileItem);
```
Then use `fileTasks` for calendar-specific logic. Replace remaining `task.file.path` → `task.path`, `task.file.basename` → `task.basename`.

- [ ] **Step 4: time-log-view.ts**

Filter to file items:
```typescript
const tasks = this.plugin.getTaskTreeItems().filter(isFileItem).map((item) => item.file);
```

- [ ] **Step 5: timeline-view.ts**

Filter to file items (timeline only shows `kind: project` concerns):
```typescript
// Already filters by frontmatter kind=project, so inline items (no frontmatter) are excluded.
// But update task.file access:
if (!isFileItem(task)) continue;
results.push({ file: task.file, segments });
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/views/timer-view.ts src/ui/views/canvas-view.ts src/ui/views/calendar-view.ts src/ui/views/time-log-view.ts src/ui/views/timeline-view.ts
git commit -m "feat: adapt remaining views for discriminated union TaskItem"
```

---

### Task 11: Adapt sub-concerns extension

**Files:**
- Modify: `src/ui/editor/sub-concerns-extension.ts`

- [ ] **Step 1: Filter to file items in `getDirectChildren`**

```typescript
import { isFileItem } from "../../models/types";

function getDirectChildren(plugin: LifeDashboardPlugin, parentPath: string): ChildInfo[] {
  const items = plugin.getTaskTreeItems();
  const children: ChildInfo[] = [];

  for (const item of items) {
    if (!isFileItem(item)) continue;
    if (item.file.path === parentPath) continue;
    const resolved = resolveParentPath(item.parentRaw, item.file.path, plugin.app.metadataCache);
    if (resolved === parentPath) {
      children.push({ name: item.file.basename, path: item.file.path, mtime: item.file.stat.mtime });
    }
  }

  children.sort((a, b) => b.mtime - a.mtime);
  return children;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/editor/sub-concerns-extension.ts
git commit -m "feat: filter sub-concerns extension to file items only"
```

---

## Chunk 3: Editor Extension & Promotion Flow

### Task 12: Create checkbox promote editor extension

**Files:**
- Create: `src/ui/editor/checkbox-promote-extension.ts`

- [ ] **Step 1: Write the CodeMirror extension**

```typescript
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from "@codemirror/view";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension
} from "@codemirror/state";
import { editorInfoField } from "obsidian";
import type LifeDashboardPlugin from "../../plugin";

const TASKS_HEADING_RE = /^#{1,2}\s+Tasks\s*$/i;
const UNCHECKED_CHECKBOX_RE = /^(\s*)- \[ \]\s+(.+)$/;
const NEXT_HEADING_RE = /^#{1,2}\s+/;

const rebuildPromoteEffect = StateEffect.define<null>();

class PromoteButtonWidget extends WidgetType {
  constructor(
    private readonly line: number,
    private readonly plugin: LifeDashboardPlugin
  ) {
    super();
  }

  eq(other: PromoteButtonWidget): boolean {
    return this.line === other.line;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "fmo-promote-checkbox-btn";
    btn.textContent = "\u2197"; // ↗
    btn.title = "Promote to concern note";
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const filePath = this.plugin.app.workspace.getActiveFile()?.path;
      if (filePath) {
        void this.plugin.promoteCheckboxToConcern(filePath, this.line);
      }
    });
    return btn;
  }

  get estimatedHeight(): number {
    return -1; // inline widget, no height
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export function createCheckboxPromoteExtension(plugin: LifeDashboardPlugin): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildPromoteDecorations(state, plugin);
    },
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(rebuildPromoteEffect))) {
        return buildPromoteDecorations(tr.state, plugin);
      }
      return value;
    },
    provide(field) {
      return EditorView.decorations.from(field);
    }
  });

  const watcher = ViewPlugin.fromClass(
    class {
      private lastFilePath: string | null = null;

      constructor(view: EditorView) {
        this.lastFilePath = view.state.field(editorInfoField, false)?.file?.path ?? null;
      }

      update(update: ViewUpdate) {
        const filePath = update.state.field(editorInfoField, false)?.file?.path ?? null;
        if (filePath !== this.lastFilePath) {
          this.lastFilePath = filePath;
          const view = update.view;
          requestAnimationFrame(() =>
            view.dispatch({ effects: rebuildPromoteEffect.of(null) })
          );
        }
      }
    }
  );

  return [field, watcher];
}

function buildPromoteDecorations(
  state: EditorState,
  plugin: LifeDashboardPlugin
): DecorationSet {
  const filePath = state.field(editorInfoField, false)?.file?.path ?? null;
  if (!filePath) return Decoration.none;

  // Only decorate concern files
  const file = plugin.app.vault.getAbstractFileByPath(filePath);
  if (!file) return Decoration.none;

  const items = plugin.getTaskTreeItems();
  const isConcern = items.some(
    (item) => item.kind === "file" && item.path === filePath
  );
  if (!isConcern) return Decoration.none;

  const doc = state.doc;
  const decorations: ReturnType<typeof Decoration.widget>[] = [];
  let insideTasksSection = false;
  let tasksHeadingLevel = 0;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    const headingMatch = TASKS_HEADING_RE.exec(text);
    if (headingMatch) {
      insideTasksSection = true;
      tasksHeadingLevel = text.startsWith("## ") ? 2 : 1;
      continue;
    }

    if (insideTasksSection && NEXT_HEADING_RE.test(text)) {
      const currentLevel = text.startsWith("## ") ? 2 : 1;
      if (currentLevel <= tasksHeadingLevel) {
        insideTasksSection = false;
      }
      continue;
    }

    if (!insideTasksSection) continue;
    if (!UNCHECKED_CHECKBOX_RE.test(text)) continue;

    decorations.push(
      Decoration.widget({
        widget: new PromoteButtonWidget(i - 1, plugin), // 0-based line
        side: 1 // after the line content
      }).range(line.to)
    );
  }

  return Decoration.set(decorations);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/editor/checkbox-promote-extension.ts
git commit -m "feat: add CodeMirror extension for checkbox promote button"
```

---

### Task 13: Promotion flow in plugin.ts

**Files:**
- Modify: `src/plugin.ts`

- [ ] **Step 1: Register the promote extension**

Import and register:
```typescript
import { createCheckboxPromoteExtension } from "./ui/editor/checkbox-promote-extension";
```

In `onload()`, after the existing `createSubConcernsExtension` registration:
```typescript
this.registerEditorExtension(createCheckboxPromoteExtension(this));
```

- [ ] **Step 2: Add filename sanitization helper**

```typescript
private sanitizeFileName(text: string): string {
  // Replace characters not allowed in filenames on Windows/macOS/Linux
  // Forbidden: \ / : * ? " < > |
  // Also replace control characters and leading/trailing dots/spaces
  return text
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\x00-\x1F\x7F]/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .replace(/-{2,}/g, "-")
    || "untitled";
}
```

- [ ] **Step 3: Add `promoteCheckboxToConcern` method**

```typescript
async promoteCheckboxToConcern(filePath: string, line: number): Promise<void> {
  const file = this.app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return;

  const content = await this.app.vault.read(file);
  const lines = content.split("\n");
  const lineText = lines[line];
  if (!lineText) return;

  const match = /^(\s*)- \[ \]\s+(.+)$/.exec(lineText);
  if (!match) return;

  const indent = match[1];
  const rawText = match[2].trim();
  // Strip priority emojis for the name
  const cleanText = rawText.replace(/[\u{1F53A}\u23EB\u{1F53C}\u{1F53D}\u23EC]/gu, "").trim();
  const safeName = this.sanitizeFileName(cleanText);

  this.openConcernPicker({
    placeholder: "Select parent for the new concern...",
    onChoose: (parentFile: TFile) => {
      void this.doPromoteCheckbox(file, line, indent, safeName, parentFile);
    }
  });
}

private async doPromoteCheckbox(
  sourceFile: TFile,
  line: number,
  indent: string,
  safeName: string,
  parentFile: TFile
): Promise<void> {
  const parentName = parentFile.basename;
  const parentDir = parentFile.parent?.path ?? "";
  const propName = this.settings.propertyName.trim() || "type";
  const propValue = this.settings.propertyValue.trim() || "concen";

  const dir = parentDir ? `${parentDir}/` : "";
  let fileName = safeName;
  let newPath = normalizePath(`${dir}${fileName}.md`);

  let counter = 1;
  while (this.app.vault.getAbstractFileByPath(newPath)) {
    fileName = `${safeName} ${counter}`;
    newPath = normalizePath(`${dir}${fileName}.md`);
    counter++;
  }

  const id = this.generateConcernId();
  const frontmatter = [
    "---",
    `${propName}: ${propValue}`,
    `parent: "[[${parentName}]]"`,
    "kind: task",
    `id: "${id}"`,
    "---",
    ""
  ].join("\n");

  try {
    await this.app.vault.create(newPath, frontmatter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`Failed to create concern: ${message}`);
    return;
  }

  // Replace the checkbox line with a wikilink
  const content = await this.app.vault.read(sourceFile);
  const lines = content.split("\n");
  lines[line] = `${indent}- [[${fileName}]]`;
  await this.app.vault.modify(sourceFile, lines.join("\n"));

  await this.openFile(newPath);
}
```

- [ ] **Step 3: Expose `generateConcernId` as package-private**

Change `private generateConcernId()` → keep as `private` (it's only called from within plugin.ts, and `promoteCheckboxToConcern` is also in plugin.ts).

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: clean (or only warnings)

- [ ] **Step 5: Commit**

```bash
git add src/plugin.ts
git commit -m "feat: add checkbox promotion flow — picker, note creation, line replacement"
```

---

### Task 14: CSS styles

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add styles for inline task rows and promote button**

Append to `styles.css`:

```css
/* ── Inline checkbox subtasks in tree ─────────────────────────── */

.fmo-tree-row-inline {
  opacity: 0.7;
}

.fmo-tree-row-inline:hover {
  opacity: 1;
}

.fmo-inline-task-checkbox {
  margin-inline-end: 4px;
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
}

.fmo-note-link-inline {
  font-style: italic;
}

/* ── Promote button (editor decoration) ──────────────────────── */

.fmo-promote-checkbox-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-inline-start: 6px;
  padding: 0;
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  background: var(--background-primary);
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  vertical-align: middle;
  line-height: 1;
  opacity: 0.5;
  transition: opacity 120ms ease;
}

.fmo-promote-checkbox-btn:hover {
  opacity: 1;
  color: var(--text-normal);
  background: var(--background-secondary);
}
```

- [ ] **Step 2: Commit**

```bash
git add styles.css
git commit -m "style: add CSS for inline task rows and promote button"
```

---

### Task 15: Build verification

- [ ] **Step 1: Full build**

Run: `npm run build` (or `npx tsc --noEmit && node esbuild.config.mjs production`)
Expected: clean build, no errors

- [ ] **Step 2: If errors, fix and commit individually**

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve build errors from inline checkbox subtasks feature"
```

---

## Summary of priority emoji mapping

| Emoji | Tasks Plugin Level | Our Rank | Badge |
|-------|-------------------|----------|-------|
| 🔺    | Highest           | 0        | p0    |
| ⏫    | High              | 1        | p1    |
| 🔼    | Medium            | 2        | p2    |
| 🔽    | Low               | 3        | p3    |
| ⏬    | Lowest            | 4        | p4    |

## Summary of conversion flow

1. User sees `↗` button at end of `- [ ] text` line in editor (only in `# Tasks` / `## Tasks` sections of concern notes)
2. Clicks button → standard concern picker opens ("Select parent for the new concern...")
3. User picks parent concern
4. Plugin creates `<sanitized-text>.md` in parent's directory with frontmatter `kind: task`
5. Original line `- [ ] text` is replaced with `- [[sanitized-text]]`
6. New note opens in editor
