import type { TimeLogEntry } from "../models/types";
import { pad2 } from "./year-grid-utils";

export type OutlineTimeRange = "today" | "todayYesterday" | "week" | "previousWeek" | "month" | "all";
export type PeriodTooltipRange = OutlineTimeRange | "yesterday";
export type TimeWindow = { startMs: number; endMs: number };
type WeekStartsOn = "monday" | "sunday";

export class TimeWindowService {
  private readonly getWeekStartsOn: () => WeekStartsOn;

  constructor(getWeekStartsOn: () => WeekStartsOn) {
    this.getWeekStartsOn = getWeekStartsOn;
  }

  getWindowForRange(range: Exclude<OutlineTimeRange, "all">, now: Date): TimeWindow {
    if (range === "today") {
      return this.buildWindowFromStart(this.getDayStart(now), 1);
    }

    if (range === "todayYesterday") {
      const todayStart = this.getDayStart(now);
      const start = new Date(todayStart.getTime());
      start.setDate(start.getDate() - 1);
      return this.buildWindowFromStart(start, 2);
    }

    if (range === "week") {
      return this.buildWeekWindow(now, 0);
    }

    if (range === "previousWeek") {
      return this.buildWeekWindow(now, -1);
    }

    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  getWindowForPeriod(range: PeriodTooltipRange, now: Date): TimeWindow | null {
    if (range === "all") {
      return null;
    }

    if (range === "yesterday") {
      const todayWindow = this.getWindowForRange("today", now);
      const yesterdayStart = new Date(todayWindow.startMs);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      return {
        startMs: yesterdayStart.getTime(),
        endMs: todayWindow.startMs
      };
    }

    return this.getWindowForRange(range, now);
  }

  getTimeRangeDescription(range: PeriodTooltipRange, now: Date): string {
    const window = this.getWindowForPeriod(range, now);
    if (!window) return "All tracked entries (no date filter).";
    return this.formatRangeLabel(new Date(window.startMs), new Date(window.endMs));
  }

  getWeekStart(now: Date): Date {
    const start = this.getDayStart(now);
    const day = start.getDay();
    const weekStartsOn = this.getWeekStartsOn() === "sunday" ? 0 : 1;
    const offset = (day - weekStartsOn + 7) % 7;
    start.setDate(start.getDate() - offset);
    return start;
  }

  getDayStart(value: Date): Date {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
  }

  formatClockDuration(totalSeconds: number): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    if (hours > 0) {
      return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
    }
    return `${minutes}:${pad2(seconds)}`;
  }

  formatShortDuration(totalSeconds: number): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);

    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  getEntryOverlapSeconds(entry: TimeLogEntry, window: TimeWindow): number {
    const { startMs, endMs } = this.getEntryBounds(entry);
    const overlapStart = Math.max(startMs, window.startMs);
    const overlapEnd = Math.min(endMs, window.endMs);
    if (overlapEnd <= overlapStart) return 0;
    return Math.floor((overlapEnd - overlapStart) / 1000);
  }

  getEntryOverlapStartMs(entry: TimeLogEntry, window: TimeWindow): number | null {
    const { startMs, endMs } = this.getEntryBounds(entry);
    const overlapStart = Math.max(startMs, window.startMs);
    const overlapEnd = Math.min(endMs, window.endMs);
    if (overlapEnd <= overlapStart) return null;
    return overlapStart;
  }

  private getEntryBounds(entry: TimeLogEntry): { startMs: number; endMs: number } {
    return {
      startMs: entry.startMs,
      endMs: entry.startMs + entry.durationMinutes * 60 * 1000
    };
  }

  private buildWeekWindow(now: Date, weekOffset: number): TimeWindow {
    const start = this.getWeekStart(now);
    if (weekOffset !== 0) {
      start.setDate(start.getDate() + weekOffset * 7);
    }
    return this.buildWindowFromStart(start, 7);
  }

  private buildWindowFromStart(start: Date, daySpan: number): TimeWindow {
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + daySpan);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  private formatRangeLabel(start: Date, endExclusive: Date): string {
    const end = new Date(endExclusive.getTime() - 60 * 1000);
    return `${this.formatDateTime(start)} - ${this.formatDateTime(end)}`;
  }

  private formatDateTime(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = pad2(date.getMonth() + 1);
    const dd = pad2(date.getDate());
    const hh = pad2(date.getHours());
    const min = pad2(date.getMinutes());
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
}
