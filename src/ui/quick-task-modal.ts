import { ButtonComponent, Modal, type App } from "obsidian";
import { PRIORITY_DIGIT_TO_EMOJI } from "../services/inline-task-parser";

const PRIORITY_OPTIONS = [
  { digit: "0", label: "p0" },
  { digit: "1", label: "p1" },
  { digit: "2", label: "p2" },
  { digit: "3", label: "p3" },
];

export class QuickTaskModal extends Modal {
  private readonly onSubmit: (text: string, priorityEmoji: string | null) => void;

  constructor(
    app: App,
    onSubmit: (text: string, priorityEmoji: string | null) => void
  ) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("fmo-quick-task-modal");
    contentEl.createEl("p", { text: "Quick task → inbox" });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "Task description",
      cls: "fmo-text-input-modal-input"
    });

    let selectedDigit: string | null = null;

    const priorityRow = contentEl.createEl("div", { cls: "fmo-quick-task-priorities" });
    const buttons: HTMLButtonElement[] = [];
    for (const opt of PRIORITY_OPTIONS) {
      const btn = priorityRow.createEl("button", {
        text: opt.label,
        cls: "fmo-outline-range-btn",
        attr: { type: "button" }
      });
      buttons.push(btn);
      btn.addEventListener("click", () => {
        if (selectedDigit === opt.digit) {
          selectedDigit = null;
          btn.removeClass("fmo-outline-range-btn-active");
        } else {
          selectedDigit = opt.digit;
          for (const b of buttons) b.removeClass("fmo-outline-range-btn-active");
          btn.addClass("fmo-outline-range-btn-active");
        }
        input.focus();
      });
    }

    const submit = (): void => {
      const value = input.value.trim();
      if (!value) return;
      const emoji = selectedDigit ? (PRIORITY_DIGIT_TO_EMOJI.get(selectedDigit) ?? null) : null;
      this.close();
      this.onSubmit(value, emoji);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    const btnContainer = contentEl.createDiv({ cls: "fmo-text-input-modal-buttons" });
    new ButtonComponent(btnContainer)
      .setButtonText("Add")
      .setCta()
      .onClick(submit);

    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
