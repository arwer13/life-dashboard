import { DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { editorInfoField } from "obsidian";
import type LifeDashboardPlugin from "../../plugin";

/**
 * Creates a CodeMirror extension that rebuilds decorations when the plugin's
 * tree structure version changes or the active file changes.
 */
export function createTreeVersionExtension(
  plugin: LifeDashboardPlugin,
  buildDecorations: (state: EditorState, plugin: LifeDashboardPlugin) => DecorationSet
): Extension {
  const rebuildEffect = StateEffect.define<null>();

  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, plugin);
    },
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(rebuildEffect))) {
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
