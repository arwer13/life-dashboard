import { TFile, type App, type FrontMatterCache } from "obsidian";
import type { TaskItem } from "../models/types";
import type { LifeDashboardSettings } from "../settings";

export class TaskFilterService {
  private readonly app: App;
  private readonly settings: LifeDashboardSettings;

  constructor(app: App, settings: LifeDashboardSettings) {
    this.app = app;
    this.settings = settings;
  }

  getTaskTreeItems(): TaskItem[] {
    const files = this.app.vault.getMarkdownFiles();
    const tasks: TaskItem[] = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!this.frontmatterMatchesTaskFilters(fm)) continue;

      tasks.push({
        file,
        parentRaw: fm?.parent
      });
    }

    tasks.sort((a, b) => a.file.path.localeCompare(b.file.path));
    return tasks;
  }

  fileMatchesTaskFilter(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    return this.frontmatterMatchesTaskFilters(cache?.frontmatter);
  }

  private frontmatterMatchesTaskFilters(frontmatter: FrontMatterCache | undefined): boolean {
    const prop = this.settings.propertyName.trim();
    if (!prop) return false;
    if (!frontmatter || !(prop in frontmatter)) return false;

    const primaryActual = String(frontmatter[prop] ?? "");
    if (!this.matchesValue(primaryActual, this.settings.propertyValue.trim())) {
      return false;
    }

    const extraProp = this.settings.additionalFilterPropertyName.trim();
    if (!extraProp) return true;
    if (!(extraProp in frontmatter)) return false;

    const extraActual = String(frontmatter[extraProp] ?? "");
    return this.matchesValue(extraActual, this.settings.additionalFilterPropertyValue.trim());
  }

  private matchesValue(actual: string, expected: string): boolean {
    if (!expected || expected.trim().length === 0) return true;

    if (this.settings.caseSensitive) {
      return actual === expected;
    }

    return actual.toLowerCase() === expected.toLowerCase();
  }
}
