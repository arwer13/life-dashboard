import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";
import { DISPLAY_VERSION } from "../version";
import type { TaskTreeNode, TaskItem } from "../models/types";
import { TaskSelectModal } from "./task-select-modal";
import type LifeDashboardPlugin from "../plugin";

export const VIEW_TYPE_LIFE_DASHBOARD = "life-dashboard-view";

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

    this.renderTrackerPanel(contentEl, tasks);
    this.renderOutline(contentEl, tasks);

    this.updateLiveTimer();
  }

  private renderTrackerPanel(contentEl: HTMLElement, tasks: TaskItem[]): void {
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

    const actionRow = panel.createEl("div", { cls: "fmo-action-row" });

    const changeBtn = actionRow.createEl("button", {
      cls: "fmo-action-btn",
      text: "Change task..."
    });
    changeBtn.addEventListener("click", () => {
      const taskFiles = tasks.map((item) => item.file);
      const modal = new TaskSelectModal(this.app, taskFiles, (file) => {
        void this.plugin.setSelectedTaskPath(file.path);
      });
      modal.open();
    });

    const clearBtn = actionRow.createEl("button", {
      cls: "fmo-action-btn",
      text: "Clear task"
    });
    clearBtn.disabled = Boolean(this.plugin.settings.activeTrackingStart);
    clearBtn.addEventListener("click", () => {
      void this.plugin.setSelectedTaskPath("");
    });

    const activeTaskPath = this.plugin.getActiveTaskPath();
    const activeTaskFile = activeTaskPath
      ? this.plugin.app.vault.getAbstractFileByPath(activeTaskPath)
      : null;

    const selectedCard = panel.createEl("div", { cls: "fmo-selected-card" });
    if (activeTaskFile instanceof TFile) {
      const row = selectedCard.createEl("div", { cls: "fmo-selected-main" });
      row.createEl("span", { cls: "fmo-dot", text: "" });
      const label = row.createEl("a", { cls: "fmo-note-link", href: "#", text: activeTaskFile.basename });
      label.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.plugin.openFile(activeTaskFile.path);
      });
      selectedCard.createEl("div", { cls: "fmo-selected-sub", text: activeTaskFile.path });
    } else {
      selectedCard.createEl("div", {
        cls: "fmo-selected-sub",
        text: "No task selected"
      });
    }
  }

  private renderOutline(contentEl: HTMLElement, tasks: TaskItem[]): void {
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

    const tree = this.buildTaskTree(tasks);
    const rootList = contentEl.createEl("ul", { cls: "fmo-tree" });

    for (const root of tree.roots) {
      this.renderTreeNode(rootList, root, tree.cumulativeSeconds, new Set());
    }
  }

  private buildTaskTree(tasks: TaskItem[]): { roots: TaskTreeNode[]; cumulativeSeconds: Map<string, number> } {
    const nodesByPath = new Map<string, TaskTreeNode>();
    const notesByRef = new Map<string, TaskItem[]>();

    const addRef = (ref: string, item: TaskItem): void => {
      const key = ref.toLowerCase();
      if (!notesByRef.has(key)) notesByRef.set(key, []);
      notesByRef.get(key)?.push(item);
    };

    for (const item of tasks) {
      nodesByPath.set(item.file.path, {
        item,
        path: item.file.path,
        children: [],
        parentPath: null
      });
      addRef(item.file.path, item);
      addRef(item.file.path.replace(/\.md$/i, ""), item);
      addRef(item.file.basename, item);
    }

    const normalizeParentRef = (value: unknown): string => {
      if (Array.isArray(value)) {
        for (const part of value) {
          const normalized = normalizeParentRef(part);
          if (normalized) return normalized;
        }
        return "";
      }

      if (value == null) return "";
      let ref = String(value).trim();
      if (!ref) return "";

      if (ref.startsWith("[[") && ref.endsWith("]]")) {
        ref = ref.slice(2, -2).trim();
      }
      if (ref.includes("|")) {
        ref = ref.split("|")[0]?.trim() ?? "";
      }
      if (ref.includes("#")) {
        ref = ref.split("#")[0]?.trim() ?? "";
      }

      return ref;
    };

    const resolveParentPath = (parentRaw: unknown): string | null => {
      const normalized = normalizeParentRef(parentRaw);
      if (!normalized) return null;

      const direct = notesByRef.get(normalized.toLowerCase()) ?? [];
      if (direct.length === 1) return direct[0]?.file.path ?? null;

      const withoutExt = normalized.replace(/\.md$/i, "");
      const byPathNoExt = notesByRef.get(withoutExt.toLowerCase()) ?? [];
      if (byPathNoExt.length === 1) return byPathNoExt[0]?.file.path ?? null;

      const lastSegment = withoutExt.split("/").pop() ?? withoutExt;
      const byBasename = notesByRef.get(lastSegment.toLowerCase()) ?? [];
      if (byBasename.length === 1) return byBasename[0]?.file.path ?? null;

      return null;
    };

    for (const node of nodesByPath.values()) {
      const parentPath = resolveParentPath(node.item.parentRaw);
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

    return { roots, cumulativeSeconds };
  }

  private renderTreeNode(
    containerEl: HTMLElement,
    node: TaskTreeNode,
    cumulativeSeconds: Map<string, number>,
    ancestry: Set<string>
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
      const toggle = row.createEl("button", {
        cls: "fmo-toggle",
        attr: {
          type: "button",
          "aria-expanded": "false",
          "aria-label": `Expand ${node.item.file.basename}`
        }
      });
      toggle.setText("▸");

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
      childrenList.hidden = true;
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

    if (total > 0) {
      row.createEl("span", {
        cls: "fmo-time-badge",
        text: this.plugin.formatShortDuration(total),
        attr: {
          title: `Own: ${this.plugin.formatShortDuration(own)} | Total (with children): ${this.plugin.formatShortDuration(total)}`
        }
      });
    }

    if (childrenList) {
      for (const child of node.children) {
        this.renderTreeNode(childrenList, child, cumulativeSeconds, nextAncestry);
      }
    }
  }
}
