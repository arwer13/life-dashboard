import { ItemView, type WorkspaceLeaf } from "obsidian";
import type LifeDashboardPlugin from "../../plugin";
import { buildTaskTree, resolveParentPath } from "../../services/task-tree-builder";
import {
  filterTasksByQuery,
  parseFilterTokens,
  matchesFrontmatterFilter,
  flattenFrontmatterValues
} from "../../services/outline-filter";
import type { TaskItem } from "../../models/types";
import type { TaskTreeData, TaskTreeBuildOptions, OutlineFilterToken } from "../../models/view-types";

export abstract class LifeDashboardBaseView extends ItemView {
  protected readonly plugin: LifeDashboardPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: LifeDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  protected buildTaskTree(tasks: TaskItem[], options: TaskTreeBuildOptions = {}): TaskTreeData {
    return buildTaskTree(
      tasks,
      (parentRaw, sourcePath) => resolveParentPath(parentRaw, sourcePath, this.app.metadataCache),
      options
    );
  }

  protected resolveParentPath(parentRaw: unknown, sourcePath: string): string | null {
    return resolveParentPath(parentRaw, sourcePath, this.app.metadataCache);
  }

  protected filterTasksByQuery(tasks: TaskItem[], query: string): TaskItem[] {
    return filterTasksByQuery(tasks, query);
  }

  protected parseFilterTokens(query: string): OutlineFilterToken[] {
    return parseFilterTokens(query);
  }

  protected matchesFrontmatterFilter(
    frontmatter: TaskItem["frontmatter"],
    key: string,
    expectedValue: string | null
  ): boolean {
    return matchesFrontmatterFilter(frontmatter, key, expectedValue);
  }

  protected flattenFrontmatterValues(value: unknown): string[] {
    return flattenFrontmatterValues(value);
  }
}
