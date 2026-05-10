import { CronExpressionParser } from "cron-parser";

export interface TaskLastRunInfo {
  name: string;
  cron: string;
  silent?: boolean;
  /** Unix ms timestamp of the last successful run, or undefined if never. */
  lastRun: number | undefined;
}

export interface MissedRun {
  taskName: string;
  /** ISO string of when the task should have fired most recently. */
  scheduledFireTime: string;
  /** ISO string of the last successful run, or undefined if never. */
  lastRun: string | undefined;
  silent: boolean;
  /** How long ago (minutes) the scheduled fire was. */
  ageMinutes: number;
}

/**
 * For each task, detect whether it was supposed to fire within the
 * catch-up window but didn't. Pure function — takes current time and
 * window size explicitly so it's testable without a daemon running.
 *
 * "Should have fired" is computed via cron-parser's `prev()` — the most
 * recent scheduled time at or before `now`. A task is considered missed
 * when:
 *   1. prev(cron) is inside the window (now - windowHours, now]
 *   2. lastRun is undefined OR lastRun < prev(cron)
 *
 * Invalid cron expressions are skipped (never flagged as missed).
 */
export function detectMissedRuns(
  tasks: TaskLastRunInfo[],
  now: Date,
  windowHours: number,
): MissedRun[] {
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const missed: MissedRun[] = [];

  for (const task of tasks) {
    let prevFire: Date;
    try {
      const interval = CronExpressionParser.parse(task.cron, { currentDate: now });
      prevFire = interval.prev().toDate();
    } catch {
      continue; // invalid cron — skip
    }

    if (prevFire < windowStart) continue; // too long ago
    if (task.lastRun !== undefined && task.lastRun >= prevFire.getTime()) continue; // already ran

    const ageMs = now.getTime() - prevFire.getTime();
    missed.push({
      taskName: task.name,
      scheduledFireTime: prevFire.toISOString(),
      lastRun: task.lastRun !== undefined ? new Date(task.lastRun).toISOString() : undefined,
      silent: task.silent ?? false,
      ageMinutes: Math.round(ageMs / 60_000),
    });
  }

  return missed;
}

/**
 * Format the missed-runs list as a single Telegram-friendly message.
 * Empty input → empty string (so the caller can skip sending nothing).
 *
 * Important: this fires only on daemon startup (or hot-reload). A task is
 * "missed" if its prev() expected fire is in the catch-up window AND lastRun
 * is older than that fire. If the daemon JUST restarted while a task was
 * mid-execution, lastRun won't be updated yet — so callers should only fire
 * this check when they're confident the daemon is in a steady state.
 */
export function formatMissedAlert(missed: MissedRun[]): string {
  if (missed.length === 0) return "";

  const userFacing = missed.filter((m) => !m.silent);
  const silent = missed.filter((m) => m.silent);

  const lines: string[] = [];
  const count = missed.length;
  lines.push(
    `⚠️ MaxOS was down — ${count} scheduled ${count === 1 ? "task was" : "tasks were"} missed while I was offline:`,
  );
  for (const m of userFacing) {
    const hhmm = m.scheduledFireTime.slice(11, 16);
    const date = m.scheduledFireTime.slice(0, 10);
    lines.push(`  • ${m.taskName} (scheduled ${date} ${hhmm}, ${m.ageMinutes}m ago)`);
  }
  if (silent.length > 0) {
    lines.push(`  (plus ${silent.length} silent maintenance ${silent.length === 1 ? "task" : "tasks"})`);
  }
  lines.push("");
  lines.push("Run any missed task manually: `maxos run-task <name>` — it'll get the full deterministic kit.");
  return lines.join("\n");
}

/**
 * Filter out tasks whose prev() fire was within `recentFireGraceMs` of `now`.
 * The original detection treats any task without an updated lastRun as
 * missed, but that produces false positives during daemon restarts mid-fire.
 * Calling this filter after `detectMissedRuns` and before alert generation
 * removes flag-mid-flight cases that would otherwise spam the user.
 */
export function filterRecentFireFalsePositives(
  missed: MissedRun[],
  now: Date,
  recentFireGraceMs: number = 5 * 60_000,
): MissedRun[] {
  return missed.filter((m) => {
    const fireMs = new Date(m.scheduledFireTime).getTime();
    return now.getTime() - fireMs > recentFireGraceMs;
  });
}
