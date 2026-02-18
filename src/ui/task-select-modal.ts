import { FuzzySuggestModal, type App, type FuzzyMatch, type TFile } from "obsidian";

type TaskSelectModalOptions = {
  placeholder?: string;
  showPathInSuggestion?: boolean;
};

export class TaskSelectModal extends FuzzySuggestModal<TFile> {
  private readonly tasks: TFile[];
  private readonly onChoose: (file: TFile) => void;
  private readonly onCloseWithoutChoice?: () => void;
  private readonly showPathInSuggestion: boolean;
  private wasChosen = false;

  constructor(
    app: App,
    tasks: TFile[],
    onChoose: (file: TFile) => void,
    onCloseWithoutChoice?: () => void,
    options: TaskSelectModalOptions = {}
  ) {
    super(app);
    this.tasks = tasks;
    this.onChoose = onChoose;
    this.onCloseWithoutChoice = onCloseWithoutChoice;
    this.showPathInSuggestion = options.showPathInSuggestion ?? true;
    this.setPlaceholder(options.placeholder ?? "Select task note...");
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
    if (this.showPathInSuggestion) {
      el.createEl("small", { text: file.path, cls: "fmo-suggestion-path" });
    }
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
