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
import type LifeDashboardPlugin from "../../plugin";
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
  colorByPriority: boolean;
  colorByStatus: boolean;
};

type PersistedConcernMapState = {
  version: 2;
  positions: Record<string, { rx: number; ry: number }>;
  filter: ConcernMapFilterState;
};

const MAP_BASE_BOX_WIDTH = 126;
const MAP_BASE_BOX_HEIGHT = 56;
const MAP_BASE_FONT_SIZE = 13;
const MAP_MIN_FONT_SIZE = 9;
const MAP_MAX_FONT_SIZE = 20;
const MAP_GRID_GAP_X = 20;
const MAP_GRID_GAP_Y = 16;
const MAP_GRID_PADDING = 24;
const CONCERN_MAP_VERSION = 2;
const DRAG_THRESHOLD = 4;
const DEFAULT_REF_WIDTH = 600;
const DEFAULT_REF_HEIGHT = 400;

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

function isRelativePosition(value: unknown): value is { rx: number; ry: number } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.rx === "number" && Number.isFinite(obj.rx) &&
    typeof obj.ry === "number" && Number.isFinite(obj.ry)
  );
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
    colorByPriority: false,
    colorByStatus: false
  };
  /** Positions stored as fractions of viewport dimensions. */
  private positions = new Map<string, { rx: number; ry: number }>();
  private parentByPath = new Map<string, string>();
  private selectedPaths = new Set<string>();
  private boxElements = new Map<string, HTMLElement>();
  private hoveredConcernPath: string | null = null;
  private stateLoaded = false;
  private keydownRegistered = false;
  private viewportScroll = { left: 0, top: 0 };
  private refSize = { width: DEFAULT_REF_WIDTH, height: DEFAULT_REF_HEIGHT };
  private resizeObserver: ResizeObserver | null = null;

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_CONCERN_MAP;
  }

  getDisplayText(): string {
    return "Concern Map";
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

    if (!this.stateLoaded) {
      this.loadPersistedState();
      this.stateLoaded = true;
    }

    const tasks = this.plugin.getTaskTreeItems();
    this.parentByPath = buildParentPathMap(
      tasks,
      (parentRaw, sourcePath) => this.resolveParentPath(parentRaw, sourcePath)
    );

    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concern Map" });
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

    this.renderControls(controlsRow, tasks, rerenderCanvas);
    countSpan = this.renderCanvasTools(controlsRow, canvasArea, tasks, rerenderCanvas);
    rerenderCanvas();
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
    const rootSelect = rootRow.createEl("select", { cls: "fmo-outline-sort-select" }) as HTMLSelectElement;
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
    const rangeSelect = rangeRow.createEl("select", { cls: "fmo-outline-sort-select" }) as HTMLSelectElement;
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
    const sortSelect = sortRow.createEl("select", { cls: "fmo-outline-sort-select" }) as HTMLSelectElement;
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
    }) as HTMLInputElement;
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

    const sizeLabel = tools.createEl("label", { cls: "fmo-concern-map-size-label" });
    sizeLabel.createEl("span", { text: "Size" });
    const sizeSlider = sizeLabel.createEl("input", {
      cls: "fmo-concern-map-size-slider",
      attr: { type: "range", min: String(MAP_MIN_FONT_SIZE), max: String(MAP_MAX_FONT_SIZE), step: "1" }
    }) as HTMLInputElement;
    sizeSlider.value = String(this.filterState.fontSize);
    sizeSlider.addEventListener("input", () => {
      this.filterState.fontSize = Number(sizeSlider.value);
      const stageEl = canvasArea.querySelector<HTMLElement>(".fmo-concern-map-stage");
      if (stageEl) {
        stageEl.style.setProperty("--map-font-size", `${this.filterState.fontSize}px`);
        stageEl.style.setProperty("--map-box-width", `${this.getScaledBoxWidth()}px`);
      }
    });
    sizeSlider.addEventListener("change", () => {
      this.filterState.fontSize = Number(sizeSlider.value);
      this.persistState();
      rerenderCanvas();
    });

    const colorRow = tools.createEl("div", { cls: "fmo-concern-map-tools-buttons" });
    this.renderFlag(colorRow, "Priority colors", this.filterState.colorByPriority, (v) => {
      this.filterState.colorByPriority = v;
      this.persistState();
      rerenderCanvas();
    });
    this.renderFlag(colorRow, "Status colors", this.filterState.colorByStatus, (v) => {
      this.filterState.colorByStatus = v;
      this.persistState();
      rerenderCanvas();
    });

    const buttonsRow = tools.createEl("div", { cls: "fmo-concern-map-tools-buttons" });

    const resetBtn = buttonsRow.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Reset positions",
      attr: { type: "button" }
    });
    setTooltip(resetBtn, "Re-arrange all boxes into a grid.");
    resetBtn.addEventListener("click", () => {
      this.positions.clear();
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
      if (!pos) continue;
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
    return this.filterState.fontSize / MAP_BASE_FONT_SIZE;
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

    // Update reference size from viewport (used for fraction↔pixel conversion)
    const vpWidth = viewport.clientWidth || this.contentEl.clientWidth || DEFAULT_REF_WIDTH;
    const vpHeight = viewport.clientHeight || this.contentEl.clientHeight || DEFAULT_REF_HEIGHT;
    this.refSize = { width: vpWidth, height: vpHeight };

    this.migrateShiftedInlinePositions(filtered);
    this.ensurePositions(filtered);

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
        const uw = this.usableWidth();
        const uh = this.usableHeight();
        for (const [path, el] of this.boxElements) {
          const pos = this.positions.get(path);
          if (!pos) continue;
          el.style.left = `${pos.rx * uw}px`;
          el.style.top = `${pos.ry * uh}px`;
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

    const px = this.toPixelX(pos.rx);
    const py = this.toPixelY(pos.ry);

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

  private attachBoxInteraction(
    boxEl: HTMLElement,
    task: TaskItem,
    pos: { rx: number; ry: number }
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

      // Snapshot start pixel positions and usable dimensions for stable fraction conversion
      const dragUsableW = this.usableWidth();
      const dragUsableH = this.usableHeight();
      const startPixels = new Map<string, { px: number; py: number }>();
      for (const path of this.selectedPaths) {
        const p = this.positions.get(path);
        if (p) startPixels.set(path, { px: p.rx * dragUsableW, py: p.ry * dragUsableH });
      }

      let dragging = false;

      const onMove = (moveEvt: PointerEvent): void => {
        const dx = moveEvt.clientX - startX;
        const dy = moveEvt.clientY - startY;
        if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        dragging = true;

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
      if (evt.target !== stageEl) return;
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
        marquee.style.display = "block";

        const boxW = this.getScaledBoxWidth();
        const boxH = this.getScaledBoxHeight();
        const marqueeRight = left + width;
        const marqueeBottom = top + height;

        this.selectedPaths = new Set(basePaths);
        for (const [path] of this.boxElements) {
          const pos = this.positions.get(path);
          if (!pos) continue;
          const bx = this.toPixelX(pos.rx);
          const by = this.toPixelY(pos.ry);
          if (bx < marqueeRight && bx + boxW > left && by < marqueeBottom && by + boxH > top) {
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
    const map = new Map<string, number>();
    for (const task of tasks) {
      if (isInlineItem(task)) {
        map.set(task.path, 0);
      } else {
        map.set(
          task.path,
          this.plugin.timeData.getTrackedSecondsForRange(task.path, this.filterState.range)
        );
      }
    }
    return map;
  }

  // ── Positioning ───────────────────────────────────────────────────────

  /**
   * When inline task line numbers shift (e.g., a task is moved between files),
   * their paths change but the tasks are conceptually the same. Transfer orphaned
   * positions to the new paths by matching within the same parent file in line order.
   */
  private migrateShiftedInlinePositions(filtered: TaskItem[]): void {
    const filteredPaths = new Set(filtered.map((t) => t.path));

    // Collect orphaned inline positions grouped by parent file
    const orphansByFile = new Map<string, Array<{ path: string; line: number; pos: { rx: number; ry: number } }>>();
    for (const [path, pos] of this.positions) {
      if (filteredPaths.has(path)) continue;
      const parsed = parseInlinePath(path);
      if (!parsed) continue;
      let list = orphansByFile.get(parsed.filePath);
      if (!list) { list = []; orphansByFile.set(parsed.filePath, list); }
      list.push({ path, line: parsed.line, pos });
    }
    if (orphansByFile.size === 0) return;

    // Collect unpositioned inline tasks grouped by parent file
    const unposByFile = new Map<string, InlineTaskItem[]>();
    for (const task of filtered) {
      if (!isInlineItem(task) || this.positions.has(task.path)) continue;
      let list = unposByFile.get(task.parentPath);
      if (!list) { list = []; unposByFile.set(task.parentPath, list); }
      list.push(task);
    }

    // Match orphans to unpositioned tasks by line order within each parent file
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
    for (const pos of this.positions.values()) {
      const px = this.toPixelX(pos.rx);
      const py = this.toPixelY(pos.ry);
      const col = Math.round((px - MAP_GRID_PADDING) / cellW);
      const row = Math.round((py - MAP_GRID_PADDING) / cellH);
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!this.isPersistedState(parsed)) return;

    const fontSize = typeof parsed.filter.fontSize === "number" && Number.isFinite(parsed.filter.fontSize)
      ? Math.max(MAP_MIN_FONT_SIZE, Math.min(MAP_MAX_FONT_SIZE, parsed.filter.fontSize))
      : MAP_BASE_FONT_SIZE;
    const showStatus = typeof parsed.filter.showStatus === "boolean" ? parsed.filter.showStatus : true;
    const colorByPriority = typeof parsed.filter.colorByPriority === "boolean" ? parsed.filter.colorByPriority : false;
    const colorByStatus = typeof parsed.filter.colorByStatus === "boolean" ? parsed.filter.colorByStatus : false;
    this.filterState = { ...parsed.filter, fontSize, showStatus, colorByPriority, colorByStatus };

    this.positions = new Map();
    for (const [path, pos] of Object.entries(parsed.positions)) {
      if (isRelativePosition(pos)) {
        this.positions.set(path, { rx: pos.rx, ry: pos.ry });
      }
    }
  }

  private persistState(): void {
    const positions: Record<string, { rx: number; ry: number }> = {};
    for (const [path, pos] of this.positions) {
      positions[path] = {
        rx: Math.round(pos.rx * 10000) / 10000,
        ry: Math.round(pos.ry * 10000) / 10000
      };
    }

    const state: PersistedConcernMapState = {
      version: CONCERN_MAP_VERSION,
      positions,
      filter: { ...this.filterState }
    };
    this.plugin.setConcernMapState(JSON.stringify(state));
  }

  private isPersistedState(value: unknown): value is PersistedConcernMapState {
    if (typeof value !== "object" || value === null) return false;
    const obj = value as Record<string, unknown>;
    if (obj.version !== CONCERN_MAP_VERSION) return false;
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
