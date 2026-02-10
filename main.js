const { Plugin, PluginSettingTab, Setting, ItemView } = require("obsidian");

const VIEW_TYPE_FRONTMATTER_OUTLINE = "frontmatter-outline-view";
const DISPLAY_VERSION = "0.1.10";

const DEFAULT_SETTINGS = {
  propertyName: "status",
  propertyValue: "active",
  caseSensitive: false,
  viewWasVisible: false
};

class FrontmatterOutlineView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_FRONTMATTER_OUTLINE;
  }

  getDisplayText() {
    return "Life Dashboard";
  }

  getIcon() {
    return "list-tree";
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    // No-op
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const prop = this.plugin.settings.propertyName.trim();
    const rawValue = this.plugin.settings.propertyValue;
    const value = rawValue.trim();

    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Life Dashboard" });
    headerTop.createEl("span", {
      cls: "fmo-version",
      text: `v${DISPLAY_VERSION}`
    });
    header.createEl("div", {
      cls: "fmo-subheader",
      text: value.length > 0
        ? `Filter: ${prop} = ${value}`
        : `Filter: has property \"${prop}\"`
    });

    if (!prop) {
      contentEl.createEl("p", {
        cls: "fmo-empty",
        text: "Set a frontmatter property name in plugin settings."
      });
      return;
    }

    const files = this.plugin.app.vault.getMarkdownFiles();
    const matching = files
      .map((file) => {
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;

        if (!fm || !(prop in fm)) return null;

        const currentValue = String(fm[prop] ?? "");
        const passes = this.plugin.matchesValue(currentValue, value);
        if (!passes) return null;

        return {
          file,
          parentRaw: fm.parent
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.file.path.localeCompare(b.file.path));

    if (!matching.length) {
      contentEl.createEl("p", {
        cls: "fmo-empty",
        text: "No matching notes found for current filter."
      });
      return;
    }

    const nodesByPath = new Map();
    const notesByRef = new Map();
    const addRef = (ref, item) => {
      const key = ref.toLowerCase();
      if (!notesByRef.has(key)) notesByRef.set(key, []);
      notesByRef.get(key).push(item);
    };

    for (const item of matching) {
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

    const normalizeParentRef = (value) => {
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
      if (!ref) return "";
      if (ref.includes("|")) {
        ref = ref.split("|")[0].trim();
      }
      if (ref.includes("#")) {
        ref = ref.split("#")[0].trim();
      }
      return ref;
    };

    const resolveParentPath = (parentRaw) => {
      const normalized = normalizeParentRef(parentRaw);
      if (!normalized) return null;

      const direct = notesByRef.get(normalized.toLowerCase()) || [];
      if (direct.length === 1) return direct[0].file.path;

      const withoutExt = normalized.replace(/\.md$/i, "");
      const byPathNoExt = notesByRef.get(withoutExt.toLowerCase()) || [];
      if (byPathNoExt.length === 1) return byPathNoExt[0].file.path;

      const lastSegment = withoutExt.split("/").pop() || withoutExt;
      const byBasename = notesByRef.get(lastSegment.toLowerCase()) || [];
      if (byBasename.length === 1) return byBasename[0].file.path;

      return null;
    };

    for (const node of nodesByPath.values()) {
      const parentPath = resolveParentPath(node.item.parentRaw);
      if (!parentPath || parentPath === node.path || !nodesByPath.has(parentPath)) continue;
      node.parentPath = parentPath;
      nodesByPath.get(parentPath).children.push(node);
    }

    const sortNodes = (nodes) => {
      nodes.sort((a, b) => a.item.file.path.localeCompare(b.item.file.path));
      for (const node of nodes) {
        sortNodes(node.children);
      }
    };

    const roots = Array.from(nodesByPath.values()).filter((node) => !node.parentPath);
    sortNodes(roots);

    const rootList = contentEl.createEl("ul", { cls: "fmo-tree" });

    const renderNode = (containerEl, node, ancestry) => {
      if (ancestry.has(node.path)) return;

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(node.path);

      const li = containerEl.createEl("li", { cls: "fmo-tree-item" });
      const row = li.createEl("div", { cls: "fmo-tree-row" });

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

        const link = row.createEl("a", {
          cls: "fmo-note-link",
          text: node.item.file.basename,
          href: "#"
        });
        link.addEventListener("click", (evt) => {
          evt.preventDefault();
          this.plugin.openFile(node.item.file.path);
        });

        const childrenList = li.createEl("ul", {
          cls: "fmo-tree fmo-tree-children"
        });
        childrenList.hidden = true;

        toggle.addEventListener("click", () => {
          const expanded = toggle.getAttribute("aria-expanded") === "true";
          const next = !expanded;
          toggle.setAttribute("aria-expanded", String(next));
          toggle.setText(next ? "▾" : "▸");
          childrenList.hidden = !next;
        });

        for (const child of node.children) {
          renderNode(childrenList, child, nextAncestry);
        }
      } else {
        row.createEl("span", {
          cls: "fmo-toggle-spacer",
          text: ""
        });

        const link = row.createEl("a", {
          cls: "fmo-note-link",
          text: node.item.file.basename,
          href: "#"
        });
        link.addEventListener("click", (evt) => {
          evt.preventDefault();
          this.plugin.openFile(node.item.file.path);
        });
      }
    };

    for (const root of roots) {
      renderNode(rootList, root, new Set());
    }
  }
}

class FrontmatterOutlineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Life Dashboard Settings" });

    new Setting(containerEl)
      .setName("Property name")
      .setDesc("Frontmatter key used to filter notes.")
      .addText((text) =>
        text
          .setPlaceholder("status")
          .setValue(this.plugin.settings.propertyName)
          .onChange(async (value) => {
            this.plugin.settings.propertyName = value.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Property value")
      .setDesc("Optional value to match. Leave empty to include any note with the property.")
      .addText((text) =>
        text
          .setPlaceholder("active")
          .setValue(this.plugin.settings.propertyValue)
          .onChange(async (value) => {
            this.plugin.settings.propertyValue = value;
            await this.plugin.saveSettings();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Case sensitive")
      .setDesc("If enabled, value matching is case sensitive.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.caseSensitive)
          .onChange(async (value) => {
            this.plugin.settings.caseSensitive = value;
            await this.plugin.saveSettings();
            this.plugin.refreshView();
          })
      );
  }
}

module.exports = class FrontmatterOutlinePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.lastPersistedVisibility = Boolean(this.settings.viewWasVisible);

    this.registerView(
      VIEW_TYPE_FRONTMATTER_OUTLINE,
      (leaf) => new FrontmatterOutlineView(leaf, this)
    );

    this.addRibbonIcon("list-tree", "Open Life Dashboard", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-life-dashboard",
      name: "Open Life Dashboard",
      callback: () => this.activateView()
    });

    this.addSettingTab(new FrontmatterOutlineSettingTab(this.app, this));

    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshView()));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshView()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshView()));
    this.registerEvent(this.app.vault.on("create", () => this.refreshView()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.persistVisibilityState()));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.viewWasVisible) {
        this.activateView();
      } else {
        this.refreshView();
      }
    });
  }

  async onunload() {
    await this.persistVisibilityState(true);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_FRONTMATTER_OUTLINE)[0];

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_FRONTMATTER_OUTLINE, active: true });
    }

    workspace.revealLeaf(leaf);
    await this.persistVisibilityState(true);
    this.refreshView();
  }

  matchesValue(actual, expected) {
    if (!expected || expected.trim().length === 0) return true;

    if (this.settings.caseSensitive) {
      return actual === expected;
    }

    return actual.toLowerCase() === expected.toLowerCase();
  }

  async openFile(path, heading) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;

    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return;

    await leaf.openFile(file, {
      active: true,
      eState: heading ? { subpath: `# ${heading}` } : undefined
    });
  }

  refreshView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FRONTMATTER_OUTLINE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && typeof view.render === "function") {
        view.render();
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isDashboardVisible() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_FRONTMATTER_OUTLINE).length > 0;
  }

  async persistVisibilityState(force = false) {
    const visible = this.isDashboardVisible();
    if (!force && visible === this.lastPersistedVisibility) return;

    this.settings.viewWasVisible = visible;
    this.lastPersistedVisibility = visible;
    await this.saveSettings();
  }
};
