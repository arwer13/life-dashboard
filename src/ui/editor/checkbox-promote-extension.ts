// eslint-disable-next-line import/no-extraneous-dependencies
import { Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { TFile, editorInfoField } from "obsidian";
import type LifeDashboardPlugin from "../../plugin";
import { createTreeVersionExtension } from "./tree-version-watcher";

class PromoteButtonWidget extends WidgetType {
  constructor(
    private readonly filePath: string,
    private readonly lineNumber: number,
    private readonly plugin: LifeDashboardPlugin
  ) {
    super();
  }

  eq(other: PromoteButtonWidget): boolean {
    return this.filePath === other.filePath && this.lineNumber === other.lineNumber;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "fmo-promote-checkbox-btn";
    btn.textContent = "\u2197";
    btn.title = "Promote to concern note";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.plugin.promoteCheckboxToConcern(this.filePath, this.lineNumber);
    });
    return btn;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export function createCheckboxPromoteExtension(plugin: LifeDashboardPlugin): Extension {
  return createTreeVersionExtension(plugin, buildDecorations);
}

function buildDecorations(state: EditorState, plugin: LifeDashboardPlugin): DecorationSet {
  const filePath = state.field(editorInfoField, false)?.file?.path ?? null;
  if (!filePath) return Decoration.none;

  // Only decorate concern files
  if (!isConcernFile(plugin, filePath)) return Decoration.none;

  const doc = state.doc;
  const decorations: { from: number; to: number; deco: Decoration }[] = [];

  let inTasksSection = false;
  let tasksSectionLevel = 0;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    // Check for heading
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(text);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim().toLowerCase();

      if (title === "tasks") {
        inTasksSection = true;
        tasksSectionLevel = level;
        continue;
      }

      // A heading of same or higher level ends the tasks section
      if (inTasksSection && level <= tasksSectionLevel) {
        inTasksSection = false;
      }
      continue;
    }

    // Collect unchecked checkboxes within the tasks section
    if (inTasksSection && /^\s*- \[ \]\s+.+$/.test(text)) {
      const lineNumber = i - 1; // 0-based
      decorations.push({
        from: line.to,
        to: line.to,
        deco: Decoration.widget({
          widget: new PromoteButtonWidget(filePath, lineNumber, plugin),
          side: 1
        })
      });
    }
  }

  if (decorations.length === 0) return Decoration.none;

  return Decoration.set(
    decorations.map(d => d.deco.range(d.from)),
    true
  );
}

function isConcernFile(plugin: LifeDashboardPlugin, filePath: string): boolean {
  const file = plugin.app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return false;
  return plugin.isConcernFile(file);
}
