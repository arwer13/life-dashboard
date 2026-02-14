# Calendar View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an adaptive calendar view showing time spent on concerns, with day timeline (Today) and week grid (This Week) layouts plus a summary table.

**Architecture:** New `LifeDashboardCalendarView` class extending `LifeDashboardBaseView` in the existing view file. Reuses `plugin.timeEntriesById`, `plugin.getWindowForRange()`, and `plugin.getEntriesForPath()` (needs to become public). Period toggle switches between day timeline and week grid rendering. CSS added to `styles.css`.

**Tech Stack:** TypeScript, Obsidian API (ItemView, DOM manipulation), CSS

---

### Task 1: Expose getEntriesForPath and getWindowForRange as public

**Files:**
- Modify: `src/plugin.ts:562-569` (getEntriesForPath) and `src/plugin.ts:584-614` (getWindowForRange)

**Step 1: Make getEntriesForPath public**

Change line 562 from:
```typescript
  private getEntriesForPath(path: string): TimeLogEntry[] {
```
to:
```typescript
  getEntriesForPath(path: string): TimeLogEntry[] {
```

**Step 2: Make getWindowForRange public**

Change line 584 from:
```typescript
  private getWindowForRange(range: Exclude<OutlineTimeRange, "all">, now: Date): TimeWindow {
```
to:
```typescript
  getWindowForRange(range: Exclude<OutlineTimeRange, "all">, now: Date): TimeWindow {
```

**Step 3: Export TimeWindow type**

Change line 24 from:
```typescript
type TimeWindow = { startMs: number; endMs: number };
```
to:
```typescript
export type TimeWindow = { startMs: number; endMs: number };
```

**Step 4: Make getDayStart and getWeekStart public**

Change `private getDayStart` (line 643) and `private getWeekStart` (line 634) to public.

**Step 5: Build and verify no errors**

Run: `npm run build`
Expected: Build succeeds with no errors.

**Step 6: Commit**

```bash
git add src/plugin.ts
git commit -m "feat: expose time entry methods for calendar view"
```

---

### Task 2: Add VIEW_TYPE constant, class skeleton, and register the view

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (add constant + class)
- Modify: `src/plugin.ts` (register view, add command)
- Modify: `src/services/dashboard-view-controller.ts` (add to ALL_VIEW_TYPES, add activateCalendarView)

**Step 1: Add view type constant and empty class**

In `src/ui/life-dashboard-view.ts`, after line 18 (the canvas constant), add:
```typescript
export const VIEW_TYPE_LIFE_DASHBOARD_CALENDAR = "life-dashboard-calendar-view";
```

At the end of the file, add the class skeleton:
```typescript
type CalendarPeriod = "today" | "week";

export class LifeDashboardCalendarView extends LifeDashboardBaseView {
  private period: CalendarPeriod = "today";

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_CALENDAR;
  }

  getDisplayText(): string {
    return "Time Calendar";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");
    contentEl.createEl("div", { text: "Calendar view placeholder" });
  }
}
```

**Step 2: Register the view in plugin.ts**

In `src/plugin.ts`, import the new constant and class, then after the canvas registerView (line 75), add:
```typescript
this.registerView(VIEW_TYPE_LIFE_DASHBOARD_CALENDAR, (leaf) => new LifeDashboardCalendarView(leaf, this));
```

Add the command after the outline command block (after line 111):
```typescript
this.addCommand({
  id: "open-calendar",
  name: "Open Time Calendar",
  callback: () => {
    void this.viewController.activateCalendarView();
  }
});
```

**Step 3: Update DashboardViewController**

In `src/services/dashboard-view-controller.ts`:
- Import `VIEW_TYPE_LIFE_DASHBOARD_CALENDAR`
- Add it to `ALL_VIEW_TYPES` array (line 63)
- Add `activateCalendarView` method:
```typescript
async activateCalendarView(): Promise<void> {
  await this.openAndRevealView(VIEW_TYPE_LIFE_DASHBOARD_CALENDAR, "tab");
}
```
- In `activateView()`, after the canvas leaf block (after line 43), add:
```typescript
const calendarLeaf = await this.ensureViewLeaf(
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  false,
  false,
  "tab"
);
if (calendarLeaf) {
  this.app.workspace.revealLeaf(calendarLeaf);
}
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add src/ui/life-dashboard-view.ts src/plugin.ts src/services/dashboard-view-controller.ts
git commit -m "feat: register calendar view skeleton with command"
```

---

### Task 3: Implement the calendar view render method with period toggle and data gathering

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (the `LifeDashboardCalendarView` class)

**Step 1: Add imports and color palette**

At the top of the calendar view class area, add the color palette constant:
```typescript
const CALENDAR_COLORS = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
  "#9c755f", "#bab0ac"
];
```

**Step 2: Replace the render method with full implementation**

Replace the `render()` method with:
```typescript
async render(): Promise<void> {
  const { contentEl } = this;
  contentEl.empty();
  contentEl.addClass("frontmatter-outline-view");

  // Header with period toggle
  const header = contentEl.createEl("div", { cls: "fmo-header" });
  const headerTop = header.createEl("div", { cls: "fmo-header-top" });
  headerTop.createEl("h3", { text: "Time Calendar" });

  const rangeRow = header.createEl("div", { cls: "fmo-outline-range-row" });
  for (const option of [
    { value: "today" as CalendarPeriod, label: "Today" },
    { value: "week" as CalendarPeriod, label: "This Week" }
  ]) {
    const button = rangeRow.createEl("button", {
      cls: this.period === option.value
        ? "fmo-outline-range-btn fmo-outline-range-btn-active"
        : "fmo-outline-range-btn",
      text: option.label,
      attr: { type: "button" }
    });
    button.addEventListener("click", () => {
      if (this.period === option.value) return;
      this.period = option.value;
      void this.render();
    });
  }

  // Gather data
  const entries = this.gatherCalendarEntries();
  const body = contentEl.createEl("div", { cls: "fmo-calendar-body" });

  if (entries.length === 0) {
    body.createEl("p", { cls: "fmo-empty", text: "No tracked time in this period." });
    return;
  }

  // Assign colors
  const colorMap = this.buildColorMap(entries);

  // Render timeline or grid
  if (this.period === "today") {
    this.renderDayTimeline(body, entries, colorMap);
  } else {
    this.renderWeekGrid(body, entries, colorMap);
  }

  // Summary table
  this.renderSummaryTable(body, entries, colorMap);
}
```

**Step 3: Add gatherCalendarEntries method**

This method collects all time entries for all concerns in the current period:
```typescript
private gatherCalendarEntries(): Array<{
  path: string;
  basename: string;
  entry: TimeLogEntry;
}> {
  const now = new Date();
  const range = this.period === "today" ? "today" : "week";
  const window = this.plugin.getWindowForRange(range, now);
  const tasks = this.plugin.getTaskTreeItems();
  const result: Array<{ path: string; basename: string; entry: TimeLogEntry }> = [];

  for (const task of tasks) {
    const entries = this.plugin.getEntriesForPath(task.file.path);
    for (const entry of entries) {
      if (entry.startMs >= window.startMs && entry.startMs < window.endMs) {
        result.push({
          path: task.file.path,
          basename: task.file.basename,
          entry
        });
      }
    }
  }

  return result.sort((a, b) => a.entry.startMs - b.entry.startMs);
}
```

**Step 4: Add buildColorMap method**

```typescript
private buildColorMap(
  entries: Array<{ path: string; basename: string }>
): Map<string, { color: string; basename: string }> {
  const uniquePaths = [...new Set(entries.map((e) => e.path))];
  const sorted = uniquePaths
    .map((path) => ({
      path,
      basename: entries.find((e) => e.path === path)?.basename ?? ""
    }))
    .sort((a, b) => a.basename.localeCompare(b.basename));

  const colorMap = new Map<string, { color: string; basename: string }>();
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    colorMap.set(item.path, {
      color: CALENDAR_COLORS[i % CALENDAR_COLORS.length],
      basename: item.basename
    });
  }
  return colorMap;
}
```

**Step 5: Build and verify**

Run: `npm run build`
Expected: Build succeeds (renderDayTimeline, renderWeekGrid, renderSummaryTable are not yet implemented — add stubs that create placeholder divs).

Add stubs:
```typescript
private renderDayTimeline(
  container: HTMLElement,
  entries: Array<{ path: string; basename: string; entry: TimeLogEntry }>,
  colorMap: Map<string, { color: string; basename: string }>
): void {
  container.createEl("div", { text: "Day timeline placeholder" });
}

private renderWeekGrid(
  container: HTMLElement,
  entries: Array<{ path: string; basename: string; entry: TimeLogEntry }>,
  colorMap: Map<string, { color: string; basename: string }>
): void {
  container.createEl("div", { text: "Week grid placeholder" });
}

private renderSummaryTable(
  container: HTMLElement,
  entries: Array<{ path: string; basename: string; entry: TimeLogEntry }>,
  colorMap: Map<string, { color: string; basename: string }>
): void {
  container.createEl("div", { text: "Summary table placeholder" });
}
```

**Step 6: Commit**

```bash
git add src/ui/life-dashboard-view.ts
git commit -m "feat: calendar view data gathering and period toggle"
```

---

### Task 4: Implement renderDayTimeline

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (replace renderDayTimeline stub)

**Step 1: Replace renderDayTimeline with full implementation**

```typescript
private renderDayTimeline(
  container: HTMLElement,
  entries: Array<{ path: string; basename: string; entry: TimeLogEntry }>,
  colorMap: Map<string, { color: string; basename: string }>
): void {
  // Find the active hour range (crop to entries, with 1h padding)
  const minStartMs = Math.min(...entries.map((e) => e.entry.startMs));
  const maxEndMs = Math.max(
    ...entries.map((e) => e.entry.startMs + e.entry.durationMinutes * 60 * 1000)
  );
  const minHour = Math.max(0, new Date(minStartMs).getHours() - 1);
  const maxHour = Math.min(23, new Date(maxEndMs).getHours() + 1);
  const hourCount = maxHour - minHour + 1;

  const HOUR_HEIGHT = 60; // px per hour
  const timelineHeight = hourCount * HOUR_HEIGHT;

  const timeline = container.createEl("div", { cls: "fmo-cal-timeline" });
  timeline.style.height = `${timelineHeight}px`;
  timeline.style.position = "relative";

  // Hour labels and gridlines
  for (let h = minHour; h <= maxHour; h++) {
    const y = (h - minHour) * HOUR_HEIGHT;
    const label = timeline.createEl("div", { cls: "fmo-cal-hour-label" });
    label.style.top = `${y}px`;
    label.setText(`${String(h).padStart(2, "0")}:00`);

    const line = timeline.createEl("div", { cls: "fmo-cal-hour-line" });
    line.style.top = `${y}px`;
  }

  // Day start timestamp for computing positions
  const now = new Date();
  const dayStart = this.plugin.getDayStart(now).getTime();

  // Entry blocks
  for (const item of entries) {
    const startDate = new Date(item.entry.startMs);
    const startHourFraction =
      (item.entry.startMs - dayStart) / (60 * 60 * 1000);
    const durationHours = item.entry.durationMinutes / 60;

    const top = (startHourFraction - minHour) * HOUR_HEIGHT;
    const height = Math.max(durationHours * HOUR_HEIGHT, 4); // minimum 4px visibility

    const info = colorMap.get(item.path);
    const block = timeline.createEl("div", { cls: "fmo-cal-block" });
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.style.backgroundColor = info?.color ?? CALENDAR_COLORS[0];

    const pad = (n: number): string => String(n).padStart(2, "0");
    const startLabel = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
    const durationLabel = this.plugin.formatShortDuration(item.entry.durationMinutes * 60);

    block.createEl("span", {
      cls: "fmo-cal-block-label",
      text: `${info?.basename ?? "?"} ${startLabel} (${durationLabel})`
    });

    block.addEventListener("click", () => {
      void this.plugin.openFile(item.path);
    });
  }
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/ui/life-dashboard-view.ts
git commit -m "feat: calendar day timeline rendering"
```

---

### Task 5: Implement renderWeekGrid

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (replace renderWeekGrid stub)

**Step 1: Replace renderWeekGrid with full implementation**

```typescript
private renderWeekGrid(
  container: HTMLElement,
  entries: Array<{ path: string; basename: string; entry: TimeLogEntry }>,
  colorMap: Map<string, { color: string; basename: string }>
): void {
  const now = new Date();
  const weekStart = this.plugin.getWeekStart(now);

  // Build 7-day array
  const days: Array<{ date: Date; label: string; dayEntries: typeof entries }> = [];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    const date = new Date(weekStart.getTime() + d * 24 * 60 * 60 * 1000);
    const dayStart = date.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const dayEntries = entries.filter(
      (e) => e.entry.startMs >= dayStart && e.entry.startMs < dayEnd
    );
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const pad = (n: number): string => String(n).padStart(2, "0");
    days.push({
      date,
      label: `${dayNames[date.getDay()]} ${pad(date.getDate())}${isToday ? " *" : ""}`,
      dayEntries
    });
  }

  // Find max total for scaling
  const dayTotals = days.map((day) =>
    day.dayEntries.reduce((sum, e) => sum + e.entry.durationMinutes, 0)
  );
  const maxMinutes = Math.max(...dayTotals, 1);

  const BAR_MAX_HEIGHT = 200; // px
  const grid = container.createEl("div", { cls: "fmo-cal-week-grid" });

  for (let d = 0; d < 7; d++) {
    const day = days[d];
    const col = grid.createEl("div", { cls: "fmo-cal-week-col" });

    col.createEl("div", { cls: "fmo-cal-week-day-label", text: day.label });

    const barContainer = col.createEl("div", { cls: "fmo-cal-week-bar-container" });
    barContainer.style.height = `${BAR_MAX_HEIGHT}px`;

    // Group by concern path
    const byPath = new Map<string, number>();
    for (const e of day.dayEntries) {
      byPath.set(e.path, (byPath.get(e.path) ?? 0) + e.entry.durationMinutes);
    }

    // Stack segments from bottom, sorted by basename
    const segments = [...byPath.entries()]
      .map(([path, minutes]) => ({
        path,
        minutes,
        info: colorMap.get(path)
      }))
      .sort((a, b) => (a.info?.basename ?? "").localeCompare(b.info?.basename ?? ""));

    let bottomOffset = 0;
    for (const seg of segments) {
      const height = (seg.minutes / maxMinutes) * BAR_MAX_HEIGHT;
      const segment = barContainer.createEl("div", { cls: "fmo-cal-week-segment" });
      segment.style.position = "absolute";
      segment.style.bottom = `${bottomOffset}px`;
      segment.style.height = `${Math.max(height, 2)}px`;
      segment.style.backgroundColor = seg.info?.color ?? CALENDAR_COLORS[0];
      segment.style.left = "0";
      segment.style.right = "0";
      segment.style.borderRadius = "3px";
      segment.setAttribute(
        "title",
        `${seg.info?.basename ?? "?"}: ${this.plugin.formatShortDuration(seg.minutes * 60)}`
      );
      segment.addEventListener("click", () => {
        void this.plugin.openFile(seg.path);
      });
      bottomOffset += height;
    }

    const totalMinutes = dayTotals[d];
    col.createEl("div", {
      cls: "fmo-cal-week-total",
      text: totalMinutes > 0 ? this.plugin.formatShortDuration(totalMinutes * 60) : "-"
    });
  }
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/ui/life-dashboard-view.ts
git commit -m "feat: calendar week grid rendering"
```

---

### Task 6: Implement renderSummaryTable

**Files:**
- Modify: `src/ui/life-dashboard-view.ts` (replace renderSummaryTable stub)

**Step 1: Replace renderSummaryTable with full implementation**

```typescript
private renderSummaryTable(
  container: HTMLElement,
  entries: Array<{ path: string; basename: string; entry: TimeLogEntry }>,
  colorMap: Map<string, { color: string; basename: string }>
): void {
  const byPath = new Map<string, number>();
  for (const e of entries) {
    byPath.set(e.path, (byPath.get(e.path) ?? 0) + e.entry.durationMinutes * 60);
  }

  const sorted = [...byPath.entries()]
    .map(([path, seconds]) => ({ path, seconds, info: colorMap.get(path) }))
    .sort((a, b) => b.seconds - a.seconds);

  const totalSeconds = sorted.reduce((sum, item) => sum + item.seconds, 0);

  const table = container.createEl("div", { cls: "fmo-cal-summary" });
  table.createEl("div", { cls: "fmo-cal-summary-title", text: "Summary" });

  for (const item of sorted) {
    const row = table.createEl("div", { cls: "fmo-cal-summary-row" });

    const dot = row.createEl("span", { cls: "fmo-cal-summary-dot" });
    dot.style.backgroundColor = item.info?.color ?? CALENDAR_COLORS[0];

    const link = row.createEl("a", {
      cls: "fmo-note-link fmo-cal-summary-name",
      text: item.info?.basename ?? "?",
      href: "#"
    });
    link.addEventListener("click", (evt) => {
      evt.preventDefault();
      void this.plugin.openFile(item.path);
    });

    row.createEl("span", {
      cls: "fmo-cal-summary-duration",
      text: this.plugin.formatShortDuration(item.seconds)
    });
  }

  const totalRow = table.createEl("div", { cls: "fmo-cal-summary-row fmo-cal-summary-total" });
  totalRow.createEl("span", { cls: "fmo-cal-summary-dot" });
  totalRow.createEl("span", { cls: "fmo-cal-summary-name", text: "Total" });
  totalRow.createEl("span", {
    cls: "fmo-cal-summary-duration",
    text: this.plugin.formatShortDuration(totalSeconds)
  });
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/ui/life-dashboard-view.ts
git commit -m "feat: calendar summary table"
```

---

### Task 7: Add CSS styles for the calendar view

**Files:**
- Modify: `styles.css`

**Step 1: Add all calendar CSS at the end of styles.css**

```css
/* Calendar view: day timeline */
.frontmatter-outline-view .fmo-calendar-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.frontmatter-outline-view .fmo-cal-timeline {
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  background: var(--background-primary-alt);
  overflow: hidden;
  margin-left: 52px;
}

.frontmatter-outline-view .fmo-cal-hour-label {
  position: absolute;
  left: -52px;
  width: 44px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  line-height: 1;
  transform: translateY(-6px);
  user-select: none;
}

.frontmatter-outline-view .fmo-cal-hour-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--background-modifier-border);
}

.frontmatter-outline-view .fmo-cal-block {
  position: absolute;
  left: 4px;
  right: 4px;
  border-radius: 4px;
  padding: 2px 6px;
  overflow: hidden;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s;
  z-index: 1;
}

.frontmatter-outline-view .fmo-cal-block:hover {
  opacity: 1;
  z-index: 2;
}

.frontmatter-outline-view .fmo-cal-block-label {
  font-size: 11px;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

/* Calendar view: week grid */
.frontmatter-outline-view .fmo-cal-week-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  padding: 10px;
  background: var(--background-primary-alt);
}

.frontmatter-outline-view .fmo-cal-week-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.frontmatter-outline-view .fmo-cal-week-day-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-align: center;
  white-space: nowrap;
}

.frontmatter-outline-view .fmo-cal-week-bar-container {
  position: relative;
  width: 100%;
  min-width: 24px;
}

.frontmatter-outline-view .fmo-cal-week-segment {
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s;
}

.frontmatter-outline-view .fmo-cal-week-segment:hover {
  opacity: 1;
}

.frontmatter-outline-view .fmo-cal-week-total {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

/* Calendar view: summary table */
.frontmatter-outline-view .fmo-cal-summary {
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  padding: 10px;
  background: var(--background-primary-alt);
}

.frontmatter-outline-view .fmo-cal-summary-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.frontmatter-outline-view .fmo-cal-summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.frontmatter-outline-view .fmo-cal-summary-dot {
  width: 10px;
  height: 10px;
  min-width: 10px;
  border-radius: 50%;
  display: inline-block;
}

.frontmatter-outline-view .fmo-cal-summary-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.frontmatter-outline-view .fmo-cal-summary-duration {
  margin-left: auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-accent);
}

.frontmatter-outline-view .fmo-cal-summary-total {
  border-top: 1px solid var(--background-modifier-border);
  margin-top: 4px;
  padding-top: 6px;
  font-weight: 600;
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: calendar view CSS styles"
```

---

### Task 8: Import cleanup and final build verification

**Files:**
- Modify: `src/plugin.ts` (verify imports)
- Modify: `src/ui/life-dashboard-view.ts` (verify imports)

**Step 1: Verify all imports are correct**

In `src/plugin.ts`, ensure `LifeDashboardCalendarView` and `VIEW_TYPE_LIFE_DASHBOARD_CALENDAR` are imported from `./ui/life-dashboard-view`.

In `src/ui/life-dashboard-view.ts`, ensure `TimeLogEntry` is imported from `../models/types` (already imported) and `TimeWindow` type is imported from `../plugin` if needed (or use the plugin methods directly).

**Step 2: Full build**

Run: `npm run build`
Expected: Build succeeds with no errors, no warnings.

**Step 3: Commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: import cleanup for calendar view"
```
