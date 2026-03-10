export type TimerNotificationRule = {
  thresholdSeconds: number;
  label: string;
  message: string;
};

type NotificationSession = {
  activeStartMs: number | null;
  activeTaskId: string;
  elapsedSeconds: number;
  rawRules: string;
};

type NotificationHooks = {
  notify: (message: string) => Promise<void> | void;
  beep: () => void;
};

export class TimerNotificationService {
  private activeSessionKey = "";
  private lastElapsedSeconds: number | null = null;
  private notifiedThresholdSeconds = new Set<number>();
  private parsedRulesCacheRaw = "";
  private parsedRulesCache: TimerNotificationRule[] = [];

  handleTick(session: NotificationSession, hooks: NotificationHooks): void {
    if (session.activeStartMs == null) {
      this.reset();
      return;
    }

    const sessionKey = `${session.activeStartMs}:${session.activeTaskId}`;
    const elapsed = session.elapsedSeconds;

    if (sessionKey !== this.activeSessionKey) {
      this.activeSessionKey = sessionKey;
      this.lastElapsedSeconds = elapsed;
      this.notifiedThresholdSeconds.clear();
      return;
    }

    const previous = this.lastElapsedSeconds ?? elapsed;
    if (elapsed < previous) {
      this.lastElapsedSeconds = elapsed;
      this.notifiedThresholdSeconds.clear();
      return;
    }

    const rules = this.getRules(session.rawRules);
    for (const rule of rules) {
      if (this.notifiedThresholdSeconds.has(rule.thresholdSeconds)) continue;
      if (previous < rule.thresholdSeconds && elapsed >= rule.thresholdSeconds) {
        this.notifiedThresholdSeconds.add(rule.thresholdSeconds);
        void hooks.notify(rule.message || `Timer reached ${rule.label}`);
        hooks.beep();
      }
    }

    this.lastElapsedSeconds = elapsed;
  }

  private reset(): void {
    this.activeSessionKey = "";
    this.lastElapsedSeconds = null;
    this.notifiedThresholdSeconds.clear();
  }

  private getRules(raw: string): TimerNotificationRule[] {
    if (raw === this.parsedRulesCacheRaw) {
      return this.parsedRulesCache;
    }

    const parsed = this.parseRules(raw);
    this.parsedRulesCacheRaw = raw;
    this.parsedRulesCache = parsed;
    return parsed;
  }

  private parseRules(raw: string): TimerNotificationRule[] {
    const byThreshold = new Map<number, TimerNotificationRule>();
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = /^(\d+\s*[smhSMH])(?:\s+(?:"([^"]+)"|(.*)))?$/.exec(trimmed);
      if (!match) {
        console.error("[life-dashboard] Invalid timer notification rule:", trimmed);
        continue;
      }

      const thresholdSeconds = this.parseDurationToSeconds(match[1]);
      if (thresholdSeconds <= 0) continue;

      const rawMessage = (match[2] ?? match[3] ?? "").trim();
      const label = match[1].replace(/\s+/g, "").toLowerCase();
      byThreshold.set(thresholdSeconds, {
        thresholdSeconds,
        label,
        message: rawMessage || `Timer reached ${label}`
      });
    }

    return Array.from(byThreshold.values()).sort((a, b) => a.thresholdSeconds - b.thresholdSeconds);
  }

  private parseDurationToSeconds(raw: string): number {
    const match = /^(\d+)\s*([smhSMH])$/.exec(raw.trim());
    if (!match) return 0;

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 0;

    const unit = match[2].toLowerCase();
    if (unit === "h") return value * 3600;
    if (unit === "m") return value * 60;
    return value;
  }
}
