// eslint-disable-next-line import/no-extraneous-dependencies
import { Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { editorInfoField } from "obsidian";
import { resolveParentPath } from "../../services/task-tree-builder";
import type LifeDashboardPlugin from "../../plugin";
import { isFileItem } from "../../models/types";
import { createTreeVersionExtension } from "./tree-version-watcher";

type ChildInfo = { name: string; path: string; mtime: number };

class SubConcernsWidget extends WidgetType {
  constructor(
    private readonly children: ChildInfo[],
    private readonly plugin: LifeDashboardPlugin
  ) {
    super();
  }

  eq(other: SubConcernsWidget): boolean {
    if (this.children.length !== other.children.length) return false;
    return this.children.every((c, i) =>
      c.path === other.children[i].path && c.name === other.children[i].name
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "fmo-sub-concerns-inline";

    const prefix = el.createSpan({ cls: "fmo-sub-concerns-prefix", text: "\u21b3" });
    prefix.setAttribute("aria-hidden", "true");

    for (let i = 0; i < this.children.length; i++) {
      if (i > 0) {
        el.createSpan({ cls: "fmo-sub-concerns-sep", text: "\u00b7" });
      }
      const child = this.children[i];
      const link = el.createEl("a", {
        cls: "fmo-sub-concern-link",
        text: child.name
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void this.plugin.openFile(child.path);
      });
    }

    return el;
  }

  get estimatedHeight(): number {
    return 24;
  }
}

export function createSubConcernsExtension(plugin: LifeDashboardPlugin): Extension {
  return createTreeVersionExtension(plugin, buildDecorations);
}

function buildDecorations(state: EditorState, plugin: LifeDashboardPlugin): DecorationSet {
  const filePath = state.field(editorInfoField, false)?.file?.path ?? null;
  if (!filePath) return Decoration.none;

  const fmEnd = findFrontmatterEnd(state);
  if (fmEnd < 0) return Decoration.none;

  const children = getDirectChildren(plugin, filePath);
  if (children.length === 0) return Decoration.none;

  return Decoration.set([
    Decoration.widget({
      widget: new SubConcernsWidget(children, plugin),
      block: true,
      side: 1
    }).range(fmEnd)
  ]);
}

function findFrontmatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 2) return -1;

  const first = doc.line(1);
  if (first.text.trim() !== "---") return -1;

  const limit = Math.min(doc.lines, 50);
  for (let i = 2; i <= limit; i++) {
    const line = doc.line(i);
    if (line.text.trim() === "---") {
      return line.to;
    }
  }
  return -1;
}

function getDirectChildren(plugin: LifeDashboardPlugin, parentPath: string): ChildInfo[] {
  const items = plugin.getTaskTreeItems();
  const children: ChildInfo[] = [];

  for (const item of items) {
    if (!isFileItem(item)) continue;
    if (item.file.path === parentPath) continue;
    const resolved = resolveParentPath(item.parentRaw, item.file.path, plugin.app.metadataCache);
    if (resolved === parentPath) {
      children.push({ name: item.file.basename, path: item.file.path, mtime: item.file.stat.mtime });
    }
  }

  children.sort((a, b) => b.mtime - a.mtime);
  return children;
}
