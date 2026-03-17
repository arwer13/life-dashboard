import { Notice, TFile, TFolder, normalizePath, type App } from "obsidian";
import type { TimeLogByNoteId, TimeLogEntry, TimeLogSnapshot } from "../models/types";
import {
  CURRENT_TIME_LOG_SCHEMA_VERSION,
  DEFAULT_TIME_LOG_PATH,
  type LifeDashboardSettings
} from "../settings";
import { pad2 } from "./year-grid-utils";

export interface ParsedIntervalToken {
  start: string;
  durationMinutes: number;
  startMs: number;
  endMs: number;
}

const TIMESTAMP_RE = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2}):(\d{2})$/;

function formatUTC(date: Date): string {
  return `${date.getUTCFullYear()}.${pad2(date.getUTCMonth() + 1)}.${pad2(date.getUTCDate())}-${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function parseStartTimestamp(value: string): Date | null {
  const m = TIMESTAMP_RE.exec(value);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function formatTimestampLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}-${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function localTimestampToUTC(value: string): string | null {
  const m = TIMESTAMP_RE.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return formatUTC(date);
}

export function parseIntervalToken(token: string): ParsedIntervalToken | null {
  const m = /^(\d{4}\.\d{2}\.\d{2}-\d{2}:\d{2})T(?:(?:P)?T)?(\d+)M$/.exec(token.trim());
  if (!m) return null;

  const start = m[1];
  const durationMinutes = Number(m[2]);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;

  const startDate = parseStartTimestamp(start);
  if (!startDate) return null;

  const startMs = startDate.getTime();
  const endMs = startMs + durationMinutes * 60 * 1000;
  return { start, durationMinutes, startMs, endMs };
}

export class TimeLogStore {
  private readonly app: App;
  private readonly settings: LifeDashboardSettings;
  private readonly saveSettings: () => Promise<void>;
  private corruptedFileDetected = false;

  constructor(app: App, settings: LifeDashboardSettings, saveSettings: () => Promise<void>) {
    this.app = app;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  async appendTimeEntry(noteId: string, startMs: number, endMs: number): Promise<void> {
    const token = this.formatIntervalTokenFromMs(startMs, endMs);
    await this.mutateNoteIntervals(noteId, (intervals) => [...intervals, token]);
  }

  async updateTimeEntry(noteId: string, startMs: number, oldEndMs: number, newEndMs: number): Promise<void> {
    const oldToken = this.formatIntervalTokenFromMs(startMs, oldEndMs);
    const newToken = this.formatIntervalTokenFromMs(startMs, newEndMs);
    await this.mutateNoteIntervals(noteId, (intervals) => {
      const idx = intervals.indexOf(oldToken);
      if (idx === -1) throw new Error("Cannot update time entry: original entry not found.");
      const updated = [...intervals];
      updated[idx] = newToken;
      return updated;
    });
  }

  private async mutateNoteIntervals(noteId: string, mutate: (intervals: string[]) => string[]): Promise<void> {
    const normalizedNoteId = this.normalizeNoteId(noteId);
    if (!normalizedNoteId) {
      throw new Error("Cannot modify time entry: note id is empty.");
    }

    const data = await this.readTimeLogMap();
    const current = data[normalizedNoteId] ?? [];
    data[normalizedNoteId] = this.normalizeAndValidateNoteIntervals(mutate(current));
    await this.writeTimeLog(data);
  }

  async readTimeLogMap(): Promise<TimeLogByNoteId> {
    await this.migrateIfNeeded();
    const raw = await this.readTimeLogRaw();
    return this.normalizeAndValidateTimeLogMap(raw);
  }

  async writeTimeLogMap(data: TimeLogByNoteId): Promise<void> {
    const normalized = this.normalizeAndValidateTimeLogMap(data);
    await this.writeTimeLog(normalized);
  }

  async loadSnapshot(): Promise<TimeLogSnapshot> {
    const data = await this.readTimeLogMap();
    const totals = new Map<string, number>();
    const entriesByNoteId = new Map<string, TimeLogEntry[]>();

    for (const [noteId, intervals] of Object.entries(data)) {
      const parsedEntries: TimeLogEntry[] = [];
      let seconds = 0;

      for (const token of intervals) {
        const parsed = parseIntervalToken(token);
        if (!parsed) continue;
        seconds += parsed.durationMinutes * 60;
        parsedEntries.push({ startMs: parsed.startMs, durationMinutes: parsed.durationMinutes });
      }

      if (seconds > 0) {
        totals.set(noteId, seconds);
      }
      if (parsedEntries.length > 0) {
        entriesByNoteId.set(noteId, parsedEntries);
      }
    }

    return { totals, entriesByNoteId };
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
    const raw = await this.app.vault.cachedRead(file);
    const trimmed = raw.trim();

    if (!trimmed) {
      this.corruptedFileDetected = false;
      return {};
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      this.corruptedFileDetected = false;
      return parsed;
    } catch {
      if (!this.corruptedFileDetected) {
        await this.backupCorruptedFile(file, raw);
      }
      this.corruptedFileDetected = true;
      return {};
    }
  }

  private async backupCorruptedFile(file: TFile, content: string): Promise<void> {
    const backupPath = file.path.replace(/\.json$/, "") + `.backup-${Date.now()}.json`;
    try {
      await this.ensureDirectoryPath(backupPath);
      await this.app.vault.create(backupPath, content);
      new Notice(
        `Time log file contains invalid JSON. A backup was saved to ${backupPath}. ` +
        `Please fix or delete the time log file to resume tracking.`,
        0
      );
    } catch {
      new Notice(
        `Time log file contains invalid JSON and backup creation failed. ` +
        `Please check ${file.path} manually.`,
        0
      );
    }
  }

  private async writeTimeLog(data: TimeLogByNoteId): Promise<void> {
    if (this.corruptedFileDetected) {
      new Notice(
        "Cannot save time log: the file contains invalid JSON. " +
        "Please fix or delete the time log file first.",
        8000
      );
      return;
    }
    const file = await this.ensureLogFile();
    const next = JSON.stringify(data, null, 2) + "\n";
    await this.app.vault.process(file, () => next);
  }

  private formatIntervalToken(start: string, durationMinutes: number): string {
    return `${start}T${durationMinutes}M`;
  }

  private normalizeAndValidateNoteIntervals(intervals: string[]): string[] {
    const parsed = Array.from(new Set(intervals))
      .map((token) => parseIntervalToken(token))
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
      return this.formatIntervalTokenFromMs(interval.startMs, interval.endMs);
    });
  }

  private normalizeAndValidateTimeLogMap(raw: unknown): TimeLogByNoteId {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }

    const obj = raw as Record<string, unknown>;
    const mergedIntervalsByNoteId = new Map<string, string[]>();

    for (const [rawNoteId, value] of Object.entries(obj)) {
      const noteId = this.normalizeNoteId(rawNoteId);
      if (!noteId || !Array.isArray(value)) continue;

      const intervals = value.filter((v): v is string => typeof v === "string");
      const existing = mergedIntervalsByNoteId.get(noteId);
      if (existing) {
        existing.push(...intervals);
      } else {
        mergedIntervalsByNoteId.set(noteId, [...intervals]);
      }
    }

    const output: TimeLogByNoteId = {};
    for (const [noteId, intervals] of mergedIntervalsByNoteId.entries()) {
      let normalizedIntervals: string[];
      try {
        normalizedIntervals = this.normalizeAndValidateNoteIntervals(intervals);
      } catch {
        // Skip invalid note payloads instead of failing the entire plugin.
        normalizedIntervals = [];
      }

      if (normalizedIntervals.length > 0) {
        output[noteId] = normalizedIntervals;
      }
    }

    return output;
  }

  private normalizeNoteId(noteId: string): string {
    return noteId.trim();
  }

  private formatIntervalTokenFromMs(startMs: number, endMs: number): string {
    const start = formatUTC(new Date(startMs));
    const durationMinutes = this.durationMinutesFromMs(startMs, endMs);
    return this.formatIntervalToken(start, durationMinutes);
  }

  private durationMinutesFromMs(startMs: number, endMs: number): number {
    return Math.max(1, Math.floor((endMs - startMs) / 60000));
  }
}
