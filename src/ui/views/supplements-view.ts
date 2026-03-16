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
  MONTH_ABBREVIATIONS,
  type YearSlot
} from "../../services/year-grid-utils";
import type LifeDashboardPlugin from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";

type DayCell = {
  date: string;
  taken: string[];
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

export class LifeDashboardSupplementsView extends LifeDashboardBaseView {
  private currentYear = new Date().getFullYear();
  private cellElements = new Map<string, HTMLElement>();
  private dayCells = new Map<string, DayCell>();
  private gridWrapper: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS;
  }

  getDisplayText(): string {
    return "Supplements Grid";
  }

  getIcon(): string {
    return "pill";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.cellElements.clear();
    this.dayCells.clear();
    this.gridWrapper = null;
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
        text: "No supplement data found in supplements-intake.md"
      });
      return;
    }

    this.renderYearNav(container);
    this.dayCells = this.computeDayCells(snapshot);

    const layout = container.createDiv({ cls: "fmo-supplements-layout" });

    const sidebar = layout.createDiv({ cls: "fmo-supplements-sidebar" });
    const groups = this.buildIngredientGroups(snapshot.definitions);
    this.renderIngredientTree(sidebar, groups);

    this.gridWrapper = layout.createDiv({ cls: "fmo-supplements-year-wrapper" });
    this.renderYearGrid(this.gridWrapper);
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
      group.children.push({
        key: def.key,
        label: `${def.brand} ${def.amount}${def.unit}`
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

    const keySet = new Set(keys);
    for (const [dateKey, el] of this.cellElements) {
      const cell = this.dayCells.get(dateKey);
      if (cell && cell.taken.some((k) => keySet.has(k))) {
        el.addClass("is-highlighted");
      }
    }
  }

  private clearHighlight(): void {
    if (!this.gridWrapper) return;
    this.gridWrapper.removeClass("is-highlight-active");
    for (const el of this.cellElements.values()) {
      el.removeClass("is-highlighted");
    }
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
      }
    }
  }

  private buildTooltip(
    cell: DayCell | undefined,
    dateKey: string
  ): string {
    if (!cell || cell.taken.length === 0) return dateKey;
    return `${dateKey}\n${cell.taken.join("\n")}`;
  }

  private parseDate(dateStr: string): Date {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
}
