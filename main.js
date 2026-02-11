const { Plugin, PluginSettingTab, Setting, ItemView, SuggestModal, Notice, TFile } = require("obsidian");

const VIEW_TYPE_FRONTMATTER_OUTLINE = "frontmatter-outline-view";
const DISPLAY_VERSION = "0.1.14";

const DEFAULT_SETTINGS = {
  propertyName: "type",
  propertyValue: "concen",
  additionalFilterPropertyName: "",
  additionalFilterPropertyValue: "",
  caseSensitive: false,
  timeLogPath: "time-tracked.json",
  viewWasVisible: false,
  selectedTaskPath: "",
  activeTrackingStart: null,
  activeTrackingTaskPath: "",
  activeTrackingTaskId: ""
};

class TaskSelectModal extends SuggestModal {
  constructor(app, tasks, onChoose) {
    super(app);
    this.tasks = tasks;
    this.onChoose = onChoose;
    this.setPlaceholder("Select task note...");
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.tasks;

    return this.tasks.filter((file) => {
      return file.basename.toLowerCase().includes(q) || file.path.toLowerCase().includes(q);
    });
  }

  renderSuggestion(file, el) {
    el.createEl("div", { text: file.basename });
    el.createEl("small", { text: file.path, cls: "fmo-suggestion-path" });
  }

  onChooseSuggestion(file) {
    this.onChoose(file);
  }
}

class FrontmatterOutlineView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.liveTimerEl = null;
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
    await this.render();
  }

  async onClose() {
    this.liveTimerEl = null;
  }

  updateLiveTimer() {
    if (!this.liveTimerEl) return;
    this.liveTimerEl.setText(this.plugin.formatClockDuration(this.plugin.getCurrentElapsedSeconds()));
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const tasks = this.plugin.getTaskTreeItems();

    this.renderTrackerPanel(contentEl, tasks);
    this.renderOutline(contentEl, tasks);

    this.updateLiveTimer();
  }

  renderTrackerPanel(contentEl, tasks) {
    const panel = contentEl.createEl("div", { cls: "fmo-tracker" });

    const stateTitle = this.plugin.settings.activeTrackingStart ? "Tracking" : "Ready";
    panel.createEl("div", { cls: "fmo-tracker-title", text: stateTitle });

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
    toggleBtn.addEventListener("click", async () => {
      if (isTracking) {
        await this.plugin.stopTracking();
      } else {
        await this.plugin.startTracking();
      }
    });

    const actionRow = panel.createEl("div", { cls: "fmo-action-row" });

    const changeBtn = actionRow.createEl("button", {
      cls: "fmo-action-btn",
      text: "Change task..."
    });
    changeBtn.addEventListener("click", () => {
      const taskFiles = tasks.map((item) => item.file);
      const modal = new TaskSelectModal(this.app, taskFiles, async (file) => {
        await this.plugin.setSelectedTaskPath(file.path);
      });
      modal.open();
    });

    const clearBtn = actionRow.createEl("button", {
      cls: "fmo-action-btn",
      text: "Clear task"
    });
    clearBtn.disabled = Boolean(this.plugin.settings.activeTrackingStart);
    clearBtn.addEventListener("click", async () => {
      await this.plugin.setSelectedTaskPath("");
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
      label.addEventListener("click", async (evt) => {
        evt.preventDefault();
        await this.plugin.openFile(activeTaskFile.path);
      });
      selectedCard.createEl("div", { cls: "fmo-selected-sub", text: activeTaskFile.path });
    } else {
      selectedCard.createEl("div", {
        cls: "fmo-selected-sub",
        text: "No task selected"
      });
    }
  }

  renderOutline(contentEl, tasks) {
    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const prop = this.plugin.settings.propertyName.trim();
    const value = this.plugin.settings.propertyValue.trim();

    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Tasks Outline" });
    headerTop.createEl("span", { cls: "fmo-version", text: `v${DISPLAY_VERSION}` });

    header.createEl("div", {
      cls: "fmo-subheader",
      text: value.length > 0
        ? `Filter: ${prop} = ${value}`
        : `Filter: has property \"${prop}\"`
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

  buildTaskTree(tasks) {
    const nodesByPath = new Map();
    const notesByRef = new Map();

    const addRef = (ref, item) => {
      const key = ref.toLowerCase();
      if (!notesByRef.has(key)) notesByRef.set(key, []);
      notesByRef.get(key).push(item);
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

    const cumulativeSeconds = new Map();
    const computeCumulative = (node, ancestry) => {
      if (cumulativeSeconds.has(node.path)) return cumulativeSeconds.get(node.path);
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

  renderTreeNode(containerEl, node, cumulativeSeconds, ancestry) {
    if (ancestry.has(node.path)) return;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.path);

    const li = containerEl.createEl("li", { cls: "fmo-tree-item" });
    const row = li.createEl("div", { cls: "fmo-tree-row" });

    const total = cumulativeSeconds.get(node.path) || 0;
    const own = this.plugin.getTrackedSeconds(node.path);

    let childrenList = null;
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

    link.addEventListener("click", async (evt) => {
      evt.preventDefault();
      await this.plugin.openFile(node.item.file.path);
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
      .setName("Task property name")
      .setDesc("Frontmatter key used to identify task notes.")
      .addText((text) =>
        text
          .setPlaceholder("type")
          .setValue(this.plugin.settings.propertyName)
          .onChange(async (value) => {
            this.plugin.settings.propertyName = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Task property value")
      .setDesc("Required value for task notes. Leave empty to include any note with the property.")
      .addText((text) =>
        text
          .setPlaceholder("concen")
          .setValue(this.plugin.settings.propertyValue)
          .onChange(async (value) => {
            this.plugin.settings.propertyValue = value;
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Additional filter property")
      .setDesc("Optional second frontmatter key to filter task notes.")
      .addText((text) =>
        text
          .setPlaceholder("status")
          .setValue(this.plugin.settings.additionalFilterPropertyName)
          .onChange(async (value) => {
            this.plugin.settings.additionalFilterPropertyName = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Additional filter value")
      .setDesc("Optional second filter value. Leave empty to require only additional property presence.")
      .addText((text) =>
        text
          .setPlaceholder("active")
          .setValue(this.plugin.settings.additionalFilterPropertyValue)
          .onChange(async (value) => {
            this.plugin.settings.additionalFilterPropertyValue = value;
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Case sensitive")
      .setDesc("If enabled, value matching is case sensitive for all filters.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.caseSensitive)
          .onChange(async (value) => {
            this.plugin.settings.caseSensitive = value;
            await this.plugin.saveSettings();
            await this.plugin.postFilterSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Time log file path")
      .setDesc("JSON file path in vault where time entries are stored.")
      .addText((text) =>
        text
          .setPlaceholder("time-tracked.json")
          .setValue(this.plugin.settings.timeLogPath)
          .onChange(async (value) => {
            this.plugin.settings.timeLogPath = value.trim() || "time-tracked.json";
            await this.plugin.saveSettings();
            await this.plugin.reloadTimeTotals();
            this.plugin.refreshView();
          })
      );
  }
}

module.exports = class FrontmatterOutlinePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.lastPersistedVisibility = Boolean(this.settings.viewWasVisible);
    this.timeTotalsById = new Map();
    await this.reloadTimeTotals();

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

    this.addCommand({
      id: "start-time-tracking",
      name: "Start task timer",
      callback: () => this.startTracking()
    });

    this.addCommand({
      id: "stop-time-tracking",
      name: "Stop task timer",
      callback: () => this.stopTracking()
    });

    this.addSettingTab(new FrontmatterOutlineSettingTab(this.app, this));

    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshView()));
    this.registerEvent(this.app.vault.on("rename", async () => {
      await this.reloadTimeTotals();
      this.refreshView();
    }));
    this.registerEvent(this.app.vault.on("delete", async () => {
      await this.reloadTimeTotals();
      this.refreshView();
    }));
    this.registerEvent(this.app.vault.on("create", () => this.refreshView()));

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.persistVisibilityState();
    }));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.maybeAutoSelectFromActive();
    }));

    this.app.workspace.onLayoutReady(() => {
      this.maybeAutoSelectFromActive();
      if (this.settings.viewWasVisible) {
        this.activateView();
      } else {
        this.refreshView();
      }
    });

    this.registerInterval(window.setInterval(() => {
      this.pushLiveTimerUpdate();
    }, 1000));
  }

  async onunload() {
    await this.persistVisibilityState(true);
  }

  getTaskTreeItems() {
    const files = this.app.vault.getMarkdownFiles();
    const tasks = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!this.frontmatterMatchesTaskFilters(fm)) continue;

      tasks.push({
        file,
        parentRaw: fm?.parent
      });
    }

    tasks.sort((a, b) => a.file.path.localeCompare(b.file.path));
    return tasks;
  }

  frontmatterMatchesTaskFilters(frontmatter) {
    const prop = this.settings.propertyName.trim();
    if (!prop) return false;
    if (!frontmatter || !(prop in frontmatter)) return false;

    const primaryActual = String(frontmatter[prop] ?? "");
    if (!this.matchesValue(primaryActual, this.settings.propertyValue.trim())) {
      return false;
    }

    const extraProp = this.settings.additionalFilterPropertyName.trim();
    if (!extraProp) return true;
    if (!(extraProp in frontmatter)) return false;

    const extraActual = String(frontmatter[extraProp] ?? "");
    return this.matchesValue(extraActual, this.settings.additionalFilterPropertyValue.trim());
  }

  fileMatchesTaskFilter(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    return this.frontmatterMatchesTaskFilters(cache?.frontmatter);
  }

  async postFilterSettingsChanged() {
    await this.maybeAutoSelectFromActive();
    this.refreshView();
  }

  async maybeAutoSelectFromActive() {
    if (this.settings.activeTrackingStart) return;

    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) return;
    if (!this.fileMatchesTaskFilter(file)) return;
    if (this.settings.selectedTaskPath === file.path) return;

    this.settings.selectedTaskPath = file.path;
    await this.saveSettings();
    this.refreshView();
  }

  getActiveTaskPath() {
    if (this.settings.activeTrackingStart && this.settings.activeTrackingTaskPath) {
      return this.settings.activeTrackingTaskPath;
    }
    return this.settings.selectedTaskPath || "";
  }

  async setSelectedTaskPath(path) {
    this.settings.selectedTaskPath = path;
    await this.saveSettings();
    this.refreshView();
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

  getCurrentElapsedSeconds() {
    if (!this.settings.activeTrackingStart) return 0;
    const now = Date.now();
    const start = Number(this.settings.activeTrackingStart);
    if (!Number.isFinite(start) || start <= 0) return 0;
    return Math.max(0, Math.floor((now - start) / 1000));
  }

  async startTracking() {
    if (this.settings.activeTrackingStart) return;

    let taskPath = this.settings.selectedTaskPath;
    if (!taskPath) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof TFile && this.fileMatchesTaskFilter(activeFile)) {
        taskPath = activeFile.path;
      }
    }

    if (!taskPath) {
      new Notice("Select a task first (Change task...) or open a task note.");
      return;
    }

    const taskFile = this.app.vault.getAbstractFileByPath(taskPath);
    if (!(taskFile instanceof TFile)) {
      new Notice("Selected task note was not found.");
      return;
    }

    const taskId = await this.ensureTaskIdForFile(taskFile);
    if (!taskId) {
      new Notice("Could not prepare task id for tracking.");
      return;
    }

    this.settings.selectedTaskPath = taskPath;
    this.settings.activeTrackingTaskPath = taskPath;
    this.settings.activeTrackingTaskId = taskId;
    this.settings.activeTrackingStart = Date.now();
    await this.saveSettings();
    this.refreshView();
  }

  async stopTracking() {
    if (!this.settings.activeTrackingStart) return;

    const startMs = Number(this.settings.activeTrackingStart);
    const endMs = Date.now();
    const taskId = this.settings.activeTrackingTaskId;

    if (taskId && Number.isFinite(startMs) && startMs > 0 && endMs >= startMs) {
      await this.appendTimeEntry(taskId, startMs, endMs);
      await this.reloadTimeTotals();
    }

    this.settings.activeTrackingStart = null;
    this.settings.activeTrackingTaskPath = "";
    this.settings.activeTrackingTaskId = "";
    await this.saveSettings();
    this.refreshView();
  }

  getTimeLogPath() {
    const raw = (this.settings.timeLogPath || "time-tracked.json").trim();
    return raw.replace(/^\/+/, "") || "time-tracked.json";
  }

  async ensureDirectoryPath(relativePath) {
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length <= 1) return;

    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async readTimeLog() {
    const path = this.getTimeLogPath();

    await this.ensureDirectoryPath(path);

    const exists = await this.app.vault.adapter.exists(path);
    if (!exists) {
      const initial = { version: 1, entries: [] };
      await this.app.vault.adapter.write(path, JSON.stringify(initial, null, 2));
      return initial;
    }

    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) {
        return { version: 1, entries: [] };
      }
      return parsed;
    } catch {
      return { version: 1, entries: [] };
    }
  }

  async writeTimeLog(data) {
    const path = this.getTimeLogPath();
    await this.ensureDirectoryPath(path);
    await this.app.vault.adapter.write(path, JSON.stringify(data, null, 2));
  }

  formatTimestamp(date) {
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${yyyy}.${mm}.${dd}-${hh}:${min}`;
  }

  async appendTimeEntry(noteId, startMs, endMs) {
    const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
    const entry = {
      noteId,
      start: this.formatTimestamp(new Date(startMs)),
      durationMinutes
    };

    const data = await this.readTimeLog();
    data.version = 1;
    if (!Array.isArray(data.entries)) {
      data.entries = [];
    }
    data.entries.push(entry);
    await this.writeTimeLog(data);
  }

  async migrateTimeLogToV2() {
    const data = await this.readTimeLog();
    const sourceEntries = Array.isArray(data.entries) ? data.entries : [];

    const allV2 = sourceEntries.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const hasLegacyShape = typeof entry.notePath === "string" || entry.finish != null || entry.durationSeconds != null;
      if (hasLegacyShape) return false;
      return typeof entry.noteId === "string" && entry.noteId.trim() && Number.isFinite(Number(entry.durationMinutes));
    });

    if (allV2) {
      if (data.version !== 2) {
        data.version = 2;
        await this.writeTimeLog(data);
      }
      return;
    }

    const migratedEntries = [];
    const notePathToId = new Map();

    for (const entry of sourceEntries) {
      if (!entry || typeof entry !== "object") continue;

      if (typeof entry.noteId === "string" && entry.noteId.trim()) {
        const minutes = Number(entry.durationMinutes);
        if (!Number.isFinite(minutes) || minutes <= 0) continue;
        migratedEntries.push({
          noteId: entry.noteId.trim(),
          start: typeof entry.start === "string" ? entry.start : this.formatTimestamp(new Date()),
          durationMinutes: Math.max(1, Math.round(minutes))
        });
        continue;
      }

      if (typeof entry.notePath !== "string" || !entry.notePath.trim()) continue;

      let noteId = notePathToId.get(entry.notePath);
      if (!noteId) {
        const file = this.app.vault.getAbstractFileByPath(entry.notePath);
        if (!(file instanceof TFile)) continue;
        noteId = await this.ensureTaskIdForFile(file);
        if (!noteId) continue;
        notePathToId.set(entry.notePath, noteId);
      }

      const legacySeconds = Number(entry.durationSeconds);
      if (!Number.isFinite(legacySeconds) || legacySeconds <= 0) continue;

      migratedEntries.push({
        noteId,
        start: typeof entry.start === "string" ? entry.start : this.formatTimestamp(new Date()),
        durationMinutes: Math.max(1, Math.round(legacySeconds / 60))
      });
    }

    await this.writeTimeLog({
      version: 2,
      entries: migratedEntries
    });
  }

  async reloadTimeTotals() {
    await this.migrateTimeLogToV2();
    const data = await this.readTimeLog();
    const totals = new Map();

    for (const entry of data.entries || []) {
      if (!entry || typeof entry.noteId !== "string" || !entry.noteId.trim()) continue;
      const minutes = Number(entry.durationMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      const seconds = Math.floor(minutes * 60);
      const key = entry.noteId.trim();
      totals.set(key, (totals.get(key) || 0) + seconds);
    }

    this.timeTotalsById = totals;
  }

  getTrackedSeconds(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return 0;
    const noteId = this.getTaskIdForFile(file);
    if (!noteId) return 0;
    return this.timeTotalsById.get(noteId) || 0;
  }

  getTaskIdFromFrontmatter(frontmatter) {
    if (!frontmatter || frontmatter.id == null) return "";
    const id = String(frontmatter.id).trim();
    return id || "";
  }

  getTaskIdForFile(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    return this.getTaskIdFromFrontmatter(cache?.frontmatter);
  }

  generateUuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = Math.random() * 16 | 0;
      const v = ch === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async ensureTaskIdForFile(file) {
    const existing = this.getTaskIdForFile(file);
    if (existing) return existing;

    const generated = this.generateUuid();

    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const current = this.getTaskIdFromFrontmatter(fm);
        if (current) return;
        fm.id = generated;
      });
    } catch {
      return "";
    }

    const resolved = this.getTaskIdForFile(file);
    return resolved || generated;
  }

  formatClockDuration(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    const pad = (n) => String(n).padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${minutes}:${pad(seconds)}`;
  }

  formatShortDuration(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);

    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  async openFile(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getMostRecentLeaf() || this.app.workspace.getLeaf(true);
    if (!leaf) return;

    await leaf.openFile(file, { active: true });
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

  pushLiveTimerUpdate() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FRONTMATTER_OUTLINE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && typeof view.updateLiveTimer === "function") {
        view.updateLiveTimer();
      }
    }
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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
