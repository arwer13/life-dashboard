import { TFile, type App, type FrontMatterCache } from "obsidian";
import type { TaskItem } from "../models/types";
import type { LifeDashboardSettings } from "../settings";
import { flattenFrontmatterValues } from "./outline-filter";

export class TaskFilterService {
  private readonly app: App;
  private readonly settings: LifeDashboardSettings;
  private cachedTasks: TaskItem[] | null = null;
  private lastCacheKey = "";

  constructor(app: App, settings: LifeDashboardSettings) {
    this.app = app;
    this.settings = settings;
  }

  invalidateCache(): void {
    this.cachedTasks = null;
    this.lastCacheKey = "";
  }

  getTaskTreeItems(): TaskItem[] {
    const cacheKey = this.buildCacheKey();
    if (this.cachedTasks && this.lastCacheKey === cacheKey) {
      return [...this.cachedTasks];
    }

    const files = this.app.vault.getMarkdownFiles();
    const tasks: TaskItem[] = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!this.frontmatterMatchesTaskFilters(fm)) continue;

      tasks.push({
        kind: "file",
        file,
        path: file.path,
        basename: file.basename,
        parentRaw: fm?.parent,
        frontmatter: fm
      });
    }

    tasks.sort((a, b) => a.path.localeCompare(b.path));
    this.cachedTasks = tasks;
    this.lastCacheKey = cacheKey;
    return [...tasks];
  }

  fileMatchesTaskFilter(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    return this.frontmatterMatchesTaskFilters(cache?.frontmatter);
  }

  private frontmatterMatchesTaskFilters(frontmatter: FrontMatterCache | undefined): boolean {
    const prop = this.settings.propertyName.trim();
    if (!prop) return false;
    if (!frontmatter || !(prop in frontmatter)) return false;

    if (!this.matchesValue(frontmatter[prop], this.settings.propertyValue.trim())) {
      return false;
    }

    const extraProp = this.settings.additionalFilterPropertyName.trim();
    if (!extraProp) return true;
    if (!(extraProp in frontmatter)) return false;

    return this.matchesValue(frontmatter[extraProp], this.settings.additionalFilterPropertyValue.trim());
  }

  private matchesValue(actual: unknown, expected: string): boolean {
    if (!expected || expected.trim().length === 0) return true;

    const expectedValue = this.settings.caseSensitive ? expected : expected.toLowerCase();
    const values = flattenFrontmatterValues(actual);

    return values.some((value) => {
      const normalized = this.settings.caseSensitive ? value : value.toLowerCase();
      return normalized === expectedValue;
    });
  }

  private buildCacheKey(): string {
    return [
      this.settings.propertyName.trim(),
      this.settings.propertyValue.trim(),
      this.settings.additionalFilterPropertyName.trim(),
      this.settings.additionalFilterPropertyValue.trim(),
      this.settings.caseSensitive ? "1" : "0",
      String(this.app.vault.getMarkdownFiles().length)
    ].join("|");
  }

}
