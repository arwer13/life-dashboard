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
    const text = this.editorEl.value;
    const lines = text.split("\n");
    const html = lines.map((line) => highlightLine(line)).join("\n");
    this.highlightEl.innerHTML = html;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightLine(line: string): string {
  if (RE_COMMENT_LINE.test(line)) {
    return `<span class="bc-comment">${escapeHtml(line)}</span>`;
  }

  if (RE_DIRECTIVE_LINE.test(line)) {
    const matched = line.replace(
      RE_DIRECTIVE_CAPTURE,
      (_, ws, dir, sp, str, rest) =>
        `${escapeHtml(ws)}<span class="bc-directive">${escapeHtml(dir)}</span>${escapeHtml(sp)}<span class="bc-string">${escapeHtml(str)}</span>${highlightTokens(rest)}`
    );
    if (matched !== line) return matched;
    return escapeHtml(line);
  }

  const dateMatch = line.match(RE_DATE_PREFIX);
  if (dateMatch) {
    const dateStr = dateMatch[1];
    const rest = line.slice(dateMatch[0].length);
    return `<span class="bc-date">${escapeHtml(dateStr)}</span> ${highlightDirectiveLine(rest)}`;
  }

  if (RE_INDENTED.test(line)) {
    return highlightPosting(line);
  }

  return escapeHtml(line);
}

function highlightDirectiveLine(rest: string): string {
  const txnMatch = rest.match(RE_TXN_FLAG);
  if (txnMatch) {
    return `<span class="bc-flag">${escapeHtml(txnMatch[1])}</span> ${highlightTokens(txnMatch[2])}`;
  }

  const dirMatch = rest.match(RE_DIR_KEYWORD);
  if (dirMatch) {
    return `<span class="bc-directive">${escapeHtml(dirMatch[1])}</span> ${highlightTokens(dirMatch[2])}`;
  }

  return highlightTokens(rest);
}

function highlightPosting(line: string): string {
  const m = line.match(RE_POSTING);
  if (!m) return escapeHtml(line);

  const indent = m[1];
  const account = m[2];
  const rest = m[3];

  const accountSpan = RE_ACCOUNT.test(account)
    ? `<span class="bc-account">${escapeHtml(account)}</span>`
    : escapeHtml(account);

  return `${escapeHtml(indent)}${accountSpan}${highlightTokens(rest)}`;
}

function highlightTokens(s: string): string {
  if (!s) return "";
  RE_TOKENS.lastIndex = 0;
  return s.replace(
    RE_TOKENS,
    (match, str, num, ccy, comment, acct) => {
      if (str) return `<span class="bc-string">${escapeHtml(str)}</span>`;
      if (num) {
        let result = `<span class="bc-amount">${escapeHtml(num)}</span>`;
        if (ccy) result += ` <span class="bc-currency">${escapeHtml(ccy)}</span>`;
        return result;
      }
      if (comment) return `<span class="bc-comment">${escapeHtml(comment)}</span>`;
      if (acct) return `<span class="bc-account">${escapeHtml(acct)}</span>`;
      return escapeHtml(match);
    }
  );
}
