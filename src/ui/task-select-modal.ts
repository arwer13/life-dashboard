import { FuzzySuggestModal, type App, type FuzzyMatch, type TFile } from "obsidian";

export class TaskSelectModal extends FuzzySuggestModal<TFile> {
  private readonly tasks: TFile[];
  private readonly onChoose: (file: TFile) => void;
  private readonly onCloseWithoutChoice?: () => void;
  private wasChosen = false;

  constructor(
    app: App,
    tasks: TFile[],
    onChoose: (file: TFile) => void,
    onCloseWithoutChoice?: () => void
  ) {
    super(app);
    this.tasks = tasks;
    this.onChoose = onChoose;
    this.onCloseWithoutChoice = onCloseWithoutChoice;
    this.setPlaceholder("Select task note...");
  }

  getItems(): TFile[] {
    return this.tasks;
  }

  getItemText(file: TFile): string {
    return `${file.basename} ${file.path}`;
  }

  renderSuggestion(value: FuzzyMatch<TFile>, el: HTMLElement): void {
    const file = value.item;
    el.createEl("div", { text: file.basename });
    el.createEl("small", { text: file.path, cls: "fmo-suggestion-path" });
  }

  onChooseItem(file: TFile): void {
    this.wasChosen = true;
    this.onChoose(file);
  }

  onClose(): void {
    super.onClose();
    window.setTimeout(() => {
      if (!this.wasChosen) {
        this.onCloseWithoutChoice?.();
      }
    }, 0);
  }
}
