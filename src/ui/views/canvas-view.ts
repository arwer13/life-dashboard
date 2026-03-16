import { setTooltip, type WorkspaceLeaf } from "obsidian";
import { DISPLAY_VERSION } from "../../version";
import type { TaskItem } from "../../models/types";
import {
  VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
  OUTLINE_RANGE_OPTIONS,
  OUTLINE_SORT_OPTIONS,
  type OutlineSortMode
} from "../../models/view-types";
import type LifeDashboardPlugin from "../../plugin";
import type { OutlineTimeRange } from "../../plugin";
import { LifeDashboardBaseView } from "./base-view";
import { ConcernTreePanel } from "../concern-tree-panel";

type CanvasTreeDraft = {
  id: string;
  title: string;
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsedNodePaths: Set<string>;
};

type PersistedCanvasTreeDraft = {
  id: string;
  title: string;
  rootPath: string;
  query: string;
  sortMode: OutlineSortMode;
  range: OutlineTimeRange;
  trackedOnly: boolean;
  showParents: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsedNodePaths: string[];
};

type PersistedCanvasDraftState = {
  version: 1;
  nextTreeOrdinal: number;
  trees: PersistedCanvasTreeDraft[];
};

const CANVAS_STAGE_WIDTH = 3600;
const CANVAS_STAGE_HEIGHT = 2400;
const CANVAS_CARD_DEFAULT_WIDTH = 380;
const CANVAS_CARD_DEFAULT_HEIGHT = 560;
const CANVAS_CARD_MIN_WIDTH = 320;
const CANVAS_CARD_MIN_HEIGHT = 280;
const CANVAS_DRAFT_VERSION = 1;

export class LifeDashboardConcernCanvasView extends LifeDashboardBaseView {
  private canvasTrees: CanvasTreeDraft[] = [];
  private nextCanvasTreeOrdinal = 1;
  private canvasTreesLoaded = false;
  private canvasTreePanelScrollById = new Map<string, number>();
  private canvasViewportScroll = { left: 0, top: 0 };

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_CANVAS;
  }

  getDisplayText(): string {
    return "Concerns Canvas";
  }

  getIcon(): string {
    return "layout-grid";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    this.captureCanvasViewportScrollState();
    this.captureCanvasTreePanelScrollState();
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");
    contentEl.addClass("fmo-canvas-view");

    const tasks = this.plugin.getTaskTreeItems();
    this.ensureCanvasTrees(tasks);

    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Concerns Canvas (draft)" });
    headerTop.createEl("span", { cls: "fmo-version", text: `v${DISPLAY_VERSION}` });

    const toolbar = header.createEl("div", { cls: "fmo-canvas-toolbar" });
    const addBtn = toolbar.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Add tree",
      attr: { type: "button" }
    });
    setTooltip(addBtn, "Create another concern tree card that you can drag anywhere.");
    addBtn.addEventListener("click", () => {
      const slot = this.canvasTrees.length;
      this.canvasTrees.push(
        this.createCanvasTreeDraft({
          x: 56 + (slot % 4) * 420,
          y: 70 + Math.floor(slot / 4) * 290
        })
      );
      this.persistCanvasTrees();
      void this.render();
    });

    const resetBtn = toolbar.createEl("button", {
      cls: "fmo-outline-range-btn",
      text: "Reset layout",
      attr: { type: "button" }
    });
    setTooltip(resetBtn, "Repack all trees into a readable grid layout.");
    resetBtn.addEventListener("click", () => {
      this.canvasTrees.forEach((tree, index) => {
        tree.x = 56 + (index % 4) * 420;
        tree.y = 70 + Math.floor(index / 4) * 290;
      });
      this.persistCanvasTrees();
      void this.render();
    });

    toolbar.createEl("span", {
      cls: "fmo-subheader fmo-canvas-toolbar-meta",
      text: `${this.canvasTrees.length} tree${this.canvasTrees.length === 1 ? "" : "s"}`
    });

    const note = header.createEl("div", {
      cls: "fmo-subheader",
      text: "Drag cards, pick any root, then tune filter/sort per tree."
    });
    setTooltip(
      note,
      "Canvas layout and per-tree controls are saved between reopenings."
    );

    const viewport = contentEl.createEl("div", { cls: "fmo-canvas-viewport" });
    const stage = viewport.createEl("div", { cls: "fmo-canvas-stage" });
    stage.style.width = `${CANVAS_STAGE_WIDTH}px`;
    stage.style.height = `${CANVAS_STAGE_HEIGHT}px`;

    for (const tree of this.canvasTrees) {
      this.renderCanvasTreeCard(stage, tree, tasks);
    }
    viewport.scrollLeft = this.canvasViewportScroll.left;
    viewport.scrollTop = this.canvasViewportScroll.top;
  }

  private ensureCanvasTrees(tasks: TaskItem[]): void {
    if (!this.canvasTreesLoaded) {
      this.loadPersistedCanvasTrees();
      this.canvasTreesLoaded = true;
    }

    const validPaths = new Set(tasks.map((task) => task.path));
    let changed = false;
    this.canvasTrees = this.canvasTrees.map((tree) => {
      const normalizedRootPath =
        tree.rootPath.length > 0 && validPaths.has(tree.rootPath) ? tree.rootPath : "";
      if (normalizedRootPath !== tree.rootPath) {
        changed = true;
        tree.rootPath = normalizedRootPath;
      }
      return tree;
    });

    if (this.canvasTrees.length === 0) {
      this.canvasTrees = this.createInitialCanvasTrees(tasks);
      changed = true;
    }

    if (changed) {
      this.persistCanvasTrees();
    }
  }

  private loadPersistedCanvasTrees(): void {
    const raw = this.plugin.getCanvasDraftState().trim();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!this.isPersistedCanvasDraftState(parsed)) {
      return;
    }

    const trees = parsed.trees.map((tree) => this.hydratePersistedCanvasTree(tree));
    if (trees.length === 0) return;

    this.canvasTrees = trees;
    const inferredNext = this.inferNextCanvasTreeOrdinal(this.canvasTrees);
    const savedNext = Math.max(1, Math.floor(parsed.nextTreeOrdinal));
    this.nextCanvasTreeOrdinal = Math.max(savedNext, inferredNext, this.nextCanvasTreeOrdinal);
  }

  private persistCanvasTrees(): void {
    const state: PersistedCanvasDraftState = {
      version: CANVAS_DRAFT_VERSION,
      nextTreeOrdinal: this.nextCanvasTreeOrdinal,
      trees: this.canvasTrees.map((tree) => this.serializeCanvasTreeDraft(tree))
    };
    this.plugin.setCanvasDraftState(JSON.stringify(state));
  }

  private isPersistedCanvasDraftState(value: unknown): value is PersistedCanvasDraftState {
    if (!this.isRecord(value)) return false;
    if (value.version !== CANVAS_DRAFT_VERSION) return false;
    if (typeof value.nextTreeOrdinal !== "number" || !Number.isFinite(value.nextTreeOrdinal)) {
      return false;
    }
    if (!Array.isArray(value.trees)) return false;
    return value.trees.every((tree) => this.isPersistedCanvasTreeDraft(tree));
  }

  private isPersistedCanvasTreeDraft(value: unknown): value is PersistedCanvasTreeDraft {
    if (!this.isRecord(value)) return false;
    if (typeof value.id !== "string") return false;
    if (typeof value.title !== "string") return false;
    if (typeof value.rootPath !== "string") return false;
    if (typeof value.query !== "string") return false;
    if (value.sortMode !== "recent" && value.sortMode !== "priority") return false;
    if (!OUTLINE_RANGE_OPTIONS.some((option) => option.value === value.range)) return false;
    if (typeof value.trackedOnly !== "boolean") return false;
    if (typeof value.showParents !== "boolean") return false;
    if (typeof value.collapsed !== "boolean") return false;
    if (typeof value.x !== "number" || !Number.isFinite(value.x)) return false;
    if (typeof value.y !== "number" || !Number.isFinite(value.y)) return false;
    if (typeof value.width !== "number" || !Number.isFinite(value.width)) return false;
    if (typeof value.height !== "number" || !Number.isFinite(value.height)) return false;
    if (!Array.isArray(value.collapsedNodePaths)) return false;
    return value.collapsedNodePaths.every((path) => typeof path === "string");
  }

  private hydratePersistedCanvasTree(tree: PersistedCanvasTreeDraft): CanvasTreeDraft {
    const draft = this.createCanvasTreeDraft();
    const id = tree.id.trim();
    draft.id = id.length > 0 ? id : draft.id;
    draft.title = tree.title.trim() || draft.title;
    draft.rootPath = tree.rootPath.trim();
    draft.query = tree.query;
    draft.sortMode = tree.sortMode;
    draft.range = tree.range;
    draft.trackedOnly = tree.trackedOnly;
    draft.showParents = tree.showParents;
    draft.collapsed = tree.collapsed;
    draft.x = this.clamp(Math.floor(tree.x), 16, CANVAS_STAGE_WIDTH - CANVAS_CARD_MIN_WIDTH - 16);
    draft.y = this.clamp(Math.floor(tree.y), 16, CANVAS_STAGE_HEIGHT - CANVAS_CARD_MIN_HEIGHT - 16);
    draft.width = this.clamp(
      Math.floor(tree.width),
      CANVAS_CARD_MIN_WIDTH,
      CANVAS_STAGE_WIDTH - draft.x - 16
    );
    draft.height = this.clamp(
      Math.floor(tree.height),
      CANVAS_CARD_MIN_HEIGHT,
      CANVAS_STAGE_HEIGHT - draft.y - 16
    );
    draft.collapsedNodePaths = new Set(
      tree.collapsedNodePaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
    );
    return draft;
  }

  private serializeCanvasTreeDraft(tree: CanvasTreeDraft): PersistedCanvasTreeDraft {
    return {
      id: tree.id,
      title: tree.title,
      rootPath: tree.rootPath,
      query: tree.query,
      sortMode: tree.sortMode,
      range: tree.range,
      trackedOnly: tree.trackedOnly,
      showParents: tree.showParents,
      collapsed: tree.collapsed,
      x: Math.round(tree.x),
      y: Math.round(tree.y),
      width: Math.round(tree.width),
      height: Math.round(tree.height),
      collapsedNodePaths: [...tree.collapsedNodePaths]
    };
  }

  private inferNextCanvasTreeOrdinal(trees: CanvasTreeDraft[]): number {
    let next = 1;
    for (const tree of trees) {
      const match = /^tree-(\d+)$/.exec(tree.id);
      if (!match?.[1]) continue;
      const ordinal = Number.parseInt(match[1], 10);
      if (Number.isFinite(ordinal) && ordinal + 1 > next) {
        next = ordinal + 1;
      }
    }
    return next;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private createInitialCanvasTrees(tasks: TaskItem[]): CanvasTreeDraft[] {
    const preferredRoot = this.getPreferredRootPath(tasks);
    const trees: CanvasTreeDraft[] = [
      this.createCanvasTreeDraft({
        title: "Focus now",
        rootPath: preferredRoot,
        trackedOnly: true,
        range: "todayYesterday",
        x: 72,
        y: 72
      }),
      this.createCanvasTreeDraft({
        title: "Priority map",
        sortMode: "priority",
        range: "all",
        trackedOnly: false,
        x: 520,
        y: 210
      })
    ];
    return trees;
  }

  private getPreferredRootPath(tasks: TaskItem[]): string {
    const selectedPath = this.plugin.settings.selectedTaskPath.trim();
    if (selectedPath.length > 0 && tasks.some((task) => task.path === selectedPath)) {
      return selectedPath;
    }

    let bestPath = "";
    let bestSeconds = -1;
    for (const task of tasks) {
      const seconds = this.plugin.timeData.getTrackedSeconds(task.path);
      if (seconds > bestSeconds) {
        bestSeconds = seconds;
        bestPath = task.path;
      }
    }
    return bestPath;
  }

  private createCanvasTreeDraft(overrides: Partial<CanvasTreeDraft> = {}): CanvasTreeDraft {
    const id = `tree-${this.nextCanvasTreeOrdinal}`;
    this.nextCanvasTreeOrdinal += 1;
    const draft: CanvasTreeDraft = {
      id,
      title: "Concern tree",
      rootPath: "",
      query: "",
      sortMode: "recent",
      range: "todayYesterday",
      trackedOnly: true,
      showParents: true,
      collapsed: false,
      x: 64,
      y: 64,
      width: CANVAS_CARD_DEFAULT_WIDTH,
      height: CANVAS_CARD_DEFAULT_HEIGHT,
      collapsedNodePaths: new Set<string>()
    };

    const merged: CanvasTreeDraft = { ...draft, ...overrides };
    merged.collapsedNodePaths = overrides.collapsedNodePaths
      ? new Set(overrides.collapsedNodePaths)
      : new Set(draft.collapsedNodePaths);

    return merged;
  }

  private renderCanvasTreeCard(stageEl: HTMLElement, tree: CanvasTreeDraft, tasks: TaskItem[]): void {
    const card = stageEl.createEl("section", { cls: "fmo-canvas-card" });
    card.dataset.treeId = tree.id;
    card.classList.toggle("fmo-canvas-card-collapsed", tree.collapsed);
    card.style.left = `${tree.x}px`;
    card.style.top = `${tree.y}px`;
    card.style.width = `${tree.width}px`;
    if (!tree.collapsed) {
      card.style.height = `${tree.height}px`;
    }

    const header = card.createEl("div", { cls: "fmo-canvas-card-header" });
    const dragHandle = header.createEl("button", {
      cls: "fmo-canvas-drag-handle",
      text: "\u2807",
      attr: {
        type: "button",
        "aria-label": `Move ${tree.title}`
      }
    }) as HTMLButtonElement;
    setTooltip(dragHandle, "Drag tree card");

    const titleInput = header.createEl("input", {
      cls: "fmo-canvas-title",
      attr: {
        type: "text",
        "aria-label": "Tree title"
      }
    }) as HTMLInputElement;
    titleInput.value = tree.title;
    titleInput.addEventListener("change", () => {
      tree.title = titleInput.value.trim() || "Concern tree";
      titleInput.value = tree.title;
      setTooltip(dragHandle, `Drag ${tree.title}`);
      this.persistCanvasTrees();
    });

    const headerActions = header.createEl("div", { cls: "fmo-canvas-card-actions" });
    const collapseBtn = headerActions.createEl("button", {
      cls: "fmo-canvas-card-btn",
      text: tree.collapsed ? "\u25B8" : "\u25BE",
      attr: {
        type: "button",
        "aria-label": tree.collapsed ? "Expand tree card" : "Collapse tree card"
      }
    });
    collapseBtn.addEventListener("click", () => {
      tree.collapsed = !tree.collapsed;
      this.persistCanvasTrees();
      void this.render();
    });

    const removeBtn = headerActions.createEl("button", {
      cls: "fmo-canvas-card-btn",
      text: "\u00D7",
      attr: {
        type: "button",
        "aria-label": "Remove tree card"
      }
    });
    removeBtn.disabled = this.canvasTrees.length <= 1;
    removeBtn.addEventListener("click", () => {
      if (this.canvasTrees.length <= 1) return;
      this.canvasTrees = this.canvasTrees.filter((entry) => entry.id !== tree.id);
      this.persistCanvasTrees();
      void this.render();
    });

    this.attachCanvasCardDragging(dragHandle, card, tree);
    if (!tree.collapsed) {
      this.attachCanvasCardResizing(card, tree);
    }

    if (tree.collapsed) return;

    const panelContainer = card.createEl("div", { cls: "fmo-canvas-card-body" });

    new ConcernTreePanel({
      plugin: this.plugin,
      container: panelContainer,
      initialPreviewScrollTop: this.canvasTreePanelScrollById.get(tree.id) ?? 0,
      state: {
        rootPath: tree.rootPath,
        query: tree.query,
        sortMode: tree.sortMode,
        range: tree.range,
        trackedOnly: tree.trackedOnly,
        showParents: tree.showParents,
        collapsedNodePaths: tree.collapsedNodePaths,
      },
      onChange: (_visiblePaths, newState) => {
        tree.rootPath = newState.rootPath;
        tree.query = newState.query;
        tree.sortMode = newState.sortMode;
        tree.range = newState.range;
        tree.trackedOnly = newState.trackedOnly;
        tree.showParents = newState.showParents;
        tree.collapsedNodePaths = newState.collapsedNodePaths;
        this.persistCanvasTrees();
      },
    });
  }

  private captureCanvasTreePanelScrollState(): void {
    const next = new Map<string, number>(this.canvasTreePanelScrollById);
    let foundAny = false;
    const cards = this.contentEl.querySelectorAll(".fmo-canvas-card");
    cards.forEach((cardEl) => {
      const card = cardEl as HTMLElement;
      const id = card.dataset.treeId?.trim();
      if (!id) return;
      const preview = card.querySelector(".fmo-tree-panel-preview") as HTMLElement | null;
      if (!preview) return;
      foundAny = true;
      next.set(id, preview.scrollTop);
    });
    if (foundAny) {
      this.canvasTreePanelScrollById = next;
    }
  }

  private captureCanvasViewportScrollState(): void {
    const viewport = this.contentEl.querySelector<HTMLElement>(".fmo-canvas-viewport");
    if (!viewport) return;
    this.canvasViewportScroll = {
      left: viewport.scrollLeft,
      top: viewport.scrollTop
    };
  }

  private attachCanvasCardDragging(
    handleEl: HTMLButtonElement,
    cardEl: HTMLElement,
    tree: CanvasTreeDraft
  ): void {
    handleEl.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      evt.preventDefault();

      const startX = evt.clientX;
      const startY = evt.clientY;
      const startLeft = tree.x;
      const startTop = tree.y;

      const onMove = (moveEvt: PointerEvent): void => {
        const nextX = startLeft + (moveEvt.clientX - startX);
        const nextY = startTop + (moveEvt.clientY - startY);
        const maxX = Math.max(16, CANVAS_STAGE_WIDTH - tree.width - 16);
        const currentHeight = tree.collapsed
          ? Math.round(cardEl.getBoundingClientRect().height)
          : tree.height;
        const maxY = Math.max(16, CANVAS_STAGE_HEIGHT - currentHeight - 16);

        tree.x = this.clamp(nextX, 16, maxX);
        tree.y = this.clamp(nextY, 16, maxY);
        cardEl.style.left = `${tree.x}px`;
        cardEl.style.top = `${tree.y}px`;
      };

      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        this.persistCanvasTrees();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });
  }

  private attachCanvasCardResizing(cardEl: HTMLElement, tree: CanvasTreeDraft): void {
    const resizeHandle = cardEl.createEl("button", {
      cls: "fmo-canvas-resize-handle",
      text: "\u25E2",
      attr: {
        type: "button",
        "aria-label": `Resize ${tree.title}`
      }
    }) as HTMLButtonElement;
    setTooltip(resizeHandle, "Resize tree card");

    resizeHandle.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      evt.stopPropagation();

      const startX = evt.clientX;
      const startY = evt.clientY;
      const startWidth = tree.width;
      const startHeight = tree.height;

      const onMove = (moveEvt: PointerEvent): void => {
        const nextWidth = startWidth + (moveEvt.clientX - startX);
        const nextHeight = startHeight + (moveEvt.clientY - startY);
        const maxWidth = Math.max(
          CANVAS_CARD_MIN_WIDTH,
          CANVAS_STAGE_WIDTH - tree.x - 16
        );
        const maxHeight = Math.max(
          CANVAS_CARD_MIN_HEIGHT,
          CANVAS_STAGE_HEIGHT - tree.y - 16
        );

        tree.width = this.clamp(nextWidth, CANVAS_CARD_MIN_WIDTH, maxWidth);
        tree.height = this.clamp(nextHeight, CANVAS_CARD_MIN_HEIGHT, maxHeight);
        cardEl.style.width = `${tree.width}px`;
        cardEl.style.height = `${tree.height}px`;
      };

      const stop = (): void => {
        window.removeEventListener("pointermove", onMove);
        this.persistCanvasTrees();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
