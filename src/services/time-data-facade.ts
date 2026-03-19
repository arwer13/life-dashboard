import { TFile, type App } from "obsidian";
import type { TaskItem, TimeLogEntry } from "../models/types";
import { TimeWindowService, type TimeWindow, type OutlineTimeRange, type PeriodTooltipRange } from "./time-window-service";
import { pad2 } from "./year-grid-utils";

export class TimeDataFacade {
  private readonly app: App;
  private readonly timeWindowService: TimeWindowService;

  timeTotalsById: Map<string, number> = new Map();
  timeEntriesById: Map<string, TimeLogEntry[]> = new Map();

  constructor(app: App, timeWindowService: TimeWindowService) {
    this.app = app;
    this.timeWindowService = timeWindowService;
  }

  clear(): void {
    this.timeTotalsById = new Map();
    this.timeEntriesById = new Map();
  }

  getEntriesForPath(path: string): TimeLogEntry[] {
    const noteId = this.getNoteIdForPath(path);
    if (!noteId) return [];
    return this.timeEntriesById.get(noteId) ?? [];
  }

  getTrackedSeconds(path: string): number {
    const noteId = this.getNoteIdForPath(path);
    if (!noteId) return 0;
    return this.timeTotalsById.get(noteId) ?? 0;
  }

  getTrackedSecondsForRange(path: string, range: OutlineTimeRange): number {
    if (range === "all") {
      return this.getTrackedSeconds(path);
    }

    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) return 0;

    const window = this.timeWindowService.getWindowForRange(range, new Date());
    return this.sumSecondsInWindow(entries, window);
  }

  getTrackedSecondsForWindow(path: string, window: TimeWindow): number {
    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) return 0;
    return this.sumSecondsInWindow(entries, window);
  }

  getLatestTrackedStartMsForRange(path: string, range: OutlineTimeRange): number {
    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) return 0;

    if (range === "all") {
      return entries.reduce((latest, entry) => Math.max(latest, entry.startMs), 0);
    }

    const window = this.timeWindowService.getWindowForRange(range, new Date());
    return this.getLatestOverlapStartMs(entries, window);
  }

  getLatestTrackedStartMsForWindow(path: string, window: TimeWindow): number {
    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) return 0;
    return this.getLatestOverlapStartMs(entries, window);
  }

  getConcernPeriodSummary(path: string): {
    todayEntries: Array<{ label: string; startMs: number }>;
    todaySeconds: number;
    yesterdaySeconds: number;
    weekSeconds: number;
  } {
    const entries = this.getEntriesForPath(path);
    if (entries.length === 0) {
      return {
        todayEntries: [],
        todaySeconds: 0,
        yesterdaySeconds: 0,
        weekSeconds: 0
      };
    }

    const now = new Date();
    const todayWindow = this.timeWindowService.getWindowForRange("today", now);
    const yesterdayWindow = {
      startMs: todayWindow.startMs - 24 * 60 * 60 * 1000,
      endMs: todayWindow.startMs
    };
    const weekWindow = this.timeWindowService.getWindowForRange("week", now);

    const todayEntries = entries
      .map((entry) => {
        const overlapSeconds = this.timeWindowService.getEntryOverlapSeconds(entry, todayWindow);
        const overlapStartMs = this.timeWindowService.getEntryOverlapStartMs(entry, todayWindow);
        return { entry, overlapSeconds, overlapStartMs };
      })
      .filter(
        (item): item is { entry: TimeLogEntry; overlapSeconds: number; overlapStartMs: number } =>
          item.overlapSeconds > 0 && item.overlapStartMs != null
      )
      .sort((a, b) => a.overlapStartMs - b.overlapStartMs)
      .map(({ entry, overlapSeconds, overlapStartMs }) => {
        const start = new Date(overlapStartMs);
        const hhmm = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
        const label = `${hhmm} ${this.formatShortDuration(overlapSeconds)}`;
        return { label, startMs: entry.startMs };
      });
    const todaySeconds = this.sumSecondsInWindow(entries, todayWindow);
    const yesterdaySeconds = this.sumSecondsInWindow(entries, yesterdayWindow);
    const weekSeconds = this.sumSecondsInWindow(entries, weekWindow);

    return { todayEntries, todaySeconds, yesterdaySeconds, weekSeconds };
  }

  getLatestTrackedEndMs(): number {
    let latestEndMs = 0;
    for (const entries of this.timeEntriesById.values()) {
      for (const entry of entries) {
        const endMs = entry.startMs + entry.durationMinutes * 60_000;
        if (endMs > latestEndMs) {
          latestEndMs = endMs;
        }
      }
    }
    return latestEndMs;
  }

  // --- TimeWindowService pass-throughs ---

  getWindowForRange(range: Exclude<OutlineTimeRange, "all">, now: Date): TimeWindow {
    return this.timeWindowService.getWindowForRange(range, now);
  }

  getWeekStart(now: Date): Date {
    return this.timeWindowService.getWeekStart(now);
  }

  getDayStart(value: Date): Date {
    return this.timeWindowService.getDayStart(value);
  }

  formatClockDuration(totalSeconds: number): string {
    return this.timeWindowService.formatClockDuration(totalSeconds);
  }

  formatShortDuration(totalSeconds: number): string {
    return this.timeWindowService.formatShortDuration(totalSeconds);
  }

  getTimeRangeDescription(range: PeriodTooltipRange): string {
    return this.timeWindowService.getTimeRangeDescription(range, new Date());
  }

  getOwnSecondsByPath(
    tasks: ReadonlyArray<TaskItem>,
    range: OutlineTimeRange,
    customWindow?: TimeWindow
  ): Map<string, number> {
    const window = customWindow
      ?? (range !== "all" ? this.timeWindowService.getWindowForRange(range, new Date()) : undefined);
    const map = new Map<string, number>();
    for (const task of tasks) {
      if (task.kind === "inline") {
        map.set(task.path, 0);
        continue;
      }
      const seconds = window
        ? this.sumSecondsInWindow(this.getEntriesForPath(task.path), window)
        : this.getTrackedSeconds(task.path);
      map.set(task.path, seconds);
    }
    return map;
  }

  // --- Internal helpers ---

  private getNoteIdForPath(path: string): string | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter || cache.frontmatter.id == null) return null;
    const id = String(cache.frontmatter.id).trim();
    return id || null;
  }

  sumSecondsInWindow(entries: TimeLogEntry[], window: TimeWindow): number {
    return entries.reduce((seconds, entry) => {
      return seconds + this.timeWindowService.getEntryOverlapSeconds(entry, window);
    }, 0);
  }

  private getLatestOverlapStartMs(entries: TimeLogEntry[], window: TimeWindow): number {
    let latest = 0;
    for (const entry of entries) {
      const overlapStartMs = this.timeWindowService.getEntryOverlapStartMs(entry, window);
      if (overlapStartMs != null && overlapStartMs > latest) {
        latest = overlapStartMs;
      }
    }
    return latest;
  }
}
