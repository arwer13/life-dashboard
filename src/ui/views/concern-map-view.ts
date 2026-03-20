import { SearchComponent, setTooltip } from "obsidian";
import { DISPLAY_VERSION } from "../../version";
import type { TaskItem, InlineTaskItem } from "../../models/types";
import { isFileItem, isInlineItem } from "../../models/types";
import {
  VIEW_TYPE_LIFE_DASHBOARD_CONCERN_MAP,
  OUTLINE_RANGE_OPTIONS,
  OUTLINE_SORT_OPTIONS,
  MIN_TRACKED_SECONDS_PER_PERIOD,
  CLOSED_FILTER_QUERY,
  type OutlineSortMode
} from "../../models/view-types";
import type { OutlineTimeRange } from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";
import {
  getItemPriorityBadge,
  getItemPriorityRank,
  handlePriorityHotkey
} from "../../services/priority-utils";
import { buildParentPathMap, collectPathsWithParents, collectScopePaths } from "../../services/task-tree-builder";
import { withClosedFilter } from "../../services/outline-filter";
import { parseInlinePath } from "../../services/inline-task-parser";

type ConcernMapFilterState = {
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  showInlineTasks: boolean;
  priorityOnly: boolean;
  showClosed: boolean;
  showStatus: boolean;
  fontSize: number;
  boxScale: number;
  boxPadding: number;
  colorByPriority: boolean;
  colorByStatus: boolean;
  showParentLabel: boolean;
};

type BoxPosition = { rx: number; ry: number; groupId?: string };

type PersistedConcernMapState = {
  version: 2 | 3;
  positions: Record<string, BoxPosition>;
  groups?: Record<string, Omit<GroupContainer, "id">>;
  filter: ConcernMapFilterState;
};

type GroupContainer = {
  id: string;
  title: string;
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  color: number;
};

const MAP_BASE_BOX_WIDTH = 126;
const MAP_BASE_BOX_HEIGHT = 56;
const MAP_BASE_FONT_SIZE = 13;
const MAP_MIN_FONT_SIZE = 8;
const MAP_MAX_FONT_SIZE = 18;
const MAP_BASE_BOX_SCALE = 100;
const MAP_MIN_BOX_SCALE = 60;
const MAP_MAX_BOX_SCALE = 200;
const MAP_BASE_BOX_PADDING = 8;
const MAP_MIN_BOX_PADDING = 2;
const MAP_MAX_BOX_PADDING = 16;
const MAP_GRID_GAP_X = 20;
const MAP_GRID_GAP_Y = 16;
const MAP_GRID_PADDING = 24;
const CONCERN_MAP_VERSION = 3;
const DRAG_THRESHOLD = 4;
const DEFAULT_REF_WIDTH = 600;
const DEFAULT_REF_HEIGHT = 400;

// ── Group containers ─────────────────────────────────────────────────

const GROUP_PALETTE_HUES = [210, 150, 35, 280, 355, 180];
const GROUP_DEFAULT_RW = 0.25;
const GROUP_DEFAULT_RH = 0.3;
const GROUP_MIN_PX_W = 100;
const GROUP_MIN_PX_H = 60;

function groupBg(colorIdx: number): string {
  const hue = GROUP_PALETTE_HUES[colorIdx % GROUP_PALETTE_HUES.length];
  return `hsla(${hue}, 40%, 72%, 0.18)`;
}

function groupBorder(colorIdx: number): string {
  const hue = GROUP_PALETTE_HUES[colorIdx % GROUP_PALETTE_HUES.length];
  return `hsla(${hue}, 40%, 62%, 0.35)`;
}

// ── Box coloring ──────────────────────────────────────────────────────

const PRIORITY_HUES: Record<number, number> = { 0: 355, 1: 28, 2: 52, 3: 210, 4: 260 };

const STATUS_HUES: Record<string, number> = {
  done: 130, completed: 130,
  rejected: 0, cancelled: 0,
  "in-progress": 210, active: 210,
  blocked: 35, waiting: 35,
};

function priorityBg(rank: number): string {
  const hue = PRIORITY_HUES[rank] ?? 260;
  return `hsla(${hue}, 55%, 68%, 0.18)`;
}

function priorityBorder(rank: number): string {
  const hue = PRIORITY_HUES[rank] ?? 260;
  return `hsla(${hue}, 60%, 60%, 0.5)`;
}

function statusBg(status: string): string {
  const key = status.toLowerCase();
  const hue = STATUS_HUES[key] ?? hashToHue(key);
  return `hsla(${hue}, 55%, 68%, 0.18)`;
}

function hashToHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

function isRelativePosition(value: unknown): value is BoxPosition {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.rx === "number" && Number.isFinite(obj.rx) &&
    typeof obj.ry === "number" && Number.isFinite(obj.ry) &&
    (obj.groupId === undefined || typeof obj.groupId === "string")
  );
}

/** Extract the frontmatter id from a task's frontmatter, or "" if none. */
function getFrontmatterId(task: TaskItem): string {
  if (!isFileItem(task)) return "";
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const id = task.frontmatter?.id;
  if (id == null) return "";
  if (typeof id !== "string" && typeof id !== "number") return "";
  return String(id).trim();
}


export class LifeDashboardConcernMapView extends LifeDashboardBaseView {
  private filterState: ConcernMapFilterState = {
    rootPath: "",
    query: "",
    sortMode: "priority",
    range: "all",
    trackedOnly: false,
    showParents: false,
    showInlineTasks: true,
    priorityOnly: true,
    showClosed: false,
    showStatus: true,
    fontSize: MAP_BASE_FONT_SIZE,
    boxScale: MAP_BASE_BOX_SCALE,
    boxPadding: MAP_BASE_BOX_PADDING,
    colorByPriority: false,
    colorByStatus: false,
    showParentLabel: false
  };
  /** Positions stored as fractions of viewport dimensions. */
  private positions = new Map<string, BoxPosition>();
  /** Inline task path → basename from previous render, used for cross-file move detection. */
  private inlineBasenames = new Map<string, string>();
  private parentByPath = new Map<string, string>();
  private selectedPaths = new Set<string>();
  private boxElements = new Map<string, HTMLElement>();
  private groups = new Map<string, GroupContainer>();
  private groupElements = new Map<string, HTMLElement>();
  /** Maps task path → stable storage ID (frontmatter id for files, parentId#checkbox:line for inline). */
  private pathToStableId = new Map<string, string>();
  private hoveredConcernPath: string | null = null;
  private rerenderCanvas: (() => void) | null = null;
  /** Raw JSON from last loadPersistedState — skip re-parse when unchanged. */
  private lastLoadedStateRaw = "";
  private keydownRegistered = false;
  private viewportScroll = { left: 0, top: 0 };
  private refSize = { width: DEFAULT_REF_WIDTH, height: DEFAULT_REF_HEIGHT };
  private resizeObserver: ResizeObserver | null = null;

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_CONCERN_MAP;
  }

  getDisplayText(): string {
    return "Concern map";
  }

  getIcon(): string {
    return "map";
  }

  async onOpen(): Promise<void> {
    this.ensurePriorityHotkeyListener();
    await this.render();
  }

  async onClose(): Promise<void> {
    this.hoveredConcernPath = null;
    this.boxElements.clear();
    this.groupElements.clear();
    this.selectedPaths.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  async render(): Promise<void> {
    this.captureViewportScroll();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");
    contentEl.addClass("fmo-concern-map-view");

    const tasks = this.plugin.getTaskTreeItems();
    this.buildStableIdMaps(tasks);
    // Always reload persisted state (ID-keyed) and resolve to current paths.
    // This ensures file renames are handled: persisted data has ID keys,
    // buildStableIdMaps has the new paths, and resolvePositionKeys bridges them.
    this.loadPersistedState();
    this.resolvePositionKeys();
    this.parentByPath = buildParentPathMap(
      tasks,
      (parentRaw, sourcePath) => this.resolveParentPath(parentRaw, sourcePath)
    );

    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concern map" });
    headerTop.createEl("span", { cls: "fmo-version", text: `v${DISPLAY_VERSION}` });

    const controlsRow = header.createEl("div", { cls: "fmo-concern-map-controls-row" });
    const canvasArea = contentEl.createEl("div", { cls: "fmo-concern-map-canvas-area" });

    let countSpan: HTMLElement;
    const rerenderCanvas = (): void => {
      this.captureViewportScroll();
      canvasArea.empty();
      this.hoveredConcernPath = null;
      const count = this.renderCanvasContent(canvasArea, tasks);
      countSpan.setText(`${count} concern${count === 1 ? "" : "s"}`);
    };
    this.rerenderCanvas = rerenderCanvas;

    this.renderControls(controlsRow, tasks, rerenderCanvas);
    countSpan = this.renderCanvasTools(controlsRow, canvasArea, tasks, rerenderCanvas);
    rerenderCanvas();

    // After rendering, ensure displayed tasks have stable IDs.
    // Missing IDs are added asynchronously; the file changes trigger a new render.
    void this.ensureMissingStableIds(tasks);
  }

  /**
   * For each task on the map that lacks a stable ID, add one:
   * - File concerns without frontmatter `id` → ensureTaskId
   * - Inline tasks without `$XXXXXX` suffix → ensureInlineTaskId
   * Only processes tasks that have a position on the map.
   */
  private ensureIdsInFlight = false;
  private async ensureMissingStableIds(tasks: TaskItem[]): Promise<void> {
    if (this.ensureIdsInFlight) return;
    this.ensureIdsInFlight = true;
    try {
      // Collect position key migrations needed for inline tasks
      const keyMigrations = new Map<string, string>();

      for (const task of tasks) {
        if (!this.positions.has(task.path)) continue;
        if (isFileItem(task) && !getFrontmatterId(task)) {
          await this.plugin.ensureTaskId(task.file);
        } else if (isInlineItem(task) && !task.inlineId) {
          const parentId = this.pathToStableId.get(task.parentPath);
          const oldKey = parentId ? `${parentId}#${task.line}` : undefined;
          const newInlineId = await this.plugin.ensureInlineTaskId(task.path);
          if (newInlineId && oldKey && parentId) {
            const newKey = `${parentId}#${newInlineId}`;
            if (oldKey !== newKey) keyMigrations.set(oldKey, newKey);
          }
        }
      }

      // Batch-migrate position keys in persisted state (structured replacement)
      if (keyMigrations.size > 0) {
        const raw = this.plugin.getConcernMapState().trim();
        if (raw) {
          try {
            const state = JSON.parse(raw) as { positions?: Record<string, unknown> };
            if (state.positions) {
              for (const [oldKey, newKey] of keyMigrations) {
                if (oldKey in state.positions && !(newKey in state.positions)) {
                  state.positions[newKey] = state.positions[oldKey];
                  delete state.positions[oldKey];
                }
              }
              const updated = JSON.stringify(state);
              this.plugin.setConcernMapState(updated);
              this.lastLoadedStateRaw = updated;
            }
          } catch { /* corrupt state — skip migration */ }
        }
      }
    } finally {
      this.ensureIdsInFlight = false;
    }
  }

  // ── Coordinate conversion ─────────────────────────────────────────────

  private usableWidth(): number {
    return Math.max(1, this.refSize.width - this.getScaledBoxWidth());
  }

  private usableHeight(): number {
    return Math.max(1, this.refSize.height - this.getScaledBoxHeight());
  }

  private toPixelX(rx: number): number {
    return rx * this.usableWidth();
  }

  private toPixelY(ry: number): number {
    return ry * this.usableHeight();
  }

  private toRelX(px: number): number {
    return px / this.usableWidth();
  }

  private toRelY(py: number): number {
    return py / this.usableHeight();
  }

  // ── Group helpers ────────────────────────────────────────────────────

  private getGroupPixelRect(group: GroupContainer): { x: number; y: number; w: number; h: number } {
    return {
      x: this.toPixelX(group.rx),
      y: this.toPixelY(group.ry),
      w: group.rw * this.refSize.width,
      h: group.rh * this.refSize.height,
    };
  }

  private getAbsolutePixelPos(path: string): { px: number; py: number } | null {
    const pos = this.positions.get(path);
    if (!pos) return null;
    if (pos.groupId) {
      const group = this.groups.get(pos.groupId);
      if (group) {
        const r = this.getGroupPixelRect(group);
        return { px: r.x + pos.rx * r.w, py: r.y + pos.ry * r.h };
      }
      // Stale groupId — treat as ungrouped (cleaned up on next persist)
    }
    return { px: this.toPixelX(pos.rx), py: this.toPixelY(pos.ry) };
  }

  private findGroupAtPoint(px: number, py: number): GroupContainer | null {
    for (const group of this.groups.values()) {
      const r = this.getGroupPixelRect(group);
      if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
        return group;
      }
    }
    return null;
  }

  private deleteGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    const r = group ? this.getGroupPixelRect(group) : null;
    for (const [, pos] of this.positions) {
      if (pos.groupId !== groupId) continue;
      if (r) {
        pos.rx = this.toRelX(r.x + pos.rx * r.w);
        pos.ry = this.toRelY(r.y + pos.ry * r.h);
      }
      delete pos.groupId;
    }
    this.groups.delete(groupId);
  }

  private repositionGroupChildren(group: GroupContainer): void {
    const r = this.getGroupPixelRect(group);
    for (const [path, pos] of this.positions) {
      if (pos.groupId !== group.id) continue;
      const boxEl = this.boxElements.get(path);
      if (!boxEl) continue;
      boxEl.style.left = `${r.x + pos.rx * r.w}px`;
      boxEl.style.top = `${r.y + pos.ry * r.h}px`;
    }
  }

  /**
   * Build path↔stableId maps for all tasks. For file concerns the stable ID
   * is the frontmatter `id`; for inline tasks it is `parentId#inlineId`.
   */
  private buildStableIdMaps(tasks: TaskItem[]): void {
    this.pathToStableId.clear();
    // First pass: file items (needed to resolve parent IDs for inline tasks)
    const fileIdByPath = new Map<string, string>();
    for (const task of tasks) {
      if (!isFileItem(task)) continue;
      const id = getFrontmatterId(task);
      if (!id) continue;
      fileIdByPath.set(task.path, id);
      this.pathToStableId.set(task.path, id);
    }
    // Second pass: inline items — use inlineId when available, fall back to line
    for (const task of tasks) {
      if (!isInlineItem(task)) continue;
      const parentId = fileIdByPath.get(task.parentPath);
      if (!parentId) continue;
      const suffix = task.inlineId || String(task.line);
      this.pathToStableId.set(task.path, `${parentId}#${suffix}`);
    }
  }

  /**
   * Translate position keys from stable IDs to runtime paths.
   * Handles: (1) v3 data keyed by IDs → resolve to current paths,
   *          (2) v2 data keyed by paths → kept as-is (compatible),
   *          (3) file renames → orphaned old-path keys matched to new paths via ID.
   */
  private resolvePositionKeys(): void {
    const idToPath = new Map<string, string>();
    for (const [path, id] of this.pathToStableId) {
      idToPath.set(id, path);
    }

    const toAdd: [string, BoxPosition][] = [];
    const toDelete: string[] = [];
    for (const [key, pos] of this.positions) {
      const pathFromId = idToPath.get(key);
      if (pathFromId && pathFromId !== key) {
        toDelete.push(key);
        toAdd.push([pathFromId, pos]);
      }
    }
    for (const key of toDelete) this.positions.delete(key);
    for (const [path, pos] of toAdd) {
      if (!this.positions.has(path)) this.positions.set(path, pos);
    }
  }

  private nextGroupId(): string {
    return `g${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── Controls ──────────────────────────────────────────────────────────

  private renderControls(
    containerEl: HTMLElement,
    tasks: TaskItem[],
    rerenderCanvas: () => void
  ): void {
    const controls = containerEl.createEl("div", { cls: "fmo-tree-panel-controls" });
    const fileItems = [...tasks].filter(isFileItem).sort((a, b) =>
      a.basename.localeCompare(b.basename, undefined, { sensitivity: "base" })
    );

    const rootRow = controls.createEl("label", { cls: "fmo-tree-panel-root-row" });
    rootRow.createEl("span", { cls: "fmo-tree-panel-control-label", text: "Root" });
    const rootSelect = rootRow.createEl("select", { cls: "fmo-outline-sort-select" });
    rootSelect.createEl("option", { value: "", text: "All concerns" });
    for (const task of fileItems) {
      rootSelect.createEl("option", { value: task.path, text: task.basename });
    }
    rootSelect.value = this.filterState.rootPath;
    rootSelect.addEventListener("change", () => {
      this.filterState.rootPath = rootSelect.value;
      this.persistState();
      rerenderCanvas();
    });

    const optionsGrid = controls.createEl("div", { cls: "fmo-tree-panel-options-grid" });

    const rangeRow = optionsGrid.createEl("label", { cls: "fmo-tree-panel-option" });
    rangeRow.createEl("span", { cls: "fmo-tree-panel-control-label", text: "Range" });
    const rangeSelect = rangeRow.createEl("select", { cls: "fmo-outline-sort-select" });
    for (const option of OUTLINE_RANGE_OPTIONS) {
      rangeSelect.createEl("option", { value: option.value, text: option.label });
    }
    rangeSelect.value = this.filterState.range;
    rangeSelect.addEventListener("change", () => {
      this.filterState.range = rangeSelect.value as OutlineTimeRange;
      this.persistState();
      rerenderCanvas();
    });

    const sortRow = optionsGrid.createEl("label", { cls: "fmo-tree-panel-option" });
    sortRow.createEl("span", { cls: "fmo-tree-panel-control-label", text: "Sort" });
    const sortSelect = sortRow.createEl("select", { cls: "fmo-outline-sort-select" });
    for (const option of OUTLINE_SORT_OPTIONS) {
      sortSelect.createEl("option", { value: option.value, text: option.label });
    }
    sortSelect.value = this.filterState.sortMode;
    sortSelect.addEventListener("change", () => {
      this.filterState.sortMode = sortSelect.value as OutlineSortMode;
      this.persistState();
      rerenderCanvas();
    });

    const flagsRow = controls.createEl("div", { cls: "fmo-tree-panel-flags" });

    this.renderFlag(flagsRow, "Tracked only", this.filterState.trackedOnly, (v) => {
      this.filterState.trackedOnly = v;
      this.persistState();
      rerenderCanvas();
    });
    this.renderFlag(flagsRow, "Parents", this.filterState.showParents, (v) => {
      this.filterState.showParents = v;
      this.persistState();
      rerenderCanvas();
    });
    this.renderFlag(flagsRow, "Inline tasks", this.filterState.showInlineTasks, (v) => {
      this.filterState.showInlineTasks = v;
      this.persistState();
      rerenderCanvas();
    });
    this.renderFlag(flagsRow, "Priority only", this.filterState.priorityOnly, (v) => {
      this.filterState.priorityOnly = v;
      this.persistState();
      rerenderCanvas();
    });
    const showClosedRow = this.renderFlag(flagsRow, "Show closed", this.filterState.showClosed, (v) => {
      this.filterState.showClosed = v;
      this.persistState();
      rerenderCanvas();
    });
    setTooltip(showClosedRow, `When off: ${CLOSED_FILTER_QUERY}`);
    this.renderFlag(flagsRow, "Status", this.filterState.showStatus, (v) => {
      this.filterState.showStatus = v;
      this.persistState();
      rerenderCanvas();
    });

    const filterRow = controls.createEl("div", { cls: "fmo-tree-panel-filter" });
    const filterSearch = new SearchComponent(filterRow);
    filterSearch.setPlaceholder("Filter (path:, file:, prop:key=value)");
    filterSearch.setValue(this.filterState.query);
    filterSearch.onChange((query) => {
      this.filterState.query = query;
      this.persistState();
      rerenderCanvas();
    });
  }

  private renderFlag(
    container: HTMLElement,
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void
  ): HTMLElement {
    const row = container.createEl("label", { cls: "fmo-outline-tracked-only-row" });
    const input = row.createEl("input", {
      cls: "fmo-outline-tracked-only-input",
      attr: { type: "checkbox" }
    });
    input.checked = checked;
    row.createEl("span", { text: label });
    input.addEventListener("change", () => {
      onChange(input.checked);
    });
    return row;
  }

  // ── Canvas tools (right side of controls row) ───────────────────────

  private renderCanvasTools(
    controlsRow: HTMLElement,
    canvasArea: HTMLElement,
    tasks: TaskItem[],
    rerenderCanvas: () => void
  ): HTMLElement {
    const tools = controlsRow.createEl("div", { cls: "fmo-concern-map-tools" });
    const countSpan = tools.createEl("span", { cls: "fmo-subheader" });

    const slidersRow = tools.createEl("div", { cls: "fmo-concern-map-sliders-row" });
    let stageEl: HTMLElement | null = null;
    const getStage = (): HTMLElement | null => stageEl ??= canvasArea.querySelector<HTMLElement>(".fmo-concern-map-stage");

    const makeSlider = (
      label: string, min: number, max: number, step: number, value: number,
      onInput: (v: number) => void, needsRerender?: boolean
    ): void => {
      const wrap = slidersRow.createEl("label", { cls: "fmo-concern-map-size-label" });
      wrap.createEl("span", { text: label });
      const input = wrap.createEl("input", {
        cls: "fmo-concern-map-size-slider",
        attr: { type: "range", min: String(min), max: String(max), step: String(step) }
      });
      input.value = String(value);
      input.addEventListener("input", () => onInput(Number(input.value)));
      input.addEventListener("change", () => {
        this.persistState();
        if (needsRerender) rerenderCanvas();
      });
    };

    makeSlider("Size", MAP_MIN_BOX_SCALE, MAP_MAX_BOX_SCALE, 5, this.filterState.boxScale, (v) => {
      this.filterState.boxScale = v;
      getStage()?.style.setProperty("--map-box-width", `${this.getScaledBoxWidth()}px`);
    }, true);
    makeSlider("Pad", MAP_MIN_BOX_PADDING, MAP_MAX_BOX_PADDING, 1, this.filterState.boxPadding, (v) => {
      this.filterState.boxPadding = v;
      getStage()?.style.setProperty("--map-box-padding", `${v}px`);
    });
    makeSlider("Font", MAP_MIN_FONT_SIZE, MAP_MAX_FONT_SIZE, 1, this.filterState.fontSize, (v) => {
      this.filterState.fontSize = v;
      getStage()?.style.setProperty("--map-font-size", `${v}px`);
    });

    const optionsRow = tools.createEl("div", { cls: "fmo-concern-map-tools-buttons" });
    this.renderFlag(optionsRow, "Priority colors", this.filterState.colorByPriority, (v) => {
      this.filterState.colorByPriority = v;
      this.persistState();
      rerenderCanvas();
    });
    this.renderFlag(optionsRow, "Status colors", this.filterState.colorByStatus, (v) => {
      this.filterState.colorByStatus = v;
      this.persistState();
      rerenderCanvas();
    });
    this.renderFlag(optionsRow, "Parent", this.filterState.showParentLabel, (v) => {
      this.filterState.showParentLabel = v;
      this.persistState();
      rerenderCanvas();
    });

    const buttonsRow = tools.createEl("div", { cls: "fmo-concern-map-tools-buttons" });

    const addGroupBtn = buttonsRow.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Add group",
      attr: { type: "button" }
    });
    setTooltip(addGroupBtn, "Create a visual group container on the map.");
    addGroupBtn.addEventListener("click", () => {
      const viewport = canvasArea.querySelector<HTMLElement>(".fmo-concern-map-viewport");
      const vpW = viewport?.clientWidth ?? this.refSize.width;
      const vpH = viewport?.clientHeight ?? this.refSize.height;
      const scrollL = viewport?.scrollLeft ?? 0;
      const scrollT = viewport?.scrollTop ?? 0;
      const gw = GROUP_DEFAULT_RW * this.refSize.width;
      const gh = GROUP_DEFAULT_RH * this.refSize.height;
      const centerPx = scrollL + vpW / 2 - gw / 2;
      const centerPy = scrollT + vpH / 2 - gh / 2;
      const id = this.nextGroupId();
      this.groups.set(id, {
        id,
        title: "Group",
        rx: this.toRelX(Math.max(0, centerPx)),
        ry: this.toRelY(Math.max(0, centerPy)),
        rw: GROUP_DEFAULT_RW,
        rh: GROUP_DEFAULT_RH,
        color: this.groups.size % GROUP_PALETTE_HUES.length,
      });
      this.persistState();
      rerenderCanvas();
    });

    const resetBtn = buttonsRow.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Reset positions",
      attr: { type: "button" }
    });
    setTooltip(resetBtn, "Re-arrange all boxes into a grid.");
    resetBtn.addEventListener("click", () => {
      this.positions.clear();
      this.groups.clear();
      rerenderCanvas();
    });

    const fixBtn = buttonsRow.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Fix overlaps",
      attr: { type: "button" }
    });
    setTooltip(fixBtn, "Nudge overlapping boxes apart while preserving relative positions.");
    fixBtn.addEventListener("click", () => {
      this.resolveOverlaps(tasks);
      rerenderCanvas();
    });

    const fitBtn = buttonsRow.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Fit into canvas",
      attr: { type: "button" }
    });
    setTooltip(fitBtn, "Scale and shift all boxes to fit within the visible viewport.");
    fitBtn.addEventListener("click", () => {
      this.fitIntoCanvas(tasks);
      rerenderCanvas();
    });

    return countSpan;
  }

  private collectPixelItems(tasks: TaskItem[]): { path: string; x: number; y: number }[] {
    const filtered = this.applyFilters(tasks);
    const items: { path: string; x: number; y: number }[] = [];
    for (const task of filtered) {
      const pos = this.positions.get(task.path);
      if (!pos || pos.groupId) continue;
      items.push({ path: task.path, x: this.toPixelX(pos.rx), y: this.toPixelY(pos.ry) });
    }
    return items;
  }

  private commitPixelItems(items: { path: string; x: number; y: number }[]): void {
    for (const item of items) {
      this.positions.set(item.path, { rx: this.toRelX(item.x), ry: this.toRelY(item.y) });
    }
    this.persistState();
  }

  private resolveOverlaps(tasks: TaskItem[]): void {
    const boxW = this.getScaledBoxWidth();
    const boxH = this.getScaledBoxHeight();
    const gap = 4;
    const maxIter = 100;
    const items = this.collectPixelItems(tasks);
    if (items.length < 2) return;

    for (let iter = 0; iter < maxIter; iter++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i];
          const b = items[j];
          const overlapX = (boxW + gap) - Math.abs(a.x - b.x);
          const overlapY = (boxH + gap) - Math.abs(a.y - b.y);
          if (overlapX <= 0 || overlapY <= 0) continue;

          moved = true;
          if (overlapX < overlapY) {
            const push = overlapX / 2;
            if (a.x <= b.x) { a.x -= push; b.x += push; }
            else { a.x += push; b.x -= push; }
          } else {
            const push = overlapY / 2;
            if (a.y <= b.y) { a.y -= push; b.y += push; }
            else { a.y += push; b.y -= push; }
          }
        }
      }
      if (!moved) break;

      for (const item of items) {
        item.x = Math.max(0, item.x);
        item.y = Math.max(0, item.y);
      }
    }

    this.commitPixelItems(items);
  }

  private fitIntoCanvas(tasks: TaskItem[]): void {
    const items = this.collectPixelItems(tasks);
    if (items.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of items) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x);
      maxY = Math.max(maxY, item.y);
    }

    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const uw = this.usableWidth();
    const uh = this.usableHeight();

    // Uniform scale — only shrink, never enlarge
    let scale = 1;
    if (spanX > uw || spanY > uh) {
      const sx = spanX > 0 ? uw / spanX : Infinity;
      const sy = spanY > 0 ? uh / spanY : Infinity;
      scale = Math.min(sx, sy);
    }

    // Center on the axis with slack
    const offsetX = Math.max(0, (uw - spanX * scale) / 2);
    const offsetY = Math.max(0, (uh - spanY * scale) / 2);

    for (const item of items) {
      item.x = (item.x - minX) * scale + offsetX;
      item.y = (item.y - minY) * scale + offsetY;
    }

    this.commitPixelItems(items);
  }

  // ── Canvas ────────────────────────────────────────────────────────────

  private getScale(): number {
    return this.filterState.boxScale / MAP_BASE_BOX_SCALE;
  }

  private getScaledBoxWidth(): number {
    return Math.round(MAP_BASE_BOX_WIDTH * this.getScale());
  }

  private getScaledBoxHeight(): number {
    return Math.round(MAP_BASE_BOX_HEIGHT * this.getScale());
  }

  private renderCanvasContent(containerEl: HTMLElement, tasks: TaskItem[]): number {
    const filtered = this.applyFilters(tasks);

    const viewport = containerEl.createEl("div", { cls: "fmo-concern-map-viewport" });
    const stage = viewport.createEl("div", { cls: "fmo-concern-map-stage" });
    stage.style.setProperty("--map-font-size", `${this.filterState.fontSize}px`);
    stage.style.setProperty("--map-box-width", `${this.getScaledBoxWidth()}px`);
    stage.style.setProperty("--map-box-padding", `${this.filterState.boxPadding}px`);

    // Update reference size from viewport (used for fraction↔pixel conversion)
    const vpWidth = viewport.clientWidth || this.contentEl.clientWidth || DEFAULT_REF_WIDTH;
    const vpHeight = viewport.clientHeight || this.contentEl.clientHeight || DEFAULT_REF_HEIGHT;
    this.refSize = { width: vpWidth, height: vpHeight };

    this.migrateShiftedInlinePositions(filtered);
    this.copyPositionsForInlineTwins(filtered);
    this.ensurePositions(filtered);

    // Rebuild basename map, but preserve names for orphaned positions (survives intermediate renders)
    const newBasenames = new Map<string, string>();
    for (const task of filtered) {
      if (isInlineItem(task)) newBasenames.set(task.path, task.basename);
    }
    for (const [path, name] of this.inlineBasenames) {
      if (!newBasenames.has(path) && this.positions.has(path)) newBasenames.set(path, name);
    }
    this.inlineBasenames = newBasenames;

    this.groupElements.clear();
    for (const group of this.groups.values()) {
      this.renderGroup(stage, group);
    }

    this.boxElements.clear();
    for (const task of filtered) {
      this.renderBox(stage, task);
    }

    for (const path of this.selectedPaths) {
      if (!this.boxElements.has(path)) this.selectedPaths.delete(path);
    }

    this.attachMarqueeSelection(stage);
    this.observeResize(viewport);

    viewport.scrollLeft = this.viewportScroll.left;
    viewport.scrollTop = this.viewportScroll.top;
    return filtered.length;
  }

  private observeResize(viewport: HTMLElement): void {
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const newW = entry.contentRect.width;
        const newH = entry.contentRect.height;
        if (newW < 1 || newH < 1) return;
        if (Math.abs(newW - this.refSize.width) < 1 && Math.abs(newH - this.refSize.height) < 1) return;

        this.refSize = { width: newW, height: newH };
        for (const [id, el] of this.groupElements) {
          const group = this.groups.get(id);
          if (!group) continue;
          const r = this.getGroupPixelRect(group);
          el.style.left = `${r.x}px`;
          el.style.top = `${r.y}px`;
          el.style.width = `${r.w}px`;
          el.style.height = `${r.h}px`;
        }
        for (const [path, el] of this.boxElements) {
          const abs = this.getAbsolutePixelPos(path);
          if (!abs) continue;
          el.style.left = `${abs.px}px`;
          el.style.top = `${abs.py}px`;
        }
      });
    } else {
      this.resizeObserver.disconnect();
    }
    this.resizeObserver.observe(viewport);
  }

  private renderBox(stageEl: HTMLElement, task: TaskItem): void {
    const pos = this.positions.get(task.path);
    if (!pos) return;

    const abs = this.getAbsolutePixelPos(task.path);
    if (!abs) return;
    const px = abs.px;
    const py = abs.py;

    const isInline = isInlineItem(task);
    const box = stageEl.createEl("div", {
      cls: isInline
        ? "fmo-concern-map-box fmo-concern-map-box-inline"
        : "fmo-concern-map-box"
    });
    box.style.left = `${px}px`;
    box.style.top = `${py}px`;
    box.classList.toggle("fmo-concern-map-box-selected", this.selectedPaths.has(task.path));

    this.boxElements.set(task.path, box);

    // ── Coloring ──
    const rank = getItemPriorityRank(task);
    const hasPriority = rank < 100;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rawStatus = isFileItem(task) ? task.frontmatter?.status : undefined;
    const statusStr = rawStatus != null ? String(rawStatus).trim() : "";
    const byP = this.filterState.colorByPriority;
    const byS = this.filterState.colorByStatus;

    if (byP && byS) {
      // Both: left border = priority, background = status (fallback to priority if no status)
      if (hasPriority) box.style.borderLeft = `3px solid ${priorityBorder(rank)}`;
      if (statusStr) box.style.background = statusBg(statusStr);
      else if (hasPriority) box.style.background = priorityBg(rank);
    } else if (byP && hasPriority) {
      box.style.background = priorityBg(rank);
    } else if (byS && statusStr) {
      box.style.background = statusBg(statusStr);
    }

    const nameEl = box.createEl("span", {
      cls: "fmo-concern-map-box-name",
      text: task.basename
    });

    if (this.filterState.showStatus && isFileItem(task) && statusStr) {
      nameEl.createEl("span", {
        cls: "fmo-concern-map-box-status",
        text: ` ${statusStr}`
      });
    }

    const priorityBadge = getItemPriorityBadge(task);
    if (priorityBadge) {
      box.createEl("span", {
        cls: "fmo-concern-map-box-priority",
        text: priorityBadge
      });
    }

    if (this.filterState.showParentLabel) {
      const parentPath = this.parentByPath.get(task.path);
      if (parentPath) {
        box.classList.add("fmo-concern-map-box-has-parent");
        const parentName = parentPath.replace(/\.md$/, "").split("/").pop() ?? parentPath;
        box.createEl("div", {
          cls: "fmo-concern-map-box-parent",
          text: parentName
        });
      }
    }

    const tooltipText = isInlineItem(task) ? task.text : task.basename;
    setTooltip(box, tooltipText);

    box.addEventListener("mouseenter", () => {
      this.hoveredConcernPath = task.path;
    });
    box.addEventListener("mouseleave", () => {
      if (this.hoveredConcernPath === task.path) {
        this.hoveredConcernPath = null;
      }
    });

    this.attachBoxInteraction(box, task, pos);
  }

  // ── Group rendering ──────────────────────────────────────────────────

  private renderGroup(stageEl: HTMLElement, group: GroupContainer): void {
    const r = this.getGroupPixelRect(group);
    const el = stageEl.createEl("div", { cls: "fmo-concern-map-group" });
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    el.style.background = groupBg(group.color);
    el.style.borderColor = groupBorder(group.color);

    this.groupElements.set(group.id, el);

    const header = el.createEl("div", { cls: "fmo-concern-map-group-header" });
    const titleEl = header.createEl("span", {
      cls: "fmo-concern-map-group-title",
      text: group.title,
    });
    titleEl.setAttribute("contenteditable", "false");

    titleEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      titleEl.setAttribute("contenteditable", "true");
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    titleEl.addEventListener("blur", () => {
      titleEl.setAttribute("contenteditable", "false");
      group.title = titleEl.textContent?.trim() || "Group";
      this.persistState();
    });
    titleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
      if (e.key === "Escape") { titleEl.textContent = group.title; titleEl.blur(); }
    });

    const closeBtn = header.createEl("button", {
      cls: "fmo-concern-map-group-close",
      text: "\u00d7",
      attr: { type: "button" },
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteGroup(group.id);
      this.persistState();
      this.rerenderCanvas?.();
    });

    el.createEl("div", { cls: "fmo-concern-map-group-resize" });
    this.attachGroupInteraction(el, group);
  }

  private attachGroupInteraction(el: HTMLElement, group: GroupContainer): void {
    const resizeHandle = el.querySelector<HTMLElement>(".fmo-concern-map-group-resize");

    // Resize via bottom-right handle
    resizeHandle?.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      evt.stopPropagation();
      const startX = evt.clientX;
      const startY = evt.clientY;
      const startW = group.rw * this.refSize.width;
      const startH = group.rh * this.refSize.height;

      // Pre-compute content-aware minimum: blocks have proportional positions,
      // so shrinking moves them inward. The limit is when any block's far edge
      // reaches the group boundary: pos.rx * W + boxW = W → W = boxW / (1 - pos.rx)
      const boxW = this.getScaledBoxWidth();
      const boxH = this.getScaledBoxHeight();
      let minContentW = GROUP_MIN_PX_W;
      let minContentH = GROUP_MIN_PX_H;
      for (const [, pos] of this.positions) {
        if (pos.groupId !== group.id) continue;
        if (pos.rx < 1) minContentW = Math.max(minContentW, boxW / (1 - pos.rx));
        if (pos.ry < 1) minContentH = Math.max(minContentH, boxH / (1 - pos.ry));
      }

      let resized = false;
      const onMove = (moveEvt: PointerEvent): void => {
        resized = true;
        const newW = Math.max(minContentW, startW + (moveEvt.clientX - startX));
        const newH = Math.max(minContentH, startH + (moveEvt.clientY - startY));
        group.rw = newW / this.refSize.width;
        group.rh = newH / this.refSize.height;
        el.style.width = `${newW}px`;
        el.style.height = `${newH}px`;
        this.repositionGroupChildren(group);
      };
      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        if (resized) this.persistState();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });

    // Move group via header area only (body clicks fall through for marquee selection)
    const header = el.querySelector<HTMLElement>(".fmo-concern-map-group-header");
    header?.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      const target = evt.target as HTMLElement;
      if (target.closest(".fmo-concern-map-group-close")) return;
      if (target.getAttribute("contenteditable") === "true") return;
      evt.preventDefault();
      evt.stopPropagation();

      const startX = evt.clientX;
      const startY = evt.clientY;
      const startPx = this.toPixelX(group.rx);
      const startPy = this.toPixelY(group.ry);
      let dragging = false;

      const onMove = (moveEvt: PointerEvent): void => {
        const dx = moveEvt.clientX - startX;
        const dy = moveEvt.clientY - startY;
        if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        dragging = true;
        const newPx = Math.max(0, startPx + dx);
        const newPy = Math.max(0, startPy + dy);
        group.rx = this.toRelX(newPx);
        group.ry = this.toRelY(newPy);
        el.style.left = `${newPx}px`;
        el.style.top = `${newPy}px`;
        this.repositionGroupChildren(group);
      };
      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        if (dragging) this.persistState();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });
  }

  private attachBoxInteraction(
    boxEl: HTMLElement,
    task: TaskItem,
    pos: BoxPosition
  ): void {
    boxEl.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      evt.stopPropagation();

      const isMultiKey = evt.ctrlKey || evt.metaKey;
      const wasSelected = this.selectedPaths.has(task.path);

      if (isMultiKey) {
        if (wasSelected) {
          this.selectedPaths.delete(task.path);
        } else {
          this.selectedPaths.add(task.path);
        }
        this.updateSelectionVisuals();
      } else if (!wasSelected) {
        this.selectedPaths.clear();
        this.selectedPaths.add(task.path);
        this.updateSelectionVisuals();
      }

      if (!this.selectedPaths.has(task.path)) return;

      const startX = evt.clientX;
      const startY = evt.clientY;

      // Snapshot absolute pixel positions for all selected blocks
      const dragUsableW = this.usableWidth();
      const dragUsableH = this.usableHeight();
      const startPixels = new Map<string, { px: number; py: number }>();
      for (const path of this.selectedPaths) {
        const abs = this.getAbsolutePixelPos(path);
        if (abs) startPixels.set(path, abs);
      }

      let dragging = false;

      const onMove = (moveEvt: PointerEvent): void => {
        const dx = moveEvt.clientX - startX;
        const dy = moveEvt.clientY - startY;
        if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;

        if (!dragging) {
          dragging = true;
          // Lift all selected blocks out of groups for the duration of drag
          for (const path of startPixels.keys()) {
            const p = this.positions.get(path);
            if (p?.groupId) delete p.groupId;
          }
        }

        for (const [path, start] of startPixels) {
          const p = this.positions.get(path);
          const el = this.boxElements.get(path);
          if (!p || !el) continue;
          const newPx = Math.max(0, start.px + dx);
          const newPy = Math.max(0, start.py + dy);
          p.rx = newPx / dragUsableW;
          p.ry = newPy / dragUsableH;
          el.style.left = `${newPx}px`;
          el.style.top = `${newPy}px`;
          el.classList.add("fmo-concern-map-box-dragging");
        }
      };

      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        for (const path of startPixels.keys()) {
          this.boxElements.get(path)?.classList.remove("fmo-concern-map-box-dragging");
        }
        if (dragging) {
          // Check group containment for each dragged block
          const boxW = this.getScaledBoxWidth();
          const boxH = this.getScaledBoxHeight();
          for (const path of startPixels.keys()) {
            const p = this.positions.get(path);
            if (!p) continue;
            const absPx = p.rx * dragUsableW;
            const absPy = p.ry * dragUsableH;
            const centerX = absPx + boxW / 2;
            const centerY = absPy + boxH / 2;
            const targetGroup = this.findGroupAtPoint(centerX, centerY);
            if (targetGroup) {
              const r = this.getGroupPixelRect(targetGroup);
              p.rx = (absPx - r.x) / r.w;
              p.ry = (absPy - r.y) / r.h;
              p.groupId = targetGroup.id;
            }
          }
          this.persistState();
        } else if (!isMultiKey && wasSelected) {
          this.selectedPaths.clear();
          this.selectedPaths.add(task.path);
          this.updateSelectionVisuals();
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });

    boxEl.addEventListener("dblclick", (evt) => {
      evt.preventDefault();
      const inlineItem = isInlineItem(task) ? task : null;
      void this.plugin.openFile(
        inlineItem ? inlineItem.parentPath : task.path,
        inlineItem?.line
      );
    });
  }

  private updateSelectionVisuals(): void {
    for (const [path, el] of this.boxElements) {
      el.classList.toggle("fmo-concern-map-box-selected", this.selectedPaths.has(path));
    }
  }

  private attachMarqueeSelection(stageEl: HTMLElement): void {
    stageEl.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      // Allow marquee from stage or group body (but not from boxes, headers, or resize handles)
      const target = evt.target as HTMLElement;
      if (target !== stageEl && !target.classList.contains("fmo-concern-map-group")) return;
      evt.preventDefault();

      const isAdditive = evt.ctrlKey || evt.metaKey;
      const stageRect = stageEl.getBoundingClientRect();

      const anchorX = evt.clientX - stageRect.left;
      const anchorY = evt.clientY - stageRect.top;

      const marquee = stageEl.createEl("div", { cls: "fmo-concern-map-marquee" });
      let dragging = false;

      const basePaths = isAdditive ? new Set(this.selectedPaths) : new Set<string>();

      const onMove = (moveEvt: PointerEvent): void => {
        const curX = moveEvt.clientX - stageRect.left;
        const curY = moveEvt.clientY - stageRect.top;

        if (!dragging && Math.abs(curX - anchorX) + Math.abs(curY - anchorY) < DRAG_THRESHOLD) return;
        dragging = true;

        const left = Math.min(anchorX, curX);
        const top = Math.min(anchorY, curY);
        const width = Math.abs(curX - anchorX);
        const height = Math.abs(curY - anchorY);

        marquee.style.left = `${left}px`;
        marquee.style.top = `${top}px`;
        marquee.style.width = `${width}px`;
        marquee.style.height = `${height}px`;
        // eslint-disable-next-line obsidianmd/no-static-styles-assignment
        marquee.style.display = "block";

        const boxW = this.getScaledBoxWidth();
        const boxH = this.getScaledBoxHeight();
        const marqueeRight = left + width;
        const marqueeBottom = top + height;

        this.selectedPaths = new Set(basePaths);
        for (const [path] of this.boxElements) {
          const abs = this.getAbsolutePixelPos(path);
          if (!abs) continue;
          if (abs.px < marqueeRight && abs.px + boxW > left && abs.py < marqueeBottom && abs.py + boxH > top) {
            this.selectedPaths.add(path);
          }
        }
        this.updateSelectionVisuals();
      };

      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        marquee.remove();
        if (!dragging && !isAdditive) {
          this.selectedPaths.clear();
          this.updateSelectionVisuals();
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });
  }

  // ── Filtering ─────────────────────────────────────────────────────────

  private applyFilters(tasks: TaskItem[]): TaskItem[] {
    const scopePaths = collectScopePaths(tasks, this.parentByPath, this.filterState.rootPath);
    let filtered = tasks.filter((task) => scopePaths.has(task.path));

    if (!this.filterState.showInlineTasks) {
      filtered = filtered.filter((task) => !isInlineItem(task));
    }

    if (this.filterState.priorityOnly) {
      filtered = filtered.filter((task) => getItemPriorityRank(task) < 100);
    }

    const query = this.filterState.showClosed
      ? this.filterState.query
      : withClosedFilter(this.filterState.query);
    filtered = this.filterTasksByQuery(filtered, query);

    if (this.filterState.trackedOnly) {
      const ownSeconds = this.getOwnSecondsByPath(filtered);
      filtered = filtered.filter(
        (task) => (ownSeconds.get(task.path) ?? 0) >= MIN_TRACKED_SECONDS_PER_PERIOD
      );
    }

    if (this.filterState.showParents) {
      const matchedPaths = new Set(filtered.map((task) => task.path));
      const visiblePaths = collectPathsWithParents(matchedPaths, this.parentByPath, scopePaths);
      filtered = tasks.filter((task) => visiblePaths.has(task.path));
    }

    return this.sortTasks(filtered);
  }

  private sortTasks(tasks: TaskItem[]): TaskItem[] {
    const sorted = [...tasks];
    if (this.filterState.sortMode === "priority") {
      sorted.sort((a, b) => getItemPriorityRank(a) - getItemPriorityRank(b));
    } else {
      sorted.sort((a, b) => {
        const aStart = this.plugin.timeData.getLatestTrackedStartMsForRange(
          a.path,
          this.filterState.range
        );
        const bStart = this.plugin.timeData.getLatestTrackedStartMsForRange(
          b.path,
          this.filterState.range
        );
        return bStart - aStart;
      });
    }
    return sorted;
  }

  private getOwnSecondsByPath(tasks: TaskItem[]): Map<string, number> {
    return this.plugin.timeData.getOwnSecondsByPath(tasks, this.filterState.range);
  }

  // ── Positioning ───────────────────────────────────────────────────────

  /**
   * When inline task paths change (line shifts, cross-file moves, promotions),
   * transfer orphaned positions to the new paths.
   * Phase 1: basename matching (handles cross-file moves and promotions).
   * Phase 2: per-file line-order matching (handles line shifts within a file).
   */
  private migrateShiftedInlinePositions(filtered: TaskItem[]): void {
    const filteredPaths = new Set(filtered.map((t) => t.path));

    // Collect all orphaned inline positions
    type Orphan = { path: string; filePath: string; line: number; pos: { rx: number; ry: number } };
    const allOrphans: Orphan[] = [];
    for (const [path, pos] of this.positions) {
      if (filteredPaths.has(path)) continue;
      const parsed = parseInlinePath(path);
      if (!parsed) continue;
      allOrphans.push({ path, filePath: parsed.filePath, line: parsed.line, pos });
    }
    if (allOrphans.length === 0) return;

    // Phase 1: Basename matching — moved/promoted tasks keep their position
    const orphansByName = new Map<string, Orphan>();
    for (const orphan of allOrphans) {
      const name = this.inlineBasenames.get(orphan.path);
      if (name && !orphansByName.has(name)) orphansByName.set(name, orphan);
    }

    const matchedOrphans = new Set<string>();
    const matchedTasks = new Set<string>();

    for (const task of filtered) {
      if (this.positions.has(task.path)) continue;
      const orphan = orphansByName.get(task.basename);
      if (!orphan) continue;
      this.positions.set(task.path, orphan.pos);
      this.positions.delete(orphan.path);
      matchedOrphans.add(orphan.path);
      matchedTasks.add(task.path);
      orphansByName.delete(task.basename);
    }

    // Phase 2: Per-file line-order matching for remaining shifts
    const orphansByFile = new Map<string, Orphan[]>();
    for (const orphan of allOrphans) {
      if (matchedOrphans.has(orphan.path)) continue;
      let list = orphansByFile.get(orphan.filePath);
      if (!list) { list = []; orphansByFile.set(orphan.filePath, list); }
      list.push(orphan);
    }

    const unposByFile = new Map<string, InlineTaskItem[]>();
    for (const task of filtered) {
      if (!isInlineItem(task) || this.positions.has(task.path) || matchedTasks.has(task.path)) continue;
      let list = unposByFile.get(task.parentPath);
      if (!list) { list = []; unposByFile.set(task.parentPath, list); }
      list.push(task);
    }

    for (const [parentFile, orphans] of orphansByFile) {
      const unpos = unposByFile.get(parentFile);
      if (!unpos || unpos.length === 0) continue;

      orphans.sort((a, b) => a.line - b.line);
      unpos.sort((a, b) => a.line - b.line);

      const count = Math.min(orphans.length, unpos.length);
      for (let i = 0; i < count; i++) {
        this.positions.set(unpos[i].path, orphans[i].pos);
        this.positions.delete(orphans[i].path);
      }
    }
  }

  /**
   * During a cross-file move, the task temporarily exists in both source and target.
   * The target render sees the new task as unpositioned. Copy the position from the
   * existing twin so it doesn't get a fresh grid slot before the source is cleaned up.
   */
  private copyPositionsForInlineTwins(filtered: TaskItem[]): void {
    const positioned = new Map<string, { parentPath: string; pos: { rx: number; ry: number } }>();
    for (const task of filtered) {
      if (!isInlineItem(task)) continue;
      const pos = this.positions.get(task.path);
      if (pos) positioned.set(task.basename, { parentPath: task.parentPath, pos });
    }
    for (const task of filtered) {
      if (!isInlineItem(task) || this.positions.has(task.path)) continue;
      const twin = positioned.get(task.basename);
      if (twin && twin.parentPath !== task.parentPath) {
        this.positions.set(task.path, { rx: twin.pos.rx, ry: twin.pos.ry });
      }
    }
  }

  private ensurePositions(filtered: TaskItem[]): void {
    const unpositioned = filtered.filter((task) => !this.positions.has(task.path));
    if (unpositioned.length === 0) return;

    const boxW = this.getScaledBoxWidth();
    const boxH = this.getScaledBoxHeight();
    const cellW = boxW + MAP_GRID_GAP_X;
    const cellH = boxH + MAP_GRID_GAP_Y;
    const cols = Math.max(1, Math.floor((this.refSize.width - MAP_GRID_PADDING * 2) / cellW));

    // Build set of occupied grid cells from existing positions
    const occupied = new Set<string>();
    for (const [path] of this.positions) {
      const abs = this.getAbsolutePixelPos(path);
      if (!abs) continue;
      const col = Math.round((abs.px - MAP_GRID_PADDING) / cellW);
      const row = Math.round((abs.py - MAP_GRID_PADDING) / cellH);
      if (col >= 0 && row >= 0) occupied.add(`${col},${row}`);
    }

    // Place new items in the first available grid cells, scanning from top-left
    let scanCol = 0;
    let scanRow = 0;
    for (const task of unpositioned) {
      while (occupied.has(`${scanCol},${scanRow}`)) {
        scanCol++;
        if (scanCol >= cols) { scanCol = 0; scanRow++; }
      }
      const px = MAP_GRID_PADDING + scanCol * cellW;
      const py = MAP_GRID_PADDING + scanRow * cellH;
      this.positions.set(task.path, {
        rx: this.toRelX(px),
        ry: this.toRelY(py)
      });
      occupied.add(`${scanCol},${scanRow}`);
      scanCol++;
      if (scanCol >= cols) { scanCol = 0; scanRow++; }
    }

    this.persistState();
  }

  // ── Keyboard ──────────────────────────────────────────────────────────

  private ensurePriorityHotkeyListener(): void {
    if (this.keydownRegistered) return;
    this.keydownRegistered = true;
    this.registerDomEvent(document, "keydown", (event) => {
      handlePriorityHotkey(event, this.hoveredConcernPath, {
        onReparent: (path) => this.plugin.reparentConcernInteractive(path),
        onPriorityDigit: (path, digit) => void this.applyPriority(path, digit),
        onPriorityClear: (path) => void this.clearPriority(path),
      });
    });
  }

  private async applyPriority(path: string, digit: string): Promise<void> {
    const changed = await this.plugin.setPriorityForPath(path, digit);
    if (!changed) return;
    await this.render();
  }

  private async clearPriority(path: string): Promise<void> {
    const changed = await this.plugin.clearPriorityForPath(path);
    if (!changed) return;
    await this.render();
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private loadPersistedState(): void {
    const raw = this.plugin.getConcernMapState().trim();
    if (!raw) return;
    // Skip re-parse if the persisted data hasn't changed (avoids clobbering
    // in-memory state during mid-drag when an unrelated vault event triggers render)
    if (raw === this.lastLoadedStateRaw) return;
    this.lastLoadedStateRaw = raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!this.isPersistedState(parsed)) return;

    const clampNum = (v: unknown, min: number, max: number, def: number): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
    const optBool = (v: unknown, def: boolean): boolean => typeof v === "boolean" ? v : def;
    const f = parsed.filter as Record<string, unknown>;

    const fontSize = clampNum(f.fontSize, MAP_MIN_FONT_SIZE, MAP_MAX_FONT_SIZE, MAP_BASE_FONT_SIZE);
    const boxScale = clampNum(f.boxScale, MAP_MIN_BOX_SCALE, MAP_MAX_BOX_SCALE, MAP_BASE_BOX_SCALE);
    const boxPadding = clampNum(f.boxPadding, MAP_MIN_BOX_PADDING, MAP_MAX_BOX_PADDING, MAP_BASE_BOX_PADDING);
    const showStatus = optBool(f.showStatus, true);
    const colorByPriority = optBool(f.colorByPriority, false);
    const colorByStatus = optBool(f.colorByStatus, false);
    const showParentLabel = optBool(f.showParentLabel, false);
    this.filterState = { ...parsed.filter, fontSize, boxScale, boxPadding, showStatus, colorByPriority, colorByStatus, showParentLabel };

    this.positions = new Map();
    for (const [path, pos] of Object.entries(parsed.positions)) {
      if (isRelativePosition(pos)) {
        const entry: BoxPosition = { rx: pos.rx, ry: pos.ry };
        if (pos.groupId) entry.groupId = pos.groupId;
        this.positions.set(path, entry);
      }
    }

    this.groups = new Map();
    if (parsed.groups) {
      for (const [id, g] of Object.entries(parsed.groups)) {
        if (
          typeof g.title === "string" &&
          typeof g.rx === "number" && Number.isFinite(g.rx) &&
          typeof g.ry === "number" && Number.isFinite(g.ry) &&
          typeof g.rw === "number" && Number.isFinite(g.rw) &&
          typeof g.rh === "number" && Number.isFinite(g.rh) &&
          typeof g.color === "number" && Number.isFinite(g.color)
        ) {
          this.groups.set(id, { id, title: g.title, rx: g.rx, ry: g.ry, rw: g.rw, rh: g.rh, color: g.color });
        }
      }
    }

    // Clean stale groupId references
    for (const pos of this.positions.values()) {
      if (pos.groupId && !this.groups.has(pos.groupId)) delete pos.groupId;
    }
  }

  private persistState(): void {
    const r4 = (v: number): number => Math.round(v * 10000) / 10000;

    const positions: Record<string, BoxPosition> = {};
    for (const [path, pos] of this.positions) {
      // Persist using stable ID when available, fall back to path
      const key = this.pathToStableId.get(path) ?? path;
      const entry: BoxPosition = { rx: r4(pos.rx), ry: r4(pos.ry) };
      if (pos.groupId) entry.groupId = pos.groupId;
      positions[key] = entry;
    }

    const groups: Record<string, Omit<GroupContainer, "id">> = {};
    for (const [id, g] of this.groups) {
      groups[id] = {
        title: g.title,
        rx: r4(g.rx), ry: r4(g.ry),
        rw: r4(g.rw), rh: r4(g.rh),
        color: g.color,
      };
    }

    const state: PersistedConcernMapState = {
      version: CONCERN_MAP_VERSION,
      positions,
      groups: Object.keys(groups).length > 0 ? groups : undefined,
      filter: { ...this.filterState }
    };
    this.plugin.setConcernMapState(JSON.stringify(state));
  }

  private isPersistedState(value: unknown): value is PersistedConcernMapState {
    if (typeof value !== "object" || value === null) return false;
    const obj = value as Record<string, unknown>;
    if (obj.version !== 2 && obj.version !== CONCERN_MAP_VERSION) return false;
    if (typeof obj.positions !== "object" || obj.positions === null) return false;
    if (typeof obj.filter !== "object" || obj.filter === null) return false;

    const f = obj.filter as Record<string, unknown>;
    if (typeof f.rootPath !== "string") return false;
    if (typeof f.query !== "string") return false;
    if (!OUTLINE_SORT_OPTIONS.some((o) => o.value === f.sortMode)) return false;
    if (!OUTLINE_RANGE_OPTIONS.some((o) => o.value === f.range)) return false;
    if (typeof f.trackedOnly !== "boolean") return false;
    if (typeof f.showParents !== "boolean") return false;
    if (typeof f.showInlineTasks !== "boolean") return false;
    if (typeof f.priorityOnly !== "boolean") return false;
    if (typeof f.showClosed !== "boolean") return false;
    if (f.showStatus !== undefined && typeof f.showStatus !== "boolean") return false;
    if (f.fontSize !== undefined && (typeof f.fontSize !== "number" || !Number.isFinite(f.fontSize))) return false;

    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private captureViewportScroll(): void {
    const viewport = this.contentEl.querySelector<HTMLElement>(".fmo-concern-map-viewport");
    if (!viewport) return;
    this.viewportScroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
  }
}
