import type { TimeLogEntry } from "../models/types";

export type OutlineTimeRange = "today" | "todayYesterday" | "week" | "month" | "all";
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
      const start = this.getDayStart(now);
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 1);
      return { startMs: start.getTime(), endMs: end.getTime() };
    }

    if (range === "todayYesterday") {
      const todayStart = this.getDayStart(now);
      const start = new Date(todayStart.getTime());
      start.setDate(start.getDate() - 1);
      const end = new Date(todayStart.getTime());
      end.setDate(end.getDate() + 1);
      return { startMs: start.getTime(), endMs: end.getTime() };
    }

    if (range === "week") {
      const start = this.getWeekStart(now);
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 7);
      return { startMs: start.getTime(), endMs: end.getTime() };
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

    const pad = (n: number): string => String(n).padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${minutes}:${pad(seconds)}`;
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

  private formatRangeLabel(start: Date, endExclusive: Date): string {
    const end = new Date(endExclusive.getTime() - 60 * 1000);
    return `${this.formatDateTime(start)} - ${this.formatDateTime(end)}`;
  }

  private formatDateTime(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
}
