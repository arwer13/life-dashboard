import { TextFileView, debounce } from "obsidian";
import { VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT } from "../../models/view-types";

const RE_COMMENT_LINE = /^\s*;/;
const RE_DIRECTIVE_LINE = /^\s*(option|plugin|include)\s/;
const RE_DIRECTIVE_CAPTURE = /^(\s*)(option|plugin|include)(\s+)("(?:[^"\\]|\\.)*")(.*)$/;
const RE_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})\s+/;
const RE_INDENTED = /^\s+\S/;
const RE_TXN_FLAG = /^([*!])\s+(.*)/;
const RE_DIR_KEYWORD = /^(open|close|commodity|balance|pad|note|event|document|custom|price|query)\s+(.*)/;
const RE_POSTING = /^(\s+)(\S+)(.*)/;
const RE_ACCOUNT = /^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Za-z0-9_-]+)*$/;
const RE_TOKENS = /("(?:[^"\\]|\\.)*")|(-?[\d,]+(?:\.\d+)?)\s*([A-Z]{2,5}\b)?|(;.*$)|([A-Z][a-z]+(?::[A-Za-z0-9_-]+)+)/g;

export class LifeDashboardBeancountView extends TextFileView {
  private editorEl!: HTMLTextAreaElement;
  private highlightEl!: HTMLElement;
  private debouncedHighlight = debounce(() => this.renderHighlight(), 120, true);

  getViewType(): string {
    return VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Beancount";
  }

  getIcon(): string {
    return "coins";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("fmo-beancount");

    const container = contentEl.createEl("div", { cls: "fmo-beancount-container" });

    this.highlightEl = container.createEl("pre", { cls: "fmo-beancount-highlight" });
    this.highlightEl.setAttribute("aria-hidden", "true");

    this.editorEl = container.createEl("textarea", { cls: "fmo-beancount-editor" });
    this.editorEl.spellcheck = false;
    this.editorEl.setAttribute("wrap", "off");

    this.registerDomEvent(this.editorEl, "input", () => {
      this.requestSave();
      this.debouncedHighlight();
    });

    this.registerDomEvent(this.editorEl, "scroll", () => {
      this.highlightEl.scrollTop = this.editorEl.scrollTop;
      this.highlightEl.scrollLeft = this.editorEl.scrollLeft;
    });
  }

  getViewData(): string {
    return this.editorEl?.value ?? this.data;
  }

  setViewData(data: string, _clear: boolean): void {
    if (this.editorEl) {
      this.editorEl.value = data;
      this.renderHighlight();
    }
  }

  clear(): void {
    if (this.editorEl) {
      this.editorEl.value = "";
    }
    if (this.highlightEl) {
      this.highlightEl.empty();
    }
  }

  private renderHighlight(): void {
    this.highlightEl.empty();
    const text = this.editorEl.value;
    const lines = text.split("\n");
    const frag = createFragment();

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) frag.appendText("\n");
      highlightLine(frag, lines[i]);
    }

    this.highlightEl.appendChild(frag);
  }
}

function highlightLine(parent: DocumentFragment | HTMLElement, line: string): void {
  if (RE_COMMENT_LINE.test(line)) {
    parent.createSpan({ cls: "bc-comment", text: line });
    return;
  }

  if (RE_DIRECTIVE_LINE.test(line)) {
    const m = line.match(RE_DIRECTIVE_CAPTURE);
    if (m) {
      parent.appendText(m[1]);
      parent.createSpan({ cls: "bc-directive", text: m[2] });
      parent.appendText(m[3]);
      parent.createSpan({ cls: "bc-string", text: m[4] });
      highlightTokens(parent, m[5]);
      return;
    }
    parent.appendText(line);
    return;
  }

  const dateMatch = line.match(RE_DATE_PREFIX);
  if (dateMatch) {
    parent.createSpan({ cls: "bc-date", text: dateMatch[1] });
    parent.appendText(" ");
    highlightDirectiveLine(parent, line.slice(dateMatch[0].length));
    return;
  }

  if (RE_INDENTED.test(line)) {
    highlightPosting(parent, line);
    return;
  }

  parent.appendText(line);
}

function highlightDirectiveLine(parent: DocumentFragment | HTMLElement, rest: string): void {
  const txnMatch = rest.match(RE_TXN_FLAG);
  if (txnMatch) {
    parent.createSpan({ cls: "bc-flag", text: txnMatch[1] });
    parent.appendText(" ");
    highlightTokens(parent, txnMatch[2]);
    return;
  }

  const dirMatch = rest.match(RE_DIR_KEYWORD);
  if (dirMatch) {
    parent.createSpan({ cls: "bc-directive", text: dirMatch[1] });
    parent.appendText(" ");
    highlightTokens(parent, dirMatch[2]);
    return;
  }

  highlightTokens(parent, rest);
}

function highlightPosting(parent: DocumentFragment | HTMLElement, line: string): void {
  const m = line.match(RE_POSTING);
  if (!m) {
    parent.appendText(line);
    return;
  }

  parent.appendText(m[1]);
  if (RE_ACCOUNT.test(m[2])) {
    parent.createSpan({ cls: "bc-account", text: m[2] });
  } else {
    parent.appendText(m[2]);
  }
  highlightTokens(parent, m[3]);
}

function highlightTokens(parent: DocumentFragment | HTMLElement, s: string): void {
  if (!s) return;
  RE_TOKENS.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = RE_TOKENS.exec(s)) !== null) {
    if (match.index > lastIndex) {
      parent.appendText(s.slice(lastIndex, match.index));
    }
    const [full, str, num, ccy, comment, acct] = match;
    if (str) {
      parent.createSpan({ cls: "bc-string", text: str });
    } else if (num) {
      parent.createSpan({ cls: "bc-amount", text: num });
      if (ccy) {
        parent.appendText(" ");
        parent.createSpan({ cls: "bc-currency", text: ccy });
      }
    } else if (comment) {
      parent.createSpan({ cls: "bc-comment", text: comment });
    } else if (acct) {
      parent.createSpan({ cls: "bc-account", text: acct });
    } else {
      parent.appendText(full);
    }
    lastIndex = RE_TOKENS.lastIndex;
  }

  if (lastIndex < s.length) {
    parent.appendText(s.slice(lastIndex));
  }
}
