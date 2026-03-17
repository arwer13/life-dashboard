import {
  TFile,
  TFolder,
  normalizePath,
  type App
} from "obsidian";
import type { TimeWindow } from "./time-window-service";
import { toDateKey, getDayStart } from "./year-grid-utils";

const TRACKING_FOLDER_PATH = "Me/Tracking";
const SLEEP_FILE_PATTERN = /^sleep.*\.csv$/i;
const STEPS_FILE_PATTERN = /^steps.*\.csv$/i;

export type HealthTrackingDay = {
  dateKey: string;
  sleepMinutes: number | null;
  avgSleepHr: number | null;
  steps: number | null;
  sleepWindowLabel: string | null;
  sleepSourcePath: string | null;
  stepsSourcePath: string | null;
};

export type HealthTrackingObservability = {
  trackingFolderFound: boolean;
  sleepFiles: string[];
  stepsFiles: string[];
  sleepRows: number;
  stepsRows: number;
  parseErrors: string[];
  loadedAtMs: number;
};

export type HealthTrackingSnapshot = {
  daysByDateKey: Map<string, HealthTrackingDay>;
  observability: HealthTrackingObservability;
};

export type HealthTrackingRangeSummary = {
  activeDayCount: number;
  sleepDays: number;
  stepsDays: number;
  completeDays: number;
  averageSleepMinutes: number | null;
  averageSleepHr: number | null;
  averageSteps: number | null;
};

export type HealthTrackingRangeSnapshot = {
  daysByDateKey: Map<string, HealthTrackingDay>;
  summary: HealthTrackingRangeSummary;
  observability: HealthTrackingObservability;
};

type SleepRecord = {
  dateKey: string;
  sleepMinutes: number;
  avgSleepHr: number | null;
  sleepWindowLabel: string | null;
  sourcePath: string;
};

export class HealthTrackingService {
  private readonly app: App;
  private snapshot: HealthTrackingSnapshot = this.createEmptySnapshot(false);
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  constructor(app: App) {
    this.app = app;
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
        console.error("[life-dashboard] Failed to load health tracking data:", error);
        const snapshot = this.createEmptySnapshot(this.hasTrackingFolder());
        snapshot.observability.parseErrors.push(
          error instanceof Error ? error.message : String(error)
        );
        this.snapshot = snapshot;
      })
      .finally(() => {
        this.loaded = true;
        this.loadPromise = null;
      });

    await this.loadPromise;
  }

  getRangeSnapshot(window: TimeWindow, now: Date): HealthTrackingRangeSnapshot {
    const daysByDateKey = new Map<string, HealthTrackingDay>();

    const startDate = new Date(window.startMs);
    const endDate = new Date(window.endMs);
    const tomorrowStart = getDayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

    const activeEndMs = Math.min(window.endMs, tomorrowStart.getTime());
    const summary: HealthTrackingRangeSummary = {
      activeDayCount: 0,
      sleepDays: 0,
      stepsDays: 0,
      completeDays: 0,
      averageSleepMinutes: null,
      averageSleepHr: null,
      averageSteps: null,
    };

    let sleepMinutesTotal = 0;
    let sleepHrTotal = 0;
    let sleepHrDays = 0;
    let stepsTotal = 0;

    for (
      const cursor = getDayStart(startDate);
      cursor.getTime() < endDate.getTime();
      cursor.setDate(cursor.getDate() + 1)
    ) {
      const dateKey = toDateKey(cursor);
      const day = this.snapshot.daysByDateKey.get(dateKey);
      if (day) {
        daysByDateKey.set(dateKey, day);
      }

      if (cursor.getTime() >= activeEndMs) {
        continue;
      }

      summary.activeDayCount += 1;

      if (day?.sleepMinutes != null) {
        summary.sleepDays += 1;
        sleepMinutesTotal += day.sleepMinutes;
        if (day.avgSleepHr != null) {
          sleepHrDays += 1;
          sleepHrTotal += day.avgSleepHr;
        }
      }

      if (day?.steps != null) {
        summary.stepsDays += 1;
        stepsTotal += day.steps;
      }

      if (day?.sleepMinutes != null && day.steps != null) {
        summary.completeDays += 1;
      }
    }

    if (summary.sleepDays > 0) {
      summary.averageSleepMinutes = sleepMinutesTotal / summary.sleepDays;
    }
    if (sleepHrDays > 0) {
      summary.averageSleepHr = sleepHrTotal / sleepHrDays;
    }
    if (summary.stepsDays > 0) {
      summary.averageSteps = stepsTotal / summary.stepsDays;
    }

    return {
      daysByDateKey,
      summary,
      observability: this.snapshot.observability,
    };
  }

  matchesTrackingPath(path: string): boolean {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${TRACKING_FOLDER_PATH}/`)) return false;
    const fileName = normalized.split("/").pop() ?? "";
    return SLEEP_FILE_PATTERN.test(fileName) || STEPS_FILE_PATTERN.test(fileName);
  }

  private async loadInternal(): Promise<void> {
    const trackingFolder = this.app.vault.getAbstractFileByPath(TRACKING_FOLDER_PATH);
    const trackingFolderFound = trackingFolder instanceof TFolder;
    const snapshot = this.createEmptySnapshot(trackingFolderFound);

    if (!(trackingFolder instanceof TFolder)) {
      this.snapshot = snapshot;
      return;
    }

    const trackingFiles = this.collectFiles(trackingFolder)
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
    const sleepFiles = trackingFiles.filter((file) => SLEEP_FILE_PATTERN.test(file.name));
    const stepsFiles = trackingFiles.filter((file) => STEPS_FILE_PATTERN.test(file.name));

    snapshot.observability.sleepFiles = sleepFiles.map((file) => file.path);
    snapshot.observability.stepsFiles = stepsFiles.map((file) => file.path);

    const [sleepResults, stepsResults] = await Promise.all([
      Promise.all(sleepFiles.map(async (file) => {
        const content = await this.app.vault.cachedRead(file);
        return this.parseSleepCsv(content, file.path);
      })),
      Promise.all(stepsFiles.map(async (file) => {
        const content = await this.app.vault.cachedRead(file);
        return this.parseStepsCsv(content, file.path);
      })),
    ]);

    const sleepByDateKey = new Map<string, SleepRecord>();
    for (const parsed of sleepResults) {
      snapshot.observability.sleepRows += parsed.rowCount;
      snapshot.observability.parseErrors.push(...parsed.errors);

      for (const record of parsed.records) {
        const existing = sleepByDateKey.get(record.dateKey);
        if (!existing || record.sleepMinutes > existing.sleepMinutes) {
          sleepByDateKey.set(record.dateKey, record);
        }
      }
    }

    const daysByDateKey = new Map<string, HealthTrackingDay>();
    for (const record of sleepByDateKey.values()) {
      const day = this.ensureDay(daysByDateKey, record.dateKey);
      day.sleepMinutes = record.sleepMinutes;
      day.avgSleepHr = record.avgSleepHr;
      day.sleepWindowLabel = record.sleepWindowLabel;
      day.sleepSourcePath = record.sourcePath;
    }

    for (const parsed of stepsResults) {
      snapshot.observability.stepsRows += parsed.rowCount;
      snapshot.observability.parseErrors.push(...parsed.errors);

      for (const record of parsed.records) {
        const day = this.ensureDay(daysByDateKey, record.dateKey);
        day.steps = record.steps;
        day.stepsSourcePath = record.sourcePath;
      }
    }

    snapshot.daysByDateKey = daysByDateKey;
    this.snapshot = snapshot;
  }

  private hasTrackingFolder(): boolean {
    return this.app.vault.getAbstractFileByPath(TRACKING_FOLDER_PATH) instanceof TFolder;
  }

  private createEmptySnapshot(trackingFolderFound: boolean): HealthTrackingSnapshot {
    return {
      daysByDateKey: new Map(),
      observability: {
        trackingFolderFound,
        sleepFiles: [],
        stepsFiles: [],
        sleepRows: 0,
        stepsRows: 0,
        parseErrors: [],
        loadedAtMs: Date.now(),
      },
    };
  }

  private collectFiles(folder: TFolder): TFile[] {
    const result: TFile[] = [];
    const stack: TFolder[] = [folder];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;

      for (const child of current.children) {
        if (child instanceof TFile) {
          result.push(child);
        } else if (child instanceof TFolder) {
          stack.push(child);
        }
      }
    }

    return result;
  }

  private ensureDay(daysByDateKey: Map<string, HealthTrackingDay>, dateKey: string): HealthTrackingDay {
    const existing = daysByDateKey.get(dateKey);
    if (existing) return existing;

    const next: HealthTrackingDay = {
      dateKey,
      sleepMinutes: null,
      avgSleepHr: null,
      steps: null,
      sleepWindowLabel: null,
      sleepSourcePath: null,
      stepsSourcePath: null,
    };
    daysByDateKey.set(dateKey, next);
    return next;
  }

  private parseSleepCsv(
    content: string,
    sourcePath: string
  ): { records: SleepRecord[]; rowCount: number; errors: string[] } {
    const errors: string[] = [];
    const rows = this.getCsvRows(content);
    if (rows.length === 0) {
      return { records: [], rowCount: 0, errors };
    }

    const header = rows[0];
    const totalSleepIdx = header.indexOf("total_sleep_min");
    const bedStartIdx = header.indexOf("bed_start");
    const bedEndIdx = header.indexOf("bed_end");
    const avgSleepHrIdx = header.indexOf("avg_sleep_hr");
    const nightDateIdx = header.indexOf("night_date");

    if (totalSleepIdx < 0 || (bedEndIdx < 0 && nightDateIdx < 0)) {
      errors.push(`Could not parse sleep CSV header in ${sourcePath}.`);
      return { records: [], rowCount: 0, errors };
    }

    const records: SleepRecord[] = [];
    let rowCount = 0;

    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      if (row.every((value) => value.trim() === "")) continue;
      rowCount += 1;

      const sleepMinutes = this.parseNumber(row[totalSleepIdx]);
      if (sleepMinutes == null || sleepMinutes <= 0) {
        errors.push(`Skipping sleep row ${index + 1} in ${sourcePath}: invalid total_sleep_min.`);
        continue;
      }

      const bedEnd = bedEndIdx >= 0 ? this.parseLocalDateTime(row[bedEndIdx]) : null;
      const nightDate = nightDateIdx >= 0 ? this.parseLocalDate(row[nightDateIdx]) : null;
      const dateKey = bedEnd ? toDateKey(bedEnd) : nightDate ? toDateKey(nightDate) : "";
      if (!dateKey) {
        errors.push(`Skipping sleep row ${index + 1} in ${sourcePath}: invalid date.`);
        continue;
      }

      const bedStart = bedStartIdx >= 0 ? this.parseLocalDateTime(row[bedStartIdx]) : null;
      const avgSleepHr = avgSleepHrIdx >= 0 ? this.parseNumber(row[avgSleepHrIdx]) : null;

      records.push({
        dateKey,
        sleepMinutes,
        avgSleepHr,
        sleepWindowLabel: this.buildSleepWindowLabel(bedStart, bedEnd),
        sourcePath,
      });
    }

    return { records, rowCount, errors };
  }

  private parseStepsCsv(
    content: string,
    sourcePath: string
  ): { records: Array<{ dateKey: string; steps: number; sourcePath: string }>; rowCount: number; errors: string[] } {
    const errors: string[] = [];
    const rows = this.getCsvRows(content);
    if (rows.length === 0) {
      return { records: [], rowCount: 0, errors };
    }

    const header = rows[0];
    const dateIdx = header.indexOf("date");
    const stepsIdx = header.indexOf("steps");
    if (dateIdx < 0 || stepsIdx < 0) {
      errors.push(`Could not parse steps CSV header in ${sourcePath}.`);
      return { records: [], rowCount: 0, errors };
    }

    const records: Array<{ dateKey: string; steps: number; sourcePath: string }> = [];
    let rowCount = 0;

    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      if (row.every((value) => value.trim() === "")) continue;
      rowCount += 1;

      const date = this.parseLocalDate(row[dateIdx]);
      const steps = this.parseNumber(row[stepsIdx]);
      if (!date || steps == null || steps < 0) {
        errors.push(`Skipping steps row ${index + 1} in ${sourcePath}: invalid date or steps.`);
        continue;
      }

      records.push({
        dateKey: toDateKey(date),
        steps,
        sourcePath,
      });
    }

    return { records, rowCount, errors };
  }

  private getCsvRows(content: string): string[][] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => this.parseCsvLine(line));
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index++) {
      const char = line[index];

      if (char === "\"") {
        const next = line[index + 1];
        if (inQuotes && next === "\"") {
          current += "\"";
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        result.push(current);
        current = "";
        continue;
      }

      current += char;
    }

    result.push(current);
    return result.map((value) => value.trim());
  }

  private parseNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseLocalDate(value: string | undefined): Date | null {
    if (!value) return null;
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  }

  private parseLocalDateTime(value: string | undefined): Date | null {
    if (!value) return null;
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (!match) return null;

    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  }

  private buildSleepWindowLabel(start: Date | null, end: Date | null): string | null {
    if (!start || !end) return null;
    return `${this.formatTime(start)}-${this.formatTime(end)}`;
  }

  private formatTime(date: Date): string {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

}
