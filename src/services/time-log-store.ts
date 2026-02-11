import { TFile, TFolder, normalizePath, type App } from "obsidian";
import type { TimeLogByNoteId } from "../models/types";
import {
  CURRENT_TIME_LOG_SCHEMA_VERSION,
  DEFAULT_TIME_LOG_PATH,
  type LifeDashboardSettings
} from "../settings";

export class TimeLogStore {
  private readonly app: App;
  private readonly settings: LifeDashboardSettings;
  private readonly saveSettings: () => Promise<void>;

  constructor(app: App, settings: LifeDashboardSettings, saveSettings: () => Promise<void>) {
    this.app = app;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  async appendTimeEntry(noteId: string, startMs: number, endMs: number): Promise<void> {
    const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
    const start = this.formatTimestamp(new Date(startMs));
    const token = this.formatIntervalToken(start, durationMinutes);

    const data = await this.readTimeLogMap();
    const current = data[noteId] ?? [];
    data[noteId] = this.normalizeAndValidateNoteIntervals([...current, token]);
    await this.writeTimeLog(data);
  }

  async readTimeLogMap(): Promise<TimeLogByNoteId> {
    await this.migrateIfNeeded();
    const raw = await this.readTimeLogRaw();
    return this.normalizeAndValidateTimeLogMap(raw);
  }

  async loadTotals(): Promise<Map<string, number>> {
    const data = await this.readTimeLogMap();
    const totals = new Map<string, number>();

    for (const [noteId, intervals] of Object.entries(data)) {
      let seconds = 0;
      for (const token of intervals) {
        const parsed = this.parseIntervalToken(token);
        if (!parsed) continue;
        seconds += parsed.durationMinutes * 60;
      }
      if (seconds > 0) {
        totals.set(noteId, seconds);
      }
    }

    return totals;
  }

  private async migrateIfNeeded(): Promise<void> {
    if (this.settings.timeLogSchemaVersion >= CURRENT_TIME_LOG_SCHEMA_VERSION) {
      return;
    }

    const raw = await this.readTimeLogRaw();
    const normalized = this.normalizeAndValidateTimeLogMap(raw);
    await this.writeTimeLog(normalized);

    this.settings.timeLogSchemaVersion = CURRENT_TIME_LOG_SCHEMA_VERSION;
    await this.saveSettings();
  }

  private getTimeLogPath(): string {
    const raw = (this.settings.timeLogPath || DEFAULT_TIME_LOG_PATH).trim().replace(/^\/+/, "");
    return normalizePath(raw || DEFAULT_TIME_LOG_PATH);
  }

  private async ensureDirectoryPath(filePath: string): Promise<void> {
    const parts = filePath.split("/").filter(Boolean);
    if (parts.length <= 1) return;

    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) {
        throw new Error(`Cannot create folder "${current}" because a file exists there`);
      }

      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        const retry = this.app.vault.getAbstractFileByPath(current);
        if (retry instanceof TFolder) {
          continue;
        }

        const existsOnDisk = await this.app.vault.adapter.exists(current);
        if (existsOnDisk) {
          continue;
        }

        throw error;
      }
    }
  }

  private async ensureLogFile(): Promise<TFile> {
    const filePath = this.getTimeLogPath();
    await this.ensureDirectoryPath(filePath);

    const existingFile = this.app.vault.getFileByPath(filePath);
    if (existingFile instanceof TFile) return existingFile;

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing && !(existing instanceof TFile)) {
      throw new Error(`Time log path is not a file: ${filePath}`);
    }

    if (await this.app.vault.adapter.exists(filePath)) {
      const indexedExisting = await this.waitForIndexedFile(filePath);
      if (indexedExisting) return indexedExisting;
      throw new Error(`Time log file exists but is not indexed yet: ${filePath}`);
    }

    try {
      return await this.app.vault.create(filePath, "{}\n");
    } catch (error) {
      const indexedExisting = await this.waitForIndexedFile(filePath);
      if (indexedExisting) return indexedExisting;

      if (await this.app.vault.adapter.exists(filePath)) {
        throw new Error(`Time log file exists but is not indexed yet: ${filePath}`);
      }

      throw error;
    }
  }

  private async waitForIndexedFile(filePath: string): Promise<TFile | null> {
    for (let i = 0; i < 10; i += 1) {
      const file = this.app.vault.getFileByPath(filePath);
      if (file) return file;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }

    return null;
  }

  private async readTimeLogRaw(): Promise<unknown> {
    const file = await this.ensureLogFile();

    try {
      const raw = await this.app.vault.cachedRead(file);
      return JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }

  private async writeTimeLog(data: TimeLogByNoteId): Promise<void> {
    const file = await this.ensureLogFile();
    const next = JSON.stringify(data, null, 2) + "\n";
    await this.app.vault.process(file, () => next);
  }

  private parseStartTimestamp(value: string): Date | null {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2}):(\d{2})$/.exec(value);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hours = Number(m[4]);
    const minutes = Number(m[5]);
    const date = new Date(year, month, day, hours, minutes, 0, 0);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  private parseIntervalToken(
    token: string
  ): { start: string; durationMinutes: number; startMs: number; endMs: number } | null {
    const m = /^(\d{4}\.\d{2}\.\d{2}-\d{2}:\d{2})T(?:(?:P)?T)?(\d+)M$/.exec(token.trim());
    if (!m) return null;

    const start = m[1];
    const durationMinutes = Number(m[2]);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;

    const startDate = this.parseStartTimestamp(start);
    if (!startDate) return null;

    const startMs = startDate.getTime();
    const endMs = startMs + durationMinutes * 60 * 1000;
    return { start, durationMinutes, startMs, endMs };
  }

  private formatIntervalToken(start: string, durationMinutes: number): string {
    return `${start}T${durationMinutes}M`;
  }

  private normalizeAndValidateNoteIntervals(intervals: string[]): string[] {
    const parsed = Array.from(new Set(intervals))
      .map((token) => this.parseIntervalToken(token))
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) => a.startMs - b.startMs);

    const merged: Array<{ startMs: number; endMs: number }> = [];
    for (const item of parsed) {
      const last = merged[merged.length - 1];
      if (last && item.startMs < last.endMs) {
        last.endMs = Math.max(last.endMs, item.endMs);
        continue;
      }
      merged.push({ startMs: item.startMs, endMs: item.endMs });
    }

    return merged.map((interval) => {
      const start = this.formatTimestamp(new Date(interval.startMs));
      const durationMinutes = Math.max(1, Math.round((interval.endMs - interval.startMs) / 60000));
      return this.formatIntervalToken(start, durationMinutes);
    });
  }

  private normalizeAndValidateTimeLogMap(raw: unknown): TimeLogByNoteId {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }

    const obj = raw as Record<string, unknown>;
    const output: TimeLogByNoteId = {};

    for (const [noteId, value] of Object.entries(obj)) {
      if (!noteId.trim()) continue;
      if (!Array.isArray(value)) continue;

      const intervals = value.filter((v): v is string => typeof v === "string");
      try {
        output[noteId] = this.normalizeAndValidateNoteIntervals(intervals);
      } catch {
        // Skip invalid note payloads instead of failing the entire plugin.
        output[noteId] = [];
      }
    }

    return output;
  }

  private formatTimestamp(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${yyyy}.${mm}.${dd}-${hh}:${min}`;
  }
}
