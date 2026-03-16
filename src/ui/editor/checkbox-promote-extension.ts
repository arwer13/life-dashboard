import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { TFile, editorInfoField } from "obsidian";
import type LifeDashboardPlugin from "../../plugin";

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

const rebuildEffect = StateEffect.define<null>();

export function createCheckboxPromoteExtension(plugin: LifeDashboardPlugin): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, plugin);
    },
    update(value, tr) {
      if (tr.docChanged || tr.effects.some(e => e.is(rebuildEffect))) {
        return buildDecorations(tr.state, plugin);
      }
      return value;
    },
    provide(field) {
      return EditorView.decorations.from(field);
    }
  });

  const watcher = ViewPlugin.fromClass(
    class {
      private lastTreeVersion = -1;
      private lastFilePath: string | null = null;

      constructor(view: EditorView) {
        this.sync(view.state);
      }

      update(update: ViewUpdate) {
        const filePath = update.state.field(editorInfoField, false)?.file?.path ?? null;
        const treeChanged = plugin.treeStructureVersion !== this.lastTreeVersion;
        const fileChanged = filePath !== this.lastFilePath;

        if (treeChanged || fileChanged) {
          this.sync(update.state);
          const view = update.view;
          requestAnimationFrame(() => view.dispatch({ effects: rebuildEffect.of(null) }));
        }
      }

      private sync(state: EditorState) {
        this.lastTreeVersion = plugin.treeStructureVersion;
        this.lastFilePath = state.field(editorInfoField, false)?.file?.path ?? null;
      }
    }
  );

  return [field, watcher];
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
