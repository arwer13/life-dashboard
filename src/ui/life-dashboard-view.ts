import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";
import { DISPLAY_VERSION } from "../version";
import type { TaskTreeNode, TaskItem } from "../models/types";
import { TaskSelectModal } from "./task-select-modal";
import type LifeDashboardPlugin from "../plugin";

export const VIEW_TYPE_LIFE_DASHBOARD = "life-dashboard-view";
type TaskTreeData = {
  roots: TaskTreeNode[];
  cumulativeSeconds: Map<string, number>;
  nodesByPath: Map<string, TaskTreeNode>;
};

export class LifeDashboardView extends ItemView {
  private readonly plugin: LifeDashboardPlugin;
  private liveTimerEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD;
  }

  getDisplayText(): string {
    return "Life Dashboard";
  }

  getIcon(): string {
    return "list-tree";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.liveTimerEl = null;
  }

  updateLiveTimer(): void {
    if (!this.liveTimerEl) return;
    this.liveTimerEl.setText(this.plugin.formatClockDuration(this.plugin.getCurrentElapsedSeconds()));
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const tasks = this.plugin.getTaskTreeItems();
    const tree = this.buildTaskTree(tasks);

    this.renderTrackerPanel(contentEl, tasks, tree);
    this.renderOutline(contentEl, tasks, tree);

    this.updateLiveTimer();
  }

  private renderTrackerPanel(contentEl: HTMLElement, tasks: TaskItem[], tree: TaskTreeData): void {
    const panel = contentEl.createEl("div", { cls: "fmo-tracker" });

    const timerRing = panel.createEl("div", { cls: "fmo-ring" });
    this.liveTimerEl = timerRing.createEl("div", {
      cls: "fmo-timer-value",
      text: this.plugin.formatClockDuration(this.plugin.getCurrentElapsedSeconds())
    });

    const isTracking = Boolean(this.plugin.settings.activeTrackingStart);
    const toggleBtn = timerRing.createEl("button", {
      cls: "fmo-main-toggle",
      text: isTracking ? "Stop" : "Start"
    });
    toggleBtn.addEventListener("click", () => {
      void (isTracking ? this.plugin.stopTracking() : this.plugin.startTracking());
    });

    this.renderTrackedContext(panel, tasks, tree);
  }

  private renderTrackedContext(panel: HTMLElement, tasks: TaskItem[], tree: TaskTreeData): void {
    const block = panel.createEl("div", { cls: "fmo-context-block" });

    const activeTaskPath = this.plugin.getActiveTaskPath();
    if (!activeTaskPath) {
      block.createEl("div", { cls: "fmo-selected-sub", text: "No task selected" });
      this.renderChangeTaskButton(block, tasks);
      return;
    }

    const activeTaskFile = this.plugin.app.vault.getAbstractFileByPath(activeTaskPath);
    if (!(activeTaskFile instanceof TFile)) {
      block.createEl("div", { cls: "fmo-selected-sub", text: "Selected task note was not found" });
      this.renderChangeTaskButton(block, tasks);
      return;
    }

    const activeNode = tree.nodesByPath.get(activeTaskPath);
    if (!activeNode) {
      const fallback = block.createEl("div", { cls: "fmo-selected-card" });
      const row = fallback.createEl("div", { cls: "fmo-selected-main" });
      row.createEl("span", { cls: "fmo-dot", text: "" });
      const label = row.createEl("a", { cls: "fmo-note-link", href: "#", text: activeTaskFile.basename });
      label.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.plugin.openFile(activeTaskFile.path);
      });
      fallback.createEl("div", { cls: "fmo-selected-sub", text: activeTaskFile.path });
      fallback.createEl("div", {
        cls: "fmo-selected-sub",
        text: "Task is outside current filter."
      });
      this.renderChangeTaskButton(fallback, tasks);
      return;
    }

    const chain = this.buildTrackedContextChain(activeNode, tree.nodesByPath);
    const card = block.createEl("div", { cls: "fmo-context-card" });
    const chainEl = card.createEl("div", { cls: "fmo-context-chain" });

    for (let i = 0; i < chain.length; i += 1) {
      const node = chain[i];
      if (!node) continue;

      const isTracked = i === 0;
      const item = chainEl.createEl("div", {
        cls: isTracked ? "fmo-context-item fmo-context-item-tracked" : "fmo-context-item fmo-context-item-parent"
      });

      const row = item.createEl("div", { cls: "fmo-context-row" });
      row.createEl("span", {
        cls: "fmo-context-prefix",
        text: this.getContextPrefix(i)
      });
      const link = row.createEl("a", {
        cls: isTracked ? "fmo-note-link fmo-context-link-tracked" : "fmo-note-link",
        text: node.item.file.basename,
        href: "#"
      });
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.plugin.openFile(node.item.file.path);
      });

      if (isTracked) {
        this.renderChangeTaskButton(row, tasks);
      }

      const total = tree.cumulativeSeconds.get(node.path) ?? 0;
      const own = this.plugin.getTrackedSeconds(node.path);
      row.createEl("span", {
        cls: "fmo-time-badge fmo-context-time-badge",
        text: this.plugin.formatShortDuration(total),
        attr: {
          title: `Own: ${this.plugin.formatShortDuration(own)} | Total (with children): ${this.plugin.formatShortDuration(total)}`
        }
      });
    }
  }

  private getContextPrefix(depth: number): string {
    if (depth <= 0) return "● ";
    return `${"  ".repeat(Math.max(0, depth - 1))}└─ `;
  }

  private renderChangeTaskButton(containerEl: HTMLElement, tasks: TaskItem[]): void {
    const button = containerEl.createEl("button", {
      cls: "fmo-context-change-btn",
      text: "🔁",
      attr: {
        type: "button",
        "aria-label": "Change task",
        title: "Change task"
      }
    });
    button.addEventListener("click", () => {
      const taskFiles = tasks.map((item) => item.file);
      const modal = new TaskSelectModal(this.app, taskFiles, (file) => {
        void this.plugin.setSelectedTaskPath(file.path);
      });
      modal.open();
    });
  }

  private buildTrackedContextChain(
    node: TaskTreeNode,
    nodesByPath: Map<string, TaskTreeNode>
  ): TaskTreeNode[] {
    const chain: TaskTreeNode[] = [];
    let current: TaskTreeNode | undefined = node;

    while (current) {
      chain.push(current);
      current = current.parentPath ? nodesByPath.get(current.parentPath) : undefined;
    }

    return chain;
  }

  private renderOutline(contentEl: HTMLElement, tasks: TaskItem[], tree: TaskTreeData): void {
    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const prop = this.plugin.settings.propertyName.trim();
    const value = this.plugin.settings.propertyValue.trim();

    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Tasks Outline" });
    headerTop.createEl("span", { cls: "fmo-version", text: `v${DISPLAY_VERSION}` });

    header.createEl("div", {
      cls: "fmo-subheader",
      text: value.length > 0 ? `Filter: ${prop} = ${value}` : `Filter: has property \"${prop}\"`
    });

    if (!prop) {
      contentEl.createEl("p", {
        cls: "fmo-empty",
        text: "Set a task frontmatter property in plugin settings."
      });
      return;
    }

    if (!tasks.length) {
      contentEl.createEl("p", {
        cls: "fmo-empty",
        text: "No matching task notes found for current filter."
      });
      return;
    }

    const rootList = contentEl.createEl("ul", { cls: "fmo-tree" });

    for (const root of tree.roots) {
      this.renderTreeNode(rootList, root, tree.cumulativeSeconds, new Set(), {});
    }
  }

  private buildTaskTree(tasks: TaskItem[]): TaskTreeData {
    const nodesByPath = new Map<string, TaskTreeNode>();

    for (const item of tasks) {
      nodesByPath.set(item.file.path, {
        item,
        path: item.file.path,
        children: [],
        parentPath: null
      });
    }

    for (const node of nodesByPath.values()) {
      const parentPath = this.resolveParentPath(node.item.parentRaw, node.item.file.path);
      if (!parentPath || parentPath === node.path || !nodesByPath.has(parentPath)) continue;
      node.parentPath = parentPath;
      nodesByPath.get(parentPath)?.children.push(node);
    }

    const sortNodes = (nodes: TaskTreeNode[]): void => {
      nodes.sort((a, b) => a.item.file.path.localeCompare(b.item.file.path));
      for (const node of nodes) {
        sortNodes(node.children);
      }
    };

    const roots = Array.from(nodesByPath.values()).filter((node) => !node.parentPath);
    sortNodes(roots);

    const cumulativeSeconds = new Map<string, number>();
    const computeCumulative = (node: TaskTreeNode, ancestry: Set<string>): number => {
      if (cumulativeSeconds.has(node.path)) return cumulativeSeconds.get(node.path) ?? 0;
      if (ancestry.has(node.path)) return this.plugin.getTrackedSeconds(node.path);

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(node.path);

      let total = this.plugin.getTrackedSeconds(node.path);
      for (const child of node.children) {
        total += computeCumulative(child, nextAncestry);
      }

      cumulativeSeconds.set(node.path, total);
      return total;
    };

    for (const root of roots) {
      computeCumulative(root, new Set());
    }

    return { roots, cumulativeSeconds, nodesByPath };
  }

  private resolveParentPath(parentRaw: unknown, sourcePath: string): string | null {
    for (const candidate of this.extractParentCandidates(parentRaw)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
      if (file) return file.path;
    }
    return null;
  }

  private extractParentCandidates(value: unknown): string[] {
    const candidates: string[] = [];

    const addCandidate = (raw: string): void => {
      let ref = raw.trim();
      if (!ref) return;

      if (ref.startsWith("[[") && ref.endsWith("]]")) {
        ref = ref.slice(2, -2).trim();
      }
      if (ref.includes("|")) {
        ref = ref.split("|")[0]?.trim() ?? "";
      }
      if (ref.includes("#")) {
        ref = ref.split("#")[0]?.trim() ?? "";
      }

      ref = ref.replace(/^\/+/, "").trim();
      if (!ref) return;
      candidates.push(ref);
    };

    const visit = (next: unknown): void => {
      if (Array.isArray(next)) {
        for (const entry of next) {
          visit(entry);
        }
        return;
      }
      if (next == null) return;
      addCandidate(String(next));
    };

    visit(value);
    return Array.from(new Set(candidates));
  }

  private renderTreeNode(
    containerEl: HTMLElement,
    node: TaskTreeNode,
    cumulativeSeconds: Map<string, number>,
    ancestry: Set<string>,
    options: { expandedPaths?: Set<string>; focusPath?: string }
  ): void {
    if (ancestry.has(node.path)) return;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.path);

    const li = containerEl.createEl("li", { cls: "fmo-tree-item" });
    const row = li.createEl("div", { cls: "fmo-tree-row" });

    const total = cumulativeSeconds.get(node.path) ?? 0;
    const own = this.plugin.getTrackedSeconds(node.path);

    let childrenList: HTMLElement | null = null;
    if (node.children.length > 0) {
      const isExpanded = options.expandedPaths?.has(node.path) ?? false;
      const toggle = row.createEl("button", {
        cls: "fmo-toggle",
        attr: {
          type: "button",
          "aria-expanded": String(isExpanded),
          "aria-label": `Expand ${node.item.file.basename}`
        }
      });
      toggle.setText(isExpanded ? "▾" : "▸");

      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        const next = !expanded;
        toggle.setAttribute("aria-expanded", String(next));
        toggle.setText(next ? "▾" : "▸");
        if (childrenList) {
          childrenList.hidden = !next;
        }
      });

      childrenList = li.createEl("ul", { cls: "fmo-tree fmo-tree-children" });
      childrenList.hidden = !isExpanded;
    } else {
      row.createEl("span", { cls: "fmo-toggle-spacer", text: "" });
    }

    const link = row.createEl("a", {
      cls: "fmo-note-link",
      text: node.item.file.basename,
      href: "#"
    });

    link.addEventListener("click", (evt) => {
      evt.preventDefault();
      void this.plugin.openFile(node.item.file.path);
    });

    if (options.focusPath && options.focusPath === node.path) {
      link.addClass("fmo-note-link-active");
    }

    row.createEl("span", {
      cls: "fmo-time-badge",
      text: this.plugin.formatShortDuration(total),
      attr: {
        title: `Own: ${this.plugin.formatShortDuration(own)} | Total (with children): ${this.plugin.formatShortDuration(total)}`
      }
    });

    if (childrenList) {
      for (const child of node.children) {
        this.renderTreeNode(childrenList, child, cumulativeSeconds, nextAncestry, options);
      }
    }
  }
}
