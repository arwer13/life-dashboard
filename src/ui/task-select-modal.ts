import { SuggestModal, type App, type TFile } from "obsidian";

export class TaskSelectModal extends SuggestModal<TFile> {
  private readonly tasks: TFile[];
  private readonly onChoose: (file: TFile) => void;

  constructor(app: App, tasks: TFile[], onChoose: (file: TFile) => void) {
    super(app);
    this.tasks = tasks;
    this.onChoose = onChoose;
    this.setPlaceholder("Select task note...");
  }

  getSuggestions(query: string): TFile[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.tasks;

    return this.tasks.filter((file) => {
      return file.basename.toLowerCase().includes(q) || file.path.toLowerCase().includes(q);
    });
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createEl("div", { text: file.basename });
    el.createEl("small", { text: file.path, cls: "fmo-suggestion-path" });
  }

  onChooseSuggestion(file: TFile): void {
    this.onChoose(file);
  }
}
