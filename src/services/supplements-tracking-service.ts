import { TFile, type App } from "obsidian";

export type SupplementDef = {
  key: string;
  ingredient: string;
  brand: string;
  ingredientUnit: string;
  ingredientAmount: number;
  supplementUnit: string;
  supplementAmount: number;
};

export type SupplementLogDay = {
  date: string;
  taken: string[];
  takenRaw: string[];
};

export type SupplementsSnapshot = {
  definitions: Map<string, SupplementDef>;
  log: SupplementLogDay[];
};

export class SupplementsTrackingService {
  private readonly app: App;
  private readonly getFilePath: () => string;
  private snapshot: SupplementsSnapshot = { definitions: new Map(), log: [] };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(app: App, getFilePath: () => string) {
    this.app = app;
    this.getFilePath = getFilePath;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = this.loadInternal()
      .catch((error) => {
        console.error("[life-dashboard] Failed to load supplements data:", error);
        this.snapshot = { definitions: new Map(), log: [] };
      })
      .finally(() => {
        this.loaded = true;
        this.loadPromise = null;
      });

    await this.loadPromise;
  }

  getSnapshot(): SupplementsSnapshot {
    return this.snapshot;
  }

  matchesPath(path: string): boolean {
    return path === this.getFilePath();
  }

  private async loadInternal(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.getFilePath());
    if (!(file instanceof TFile)) {
      this.snapshot = { definitions: new Map(), log: [] };
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    this.snapshot = this.parse(content);
  }

  private parse(content: string): SupplementsSnapshot {
    const definitions = new Map<string, SupplementDef>();
    const log: SupplementLogDay[] = [];

    const lines = content.split(/\r?\n/);
    let section: "none" | "pharma" | "log" = "none";
    let headerParsed = false;
    let columnMap: Record<string, number> = {};

    for (const line of lines) {
      const trimmed = line.trim();

      if (/^##\s+Pharma\b/i.test(trimmed)) {
        section = "pharma";
        headerParsed = false;
        continue;
      }
      if (/^##\s+Log\b/i.test(trimmed)) {
        section = "log";
        headerParsed = false;
        continue;
      }
      if (/^##\s/.test(trimmed)) {
        section = "none";
        continue;
      }

      if (!trimmed.startsWith("|")) continue;
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue;

      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());

      if (!headerParsed) {
        columnMap = {};
        cells.forEach((cell, index) => {
          columnMap[cell.toLowerCase()] = index;
        });
        headerParsed = true;
        continue;
      }

      if (section === "pharma") {
        const key = cells[columnMap["key"]] ?? "";
        const ingredient = cells[columnMap["ingredient"]] ?? "";
        const brand = cells[columnMap["brand"]] ?? "";
        const ingredientUnit = cells[columnMap["ingredient_unit"]] ?? "";
        const ingredientAmount = Number(cells[columnMap["ingredient_amount"]] ?? "0");
        const supplementUnit = cells[columnMap["supplement_unit"]] ?? "";
        const supplementAmount = Number(cells[columnMap["supplement_amount"]] ?? "0");

        if (key) {
          definitions.set(key, { key, ingredient, brand, ingredientUnit, ingredientAmount, supplementUnit, supplementAmount });
        }
      }

      if (section === "log") {
        const date = cells[columnMap["date"]] ?? "";
        const takenCell = cells[columnMap["taken"]] ?? "";
        const takenRaw = takenCell
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0);
        const taken = takenRaw.map((k) => k.replace(/@.*$/, ""));

        if (date) {
          log.push({ date, taken, takenRaw });
        }
      }
    }

    log.sort((a, b) => a.date.localeCompare(b.date));
    return { definitions, log };
  }
}
