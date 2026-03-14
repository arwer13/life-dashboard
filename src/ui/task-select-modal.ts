import { FuzzySuggestModal, type App, type FuzzyMatch, type Hotkey, type Instruction, type TFile } from "obsidian";
import { transliterateLayout } from "../services/keyboard-layout";

export type TaskSelectModalSuggestionBadge = {
  label: string;
  tone?: "done" | "archived";
};

export type TaskSelectModalSuggestionDecoration = {
  dimmed?: boolean;
  badges?: TaskSelectModalSuggestionBadge[];
};

export type TaskSelectModalSearchMode = {
  tasks: TFile[];
  instructions?: Instruction[];
  emptyStateText?: string;
  suggestionDecorations?: Record<string, TaskSelectModalSuggestionDecoration>;
};

type TaskSelectModalOptions = {
  placeholder?: string;
  showPathInSuggestion?: boolean;
  searchModes?: TaskSelectModalSearchMode[];
  cycleHotkeys?: Hotkey[];
  onModalClose?: () => void;
};

export class TaskSelectModal extends FuzzySuggestModal<TFile> {
  private readonly onChoose: (file: TFile) => void;
  private readonly onCloseWithoutChoice?: () => void;
  private readonly showPathInSuggestion: boolean;
  private readonly searchModes: TaskSelectModalSearchMode[];
  private readonly cycleHotkeys: Hotkey[];
  private readonly onModalClose?: () => void;
  private readonly defaultEmptyStateText: string;
  private wasChosen = false;
  private isModalOpen = false;
  private searchModeIndex = 0;

  constructor(
    app: App,
    tasks: TFile[],
    onChoose: (file: TFile) => void,
    onCloseWithoutChoice?: () => void,
    options: TaskSelectModalOptions = {}
  ) {
    super(app);
    this.defaultEmptyStateText = this.emptyStateText;
    this.searchModes = (options.searchModes?.length ? options.searchModes : [{ tasks }]).map((mode) => ({
      tasks: [...mode.tasks],
      instructions: mode.instructions,
      emptyStateText: mode.emptyStateText,
      suggestionDecorations: mode.suggestionDecorations
    }));
    this.cycleHotkeys = options.cycleHotkeys ?? [];
    this.onChoose = onChoose;
    this.onCloseWithoutChoice = onCloseWithoutChoice;
    this.showPathInSuggestion = options.showPathInSuggestion ?? true;
    this.onModalClose = options.onModalClose;
    this.setPlaceholder(options.placeholder ?? "Select task note...");
    this.registerCycleHotkeys();
    this.applySearchMode();
  }

  getItems(): TFile[] {
    return this.getCurrentSearchMode().tasks;
  }

  cycleSearchMode(): void {
    if (this.searchModes.length <= 1) return;
    this.searchModeIndex = (this.searchModeIndex + 1) % this.searchModes.length;
    this.applySearchMode(true);
  }

  getItemText(file: TFile): string {
    const text = `${file.basename} ${file.path}`;
    return `${text} ${transliterateLayout(text)}`;
  }

  renderSuggestion(value: FuzzyMatch<TFile>, el: HTMLElement): void {
    const file = value.item;
    const decoration = this.getSuggestionDecoration(file);
    const titleRow = el.createDiv({ cls: "fmo-task-suggestion-title" });
    const labelCls = decoration?.dimmed ? "fmo-task-suggestion-label fmo-task-suggestion-label-dimmed" : "fmo-task-suggestion-label";
    const labelEl = titleRow.createSpan({ cls: labelCls });
    const highlights = this.getBasenameHighlights(file, value.match?.matches);
    this.renderHighlightedText(labelEl, file.basename, highlights);
    if (decoration?.badges?.length) {
      const badgesEl = titleRow.createDiv({ cls: "fmo-task-suggestion-badges" });
      for (const badge of decoration.badges) {
        const toneClass = badge.tone ? ` fmo-task-suggestion-badge-${badge.tone}` : "";
        badgesEl.createSpan({
          text: badge.label,
          cls: `fmo-task-suggestion-badge${toneClass}`
        });
      }
    }
    if (this.showPathInSuggestion) {
      el.createEl("small", { text: file.path, cls: "fmo-suggestion-path" });
    }
  }

  onChooseItem(file: TFile): void {
    this.wasChosen = true;
    this.onChoose(file);
  }

  onOpen(): void {
    this.isModalOpen = true;
    super.onOpen();
    this.applySearchMode(true);
  }

  onClose(): void {
    this.isModalOpen = false;
    super.onClose();
    window.setTimeout(() => {
      if (!this.wasChosen) {
        this.onCloseWithoutChoice?.();
      }
      this.onModalClose?.();
    }, 0);
  }

  private applySearchMode(refresh = false): void {
    const mode = this.getCurrentSearchMode();
    this.emptyStateText = mode.emptyStateText ?? this.defaultEmptyStateText;
    this.setInstructions(mode.instructions ?? []);

    if (refresh && this.isModalOpen) {
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  private getSuggestionDecoration(file: TFile): TaskSelectModalSuggestionDecoration | undefined {
    return this.getCurrentSearchMode().suggestionDecorations?.[file.path];
  }

  private getCurrentSearchMode(): TaskSelectModalSearchMode {
    return this.searchModes[this.searchModeIndex] ?? this.searchModes[0] ?? { tasks: [] };
  }

  /** Map fuzzy match ranges back to basename char indices, accounting for transliterated portion. */
  private getBasenameHighlights(file: TFile, matches: [number, number][] | undefined): Set<number> {
    const highlights = new Set<number>();
    if (!matches?.length) return highlights;

    // Must mirror getItemText layout: "basename path transliterated(basename path)"
    const basenameLen = file.basename.length;
    const transOffset = basenameLen + 1 + file.path.length + 1;

    for (const [start, end] of matches) {
      for (let i = start; i < end; i++) {
        if (i < basenameLen) {
          highlights.add(i);
        } else if (i >= transOffset && i < transOffset + basenameLen) {
          highlights.add(i - transOffset);
        }
      }
    }
    return highlights;
  }

  private renderHighlightedText(container: HTMLElement, text: string, highlights: Set<number>): void {
    if (highlights.size === 0) {
      container.textContent = text;
      return;
    }
    let pos = 0;
    while (pos < text.length) {
      const isHl = highlights.has(pos);
      let end = pos + 1;
      while (end < text.length && highlights.has(end) === isHl) end++;
      container.createSpan({
        text: text.slice(pos, end),
        cls: isHl ? "suggestion-highlight" : undefined
      });
      pos = end;
    }
  }

  private registerCycleHotkeys(): void {
    const seen = new Set<string>();
    const register = (hotkey: Hotkey): void => {
      const signature = `${[...hotkey.modifiers].sort().join("+")}::${hotkey.key}`;
      if (seen.has(signature)) return;
      seen.add(signature);
      this.scope.register(hotkey.modifiers, hotkey.key, () => {
        this.cycleSearchMode();
        return false;
      });
    };

    register({ modifiers: [], key: "Tab" });

    for (const hotkey of this.cycleHotkeys) {
      if (!hotkey.key) continue;
      register(hotkey);
    }
  }
}
