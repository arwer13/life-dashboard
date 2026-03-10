import { ButtonComponent, Modal, type App } from "obsidian";

export class TextInputModal extends Modal {
  private readonly promptText: string;
  private readonly placeholder: string;
  private readonly onSubmit: (value: string) => void;

  constructor(
    app: App,
    promptText: string,
    placeholder: string,
    onSubmit: (value: string) => void
  ) {
    super(app);
    this.promptText = promptText;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.promptText });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: this.placeholder,
      cls: "fmo-text-input-modal-input"
    });

    const submit = (): void => {
      const value = input.value.trim();
      if (!value) return;
      this.close();
      this.onSubmit(value);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    const btnContainer = contentEl.createDiv({ cls: "fmo-text-input-modal-buttons" });
    new ButtonComponent(btnContainer)
      .setButtonText("Create")
      .setCta()
      .onClick(submit);

    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
