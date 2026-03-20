import type { WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS } from "../../models/view-types";
import type {
  SupplementsSnapshot,
  SupplementLogDay,
  SupplementDef
} from "../../services/supplements-tracking-service";
import {
  toDateKey,
  buildYearWeeks,
  getMonthStartWeekIndex,
  MONTH_ABBREVIATIONS
} from "../../services/year-grid-utils";
import type LifeDashboardPlugin from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";

type DayCell = {
  date: string;
  taken: string[];
  takenRaw: string[];
  hue: number;
};

type IngredientGroup = {
  ingredient: string;
  keys: string[];
  children: Array<{ key: string; label: string }>;
};

/** Maximum hue rotation (degrees) when the supplement set fully changes between days. */
const HUE_STEP_MAX_DEGREES = 50;
const HUE_START = 210;
const DOSE_SUFFIX_RE = /^@([\d.]+)\s*[a-zA-Z]*\*(\d+)$/;

export class LifeDashboardSupplementsView extends LifeDashboardBaseView {
  private currentYear = new Date().getFullYear();
  private cellElements = new Map<string, HTMLElement>();
  private logKeyElements: HTMLElement[] = [];
  private logLineElements = new Map<string, HTMLElement>();
  private highlightedLogLine: HTMLElement | null = null;
  private scrollRafId: number | null = null;
  private dayCells = new Map<string, DayCell>();
  private definitions = new Map<string, SupplementDef>();
  private gridWrapper: HTMLElement | null = null;
  private logWrapper: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS;
  }

  getDisplayText(): string {
    return "Supplements grid";
  }

  getIcon(): string {
    return "pill";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.cellElements.clear();
    this.logKeyElements = [];
    this.logLineElements.clear();
    this.highlightedLogLine = null;
    if (this.scrollRafId !== null) cancelAnimationFrame(this.scrollRafId);
    this.scrollRafId = null;
    this.dayCells.clear();
    this.definitions.clear();
    this.gridWrapper = null;
    this.logWrapper = null;
  }

  async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    this.gridWrapper = null;
    container.addClass("fmo-supplements-view");

    await this.plugin.ensureSupplementsLoaded();
    const snapshot = this.plugin.getSupplementsSnapshot();

    if (snapshot.log.length === 0) {
      container.createDiv({
        cls: "fmo-empty",
        text: `No supplement data found in ${this.plugin.settings.supplementsFilePath}`
      });
      return;
    }

    this.renderYearNav(container);
    this.definitions = snapshot.definitions;
    this.dayCells = this.computeDayCells(snapshot);

    const layout = container.createDiv({ cls: "fmo-supplements-layout" });

    const sidebar = layout.createDiv({ cls: "fmo-supplements-sidebar" });
    const groups = this.buildIngredientGroups(this.definitions);
    this.renderIngredientTree(sidebar, groups);

    this.gridWrapper = layout.createDiv({ cls: "fmo-supplements-year-wrapper" });
    this.renderYearGrid(this.gridWrapper);

    this.renderRawLog(container);
  }

  private renderYearNav(container: HTMLElement): void {
    const nav = container.createDiv({ cls: "fmo-supplements-year-nav" });

    const prevBtn = nav.createEl("button", {
      cls: "fmo-supplements-year-btn",
      text: "\u2039"
    });
    prevBtn.addEventListener("click", () => {
      this.currentYear--;
      void this.render();
    });

    nav.createSpan({
      cls: "fmo-supplements-year-label",
      text: String(this.currentYear)
    });

    const nextBtn = nav.createEl("button", {
      cls: "fmo-supplements-year-btn",
      text: "\u203A"
    });
    nextBtn.addEventListener("click", () => {
      this.currentYear++;
      void this.render();
    });
  }

  private computeDayCells(snapshot: SupplementsSnapshot): Map<string, DayCell> {
    const logByDate = new Map<string, SupplementLogDay>();
    for (const day of snapshot.log) {
      logByDate.set(day.date, day);
    }

    const dates = snapshot.log.map((d) => d.date).sort();
    if (dates.length === 0) return new Map();

    const startDate = this.parseDate(dates[0]);
    const endDate = new Date();

    const dayCells = new Map<string, DayCell>();
    let currentHue = HUE_START;
    let prevTakenKeys: string[] = [];
    let prevTakenSorted = "";

    for (
      const cursor = new Date(startDate);
      cursor <= endDate;
      cursor.setDate(cursor.getDate() + 1)
    ) {
      const dateKey = toDateKey(cursor);
      const logDay = logByDate.get(dateKey);
      const taken = logDay?.taken ?? [];
      const takenRaw = logDay?.takenRaw ?? [];
      const currSorted = [...taken].sort().join(",");

      if (
        taken.length > 0 &&
        prevTakenKeys.length > 0 &&
        currSorted !== prevTakenSorted
      ) {
        const prevS = new Set(prevTakenKeys);
        const currS = new Set(taken);
        let symDiff = 0;
        for (const k of prevS) if (!currS.has(k)) symDiff++;
        for (const k of currS) if (!prevS.has(k)) symDiff++;
        const union = new Set([...prevTakenKeys, ...taken]).size;
        const magnitude = union > 0 ? symDiff / union : 0;
        currentHue = (currentHue + magnitude * HUE_STEP_MAX_DEGREES) % 360;
      }

      if (taken.length > 0) {
        prevTakenKeys = taken;
        prevTakenSorted = currSorted;
      }

      dayCells.set(dateKey, {
        date: dateKey,
        taken,
        takenRaw,
        hue: taken.length > 0 ? currentHue : -1
      });
    }

    return dayCells;
  }

  private buildIngredientGroups(
    definitions: Map<string, SupplementDef>
  ): IngredientGroup[] {
    const groupMap = new Map<string, IngredientGroup>();
    for (const [, def] of definitions) {
      let group = groupMap.get(def.ingredient);
      if (!group) {
        group = { ingredient: def.ingredient, keys: [], children: [] };
        groupMap.set(def.ingredient, group);
      }
      group.keys.push(def.key);
      const doseLabel =
        def.ingredientUnit === def.supplementUnit && def.ingredientAmount === def.supplementAmount
          ? `${def.ingredientAmount}${def.ingredientUnit}`
          : `${def.ingredientAmount}${def.ingredientUnit} · ${def.supplementAmount}${def.supplementUnit}`;
      group.children.push({
        key: def.key,
        label: `${def.brand} ${doseLabel}`
      });
    }
    return [...groupMap.values()];
  }

  private renderIngredientTree(
    sidebar: HTMLElement,
    groups: IngredientGroup[]
  ): void {
    const dayCounts = this.computeDayCounts();

    for (const group of groups) {
      const groupEl = sidebar.createDiv({ cls: "fmo-supplements-tree-group" });

      const parentEl = groupEl.createDiv({
        cls: "fmo-supplements-tree-parent",
        text: group.ingredient
      });

      const groupDayCount = group.keys.reduce(
        (sum, k) => sum + (dayCounts.get(k) ?? 0),
        0
      );
      parentEl.createSpan({
        cls: "fmo-supplements-tree-count",
        text: ` ${groupDayCount}d`
      });

      parentEl.addEventListener("mouseenter", () => {
        this.highlightDaysWithAnyKey(group.keys);
      });
      parentEl.addEventListener("mouseleave", () => {
        this.clearHighlight();
      });

      for (const child of group.children) {
        const childEl = groupEl.createDiv({
          cls: "fmo-supplements-tree-child",
          text: child.label
        });

        childEl.createSpan({
          cls: "fmo-supplements-tree-count",
          text: ` ${dayCounts.get(child.key) ?? 0}d`
        });

        childEl.addEventListener("mouseenter", () => {
          this.highlightDaysWithAnyKey([child.key]);
        });
        childEl.addEventListener("mouseleave", () => {
          this.clearHighlight();
        });
      }
    }
  }

  /** Pre-compute per-key day counts in a single pass over dayCells. */
  private computeDayCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const cell of this.dayCells.values()) {
      for (const key of cell.taken) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  private highlightDaysWithAnyKey(keys: string[]): void {
    if (!this.gridWrapper) return;
    this.gridWrapper.addClass("is-highlight-active");
    this.logWrapper?.addClass("is-highlight-active");

    const keySet = new Set(keys);
    for (const [dateKey, el] of this.cellElements) {
      const cell = this.dayCells.get(dateKey);
      if (cell && cell.taken.some((k) => keySet.has(k))) {
        el.addClass("is-highlighted");
      }
    }
    for (const el of this.logKeyElements) {
      if (keySet.has(el.dataset.key!)) {
        el.addClass("is-highlighted");
      }
    }
  }

  private clearHighlight(): void {
    if (!this.gridWrapper) return;
    this.gridWrapper.removeClass("is-highlight-active");
    this.logWrapper?.removeClass("is-highlight-active");
    for (const el of this.cellElements.values()) {
      el.removeClass("is-highlighted");
    }
    for (const el of this.logKeyElements) {
      el.removeClass("is-highlighted");
    }
  }

  private highlightLogLine(dateKey: string): void {
    const line = this.logLineElements.get(dateKey);
    if (!line) return;
    this.clearLogLineHighlight();
    this.logWrapper?.addClass("is-line-highlight-active");
    line.addClass("is-highlighted");
    this.highlightedLogLine = line;
    if (this.scrollRafId !== null) cancelAnimationFrame(this.scrollRafId);
    this.scrollRafId = requestAnimationFrame(() => {
      this.scrollRafId = null;
      line.scrollIntoView({ block: "nearest" });
    });
  }

  private clearLogLineHighlight(): void {
    this.logWrapper?.removeClass("is-line-highlight-active");
    this.highlightedLogLine?.removeClass("is-highlighted");
    this.highlightedLogLine = null;
  }

  private renderYearGrid(wrapper: HTMLElement): void {
    this.cellElements.clear();

    const weekStartsOn =
      this.plugin.settings.weekStartsOn === "sunday" ? 0 : 1;
    const weeks = buildYearWeeks(this.currentYear, weekStartsOn);
    const todayKey = toDateKey(new Date());

    const dayLabels =
      weekStartsOn === 1
        ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    // Month labels row
    const monthRow = wrapper.createDiv({
      cls: "fmo-supplements-year-month-row"
    });
    monthRow.createDiv({ cls: "fmo-supplements-year-label-spacer" });
    const monthTrack = monthRow.createDiv({
      cls: "fmo-supplements-year-month-track"
    });
    monthTrack.style.setProperty("--year-cols", `${weeks.length}`);

    const monthStarts = getMonthStartWeekIndex(weeks);
    for (let m = 0; m < 12; m++) {
      const weekIdx = monthStarts.get(m);
      if (weekIdx == null) continue;
      const label = monthTrack.createDiv({
        cls: "fmo-supplements-year-month-label",
        text: MONTH_ABBREVIATIONS[m]
      });
      label.style.gridColumn = `${weekIdx + 1}`;
    }

    // Body: day labels + grid
    const body = wrapper.createDiv({ cls: "fmo-supplements-year-body" });

    const dayLabelCol = body.createDiv({
      cls: "fmo-supplements-year-day-labels"
    });
    for (let row = 0; row < 7; row++) {
      dayLabelCol.createDiv({
        cls: "fmo-supplements-year-day-label",
        text: row % 2 === 0 ? dayLabels[row] : ""
      });
    }

    const grid = body.createDiv({ cls: "fmo-supplements-year-grid" });

    for (const week of weeks) {
      const weekEl = grid.createDiv({ cls: "fmo-supplements-year-week" });

      for (let row = 0; row < 7; row++) {
        const slot = week[row];
        const cellEl = weekEl.createDiv({
          cls: "fmo-supplements-year-cell"
        });

        if (!slot) {
          cellEl.addClass("fmo-supplements-year-cell-empty");
          continue;
        }

        const dayCell = this.dayCells.get(slot.key);
        this.cellElements.set(slot.key, cellEl);

        if (dayCell && dayCell.taken.length > 0) {
          cellEl.style.backgroundColor = `hsla(${Math.round(dayCell.hue)}, 50%, 58%, 0.55)`;
        }

        if (slot.key === todayKey) {
          cellEl.addClass("fmo-supplements-year-cell-today");
        }

        cellEl.title = this.buildTooltip(dayCell, slot.key);

        cellEl.addEventListener("mouseenter", () => {
          this.highlightLogLine(slot.key);
        });
        cellEl.addEventListener("mouseleave", () => {
          this.clearLogLineHighlight();
        });
      }
    }
  }

  private renderRawLog(container: HTMLElement): void {
    this.logKeyElements = [];
    this.logLineElements.clear();

    const section = container.createDiv({ cls: "fmo-supplements-raw-log" });
    const header = section.createDiv({ cls: "fmo-supplements-raw-log-header" });
    header.createDiv({ text: "Log", cls: "fmo-supplements-raw-log-title" });
    const openBtn = header.createEl("button", {
      cls: "fmo-supplements-raw-log-open clickable-icon",
      attr: { "aria-label": "Open log note" }
    });
    openBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    openBtn.addEventListener("click", () => {
      void this.plugin.openFile(this.plugin.settings.supplementsFilePath);
    });

    this.logWrapper = section.createDiv({ cls: "fmo-supplements-raw-log-pre" });

    const entries = Array.from(this.dayCells.values())
      .filter((c) => c.taken.length > 0)
      .sort((a, b) => b.date.localeCompare(a.date));

    for (const cell of entries) {
      const line = this.logWrapper.createDiv({ cls: "fmo-supplements-raw-log-line" });
      this.logLineElements.set(cell.date, line);
      line.createSpan({ text: `${cell.date}  `, cls: "fmo-supplements-raw-log-date" });
      for (let i = 0; i < cell.taken.length; i++) {
        if (i > 0) line.appendText(", ");
        const key = cell.taken[i];
        const raw = cell.takenRaw[i] ?? key;
        const def = this.definitions.get(key);
        const span = line.createSpan({
          text: def ? this.formatIngredientDose(def, raw, key) : raw,
          cls: "fmo-supplements-raw-log-key"
        });
        span.dataset.key = cell.taken[i];
        this.logKeyElements.push(span);
      }
    }
  }

  /** Convert a raw log entry like `key@5ml*2` into ingredient-unit dose like `Ingredient 4800mg`. */
  private formatIngredientDose(def: SupplementDef, raw: string, key: string): string {
    if (raw === key) return def.ingredient;

    const suffix = raw.slice(key.length); // e.g. "@7.5ml*1"
    const m = suffix.match(DOSE_SUFFIX_RE);
    if (!m || def.supplementAmount <= 0) return `${def.ingredient}${suffix}`;

    const suppAmount = parseFloat(m[1]);
    const times = parseInt(m[2], 10);
    const servings = (suppAmount * times) / def.supplementAmount;
    const ingredientTotal = servings * def.ingredientAmount;
    const display = Number.isInteger(ingredientTotal) ? ingredientTotal : ingredientTotal.toFixed(1);
    return `${def.ingredient} ${display}${def.ingredientUnit}`;
  }

  private buildTooltip(
    cell: DayCell | undefined,
    dateKey: string
  ): string {
    if (!cell || cell.taken.length === 0) return dateKey;
    const lines = cell.taken.map((key, i) => {
      const raw = cell.takenRaw[i] ?? key;
      const def = this.definitions.get(key);
      return def ? this.formatIngredientDose(def, raw, key) : raw;
    });
    return `${dateKey}\n${lines.join("\n")}`;
  }

  private parseDate(dateStr: string): Date {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
}
