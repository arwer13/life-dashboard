import { AbstractInputSuggest, TFile, type App } from "obsidian";

export class FileSuggest extends AbstractInputSuggest<TFile> {
  private readonly inputEl: HTMLInputElement;
  private readonly extension: string;

  constructor(app: App, inputEl: HTMLInputElement, extension = ".md") {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.extension = extension;
  }

  getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase();
    const files = this.app.vault.getFiles().filter((f) =>
      f.extension === this.extension.slice(1) && f.path.toLowerCase().includes(lower)
    );
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files.slice(0, 20);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createEl("div", { text: file.basename, cls: "suggestion-title" });
    if (file.parent?.path && file.parent.path !== "/") {
      el.createEl("small", { text: file.parent.path, cls: "suggestion-note" });
    }
  }

  selectSuggestion(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(file.path);
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}
