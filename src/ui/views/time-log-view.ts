import { Notice, TFile } from "obsidian";
import { isFileItem } from "../../models/types";
import { VIEW_TYPE_LIFE_DASHBOARD_TIMELOG } from "../../models/view-types";
import { formatTimestampLocal, localTimestampToUTC, parseIntervalToken } from "../../services/time-log-store";
import { LifeDashboardBaseView } from "./base-view";
import { TaskSelectModal } from "../task-select-modal";

export class LifeDashboardTimeLogView extends LifeDashboardBaseView {
  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_TIMELOG;
  }

  getDisplayText(): string {
    return "Time log";
  }

  getIcon(): string {
    return "list";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("frontmatter-outline-view");

    const header = contentEl.createEl("div", { cls: "fmo-header" });
    const headerTop = header.createEl("div", { cls: "fmo-header-top" });
    headerTop.createEl("h3", { text: "Time log" });

    const nameMap = this.plugin.buildNoteIdToBasenameMap();

    let data: Record<string, string[]>;
    try {
      data = await this.plugin.readTimeLog();
    } catch {
      contentEl.createEl("p", { cls: "fmo-empty", text: "Failed to load time log." });
      return;
    }

    type FlatEntry = { noteId: string; token: string; start: string; startMs: number; durationMinutes: number };
    const entries: FlatEntry[] = [];

    for (const [noteId, tokens] of Object.entries(data)) {
      for (const token of tokens) {
        const parsed = parseIntervalToken(token);
        if (!parsed) continue;
        entries.push({ noteId, token, start: parsed.start, startMs: parsed.startMs, durationMinutes: parsed.durationMinutes });
      }
    }

    // Sort newest first
    entries.sort((a, b) => b.startMs - a.startMs);

    if (entries.length === 0) {
      contentEl.createEl("p", { cls: "fmo-empty", text: "No time entries." });
      return;
    }

    const highlightStartMs = this.plugin.highlightedTimeLogStartMs;
    this.plugin.highlightedTimeLogStartMs = null;

    const list = contentEl.createEl("div", { cls: "fmo-timelog-list" });
    let highlightedRow: HTMLElement | null = null;

    for (const entry of entries) {
      const isHighlighted = highlightStartMs !== null && entry.startMs === highlightStartMs;
      const row = list.createEl("div", {
        cls: isHighlighted ? "fmo-timelog-row fmo-timelog-row-highlight" : "fmo-timelog-row"
      });
      if (isHighlighted) highlightedRow = row;

      // Concern name (clickable to reassign)
      const normalizedNoteId = entry.noteId.trim();
      const name = nameMap.get(normalizedNoteId) ?? "unknown";
      const nameEl = row.createEl("span", { cls: "fmo-timelog-name fmo-timelog-name-clickable", text: name });
      nameEl.addEventListener("click", () => {
        const tasks = this.plugin.getTaskTreeItems().filter(isFileItem).map((item) => item.file);
        const modal = new TaskSelectModal(this.app, tasks, (file) => {
          void this.reassignEntry(data, entry.noteId, entry.token, file);
        });
        modal.open();
      });

      // Start time (editable) — displayed in local timezone, stored as UTC
      const startDisplay = formatTimestampLocal(entry.startMs);
      const startEl = row.createEl("span", { cls: "fmo-timelog-start", text: startDisplay });
      startEl.setAttribute("tabindex", "0");
      startEl.addEventListener("click", () => {
        this.makeEditable(startEl, startDisplay, (newVal) => {
          const utcStart = localTimestampToUTC(newVal);
          if (!utcStart) {
            new Notice("Invalid time format. Use YYYY.MM.DD-HH:MM for start time."); // eslint-disable-line obsidianmd/ui/sentence-case
            void this.render();
            return;
          }
          this.updateEntry(data, entry.noteId, entry.token, utcStart, entry.durationMinutes);
        });
      });

      // Duration (editable)
      const durText = `${entry.durationMinutes}m`;
      const durEl = row.createEl("span", { cls: "fmo-timelog-duration", text: durText });
      durEl.setAttribute("tabindex", "0");
      durEl.addEventListener("click", () => {
        this.makeEditable(durEl, String(entry.durationMinutes), (newVal) => {
          const newDur = parseInt(newVal, 10);
          if (!Number.isFinite(newDur) || newDur <= 0) {
            new Notice("Duration must be a positive number of minutes.");
            void this.render();
            return;
          }
          this.updateEntry(data, entry.noteId, entry.token, entry.start, newDur);
        });
      });

      // Delete button
      const delBtn = row.createEl("button", { cls: "fmo-timelog-delete", text: "\u00d7" });
      delBtn.setAttribute("aria-label", "Delete entry");
      delBtn.addEventListener("click", () => {
        this.deleteEntry(data, entry.noteId, entry.token);
      });

      // UUID (small, last)
      row.createEl("span", { cls: "fmo-timelog-id", text: normalizedNoteId || entry.noteId });
    }

    if (highlightedRow) {
      highlightedRow.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  private makeEditable(el: HTMLElement, currentValue: string, onSave: (newVal: string) => void): void {
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentValue;
    input.className = "fmo-timelog-input";
    el.empty();
    el.appendChild(input);
    input.focus();
    input.select();

    const commit = (): void => {
      const val = input.value.trim();
      if (val && val !== currentValue) {
        onSave(val);
      } else {
        void this.render();
      }
    };

    let committed = false;
    const safeCommit = (): void => {
      if (committed) return;
      committed = true;
      commit();
    };

    input.addEventListener("blur", safeCommit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); safeCommit(); }
      if (e.key === "Escape") { e.preventDefault(); void this.render(); }
    });
  }

  private updateEntry(
    data: Record<string, string[]>,
    noteId: string,
    oldToken: string,
    newStart: string,
    newDuration: number
  ): void {
    const newToken = `${newStart}T${newDuration}M`;
    if (!parseIntervalToken(newToken)) {
      new Notice("Invalid time format. Use YYYY.MM.DD-HH:MM for start time."); // eslint-disable-line obsidianmd/ui/sentence-case
      void this.render();
      return;
    }

    const tokens = data[noteId] ?? [];
    const idx = tokens.indexOf(oldToken);
    if (idx >= 0) {
      tokens[idx] = newToken;
    }
    data[noteId] = tokens;
    void this.plugin.saveTimeLog(data).then(() => void this.render());
  }

  private async reassignEntry(
    data: Record<string, string[]>,
    oldNoteId: string,
    token: string,
    newFile: TFile
  ): Promise<void> {
    const newNoteId = await this.plugin.ensureTaskId(newFile);
    if (!newNoteId) {
      new Notice("Could not resolve task ID for the selected note.");
      return;
    }
    if (newNoteId === oldNoteId) return;

    const oldTokens = data[oldNoteId] ?? [];
    data[oldNoteId] = oldTokens.filter((t) => t !== token);
    if (data[oldNoteId].length === 0) delete data[oldNoteId];

    const newTokens = data[newNoteId] ?? [];
    newTokens.push(token);
    data[newNoteId] = newTokens;

    await this.plugin.saveTimeLog(data);
    await this.render();
  }

  private deleteEntry(
    data: Record<string, string[]>,
    noteId: string,
    token: string
  ): void {
    const tokens = data[noteId] ?? [];
    data[noteId] = tokens.filter((t) => t !== token);
    if (data[noteId].length === 0) delete data[noteId];
    void this.plugin.saveTimeLog(data).then(() => void this.render());
  }
}
