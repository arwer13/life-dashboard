import { SuggestModal, type App } from "obsidian";
import type { ListEntry } from "../models/types";

function parseTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export class ListEntrySearchModal extends SuggestModal<ListEntry> {
  private readonly entries: ListEntry[];
  private readonly onChoose: (entry: ListEntry) => void;

  constructor(
    app: App,
    entries: ListEntry[],
    onChoose: (entry: ListEntry) => void
  ) {
    super(app);
    this.entries = entries;
    this.onChoose = onChoose;
    this.setPlaceholder("Search list entries...");
  }

  getSuggestions(query: string): ListEntry[] {
    const terms = parseTerms(query);
    if (terms.length === 0) return this.entries;
    return this.entries.filter((e) => terms.every((t) => e.textLower.includes(t)));
  }

  renderSuggestion(entry: ListEntry, el: HTMLElement): void {
    const terms = parseTerms(this.inputEl.value);
    const div = el.createEl("div");
    if (terms.length === 0) {
      div.textContent = entry.text;
      return;
    }

    const lower = entry.textLower;
    // Collect all match ranges
    const ranges: { start: number; end: number }[] = [];
    for (const term of terms) {
      let pos = 0;
      while ((pos = lower.indexOf(term, pos)) !== -1) {
        ranges.push({ start: pos, end: pos + term.length });
        pos += term.length;
      }
    }
    // Merge overlapping ranges
    ranges.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ ...r });
      }
    }
    // Render with highlights
    let cursor = 0;
    for (const r of merged) {
      if (cursor < r.start) {
        div.appendText(entry.text.slice(cursor, r.start));
      }
      div.createEl("span", {
        text: entry.text.slice(r.start, r.end),
        cls: "suggestion-highlight"
      });
      cursor = r.end;
    }
    if (cursor < entry.text.length) {
      div.appendText(entry.text.slice(cursor));
    }
  }

  onChooseSuggestion(entry: ListEntry): void {
    this.onChoose(entry);
  }
}
