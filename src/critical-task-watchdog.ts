import { CronExpressionParser } from "cron-parser";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { request } from "node:http";

export interface CriticalTaskSpec {
  /** Substring matched against state.lastRun keys to find the task's run record. */
  pattern: string;
  /** Friendly label rendered in the alert. */
  label: string;
  /** Cron expression — the watchdog uses prev() to find the most recent expected fire. */
  cron: string;
  /** Minutes of grace after the scheduled fire before we cry "missed". */
  graceMin: number;
}

/**
 * The user-facing scheduled tasks Mark expects every day. If one of these
 * silently misses, /status will eventually surface it but the watchdog
 * notifies him immediately.
 */
export const CRITICAL_TASKS: CriticalTaskSpec[] = [
  { pattern: "morning-brief", label: "morning brief", cron: "0 6 * * 0-5", graceMin: 60 },
  { pattern: "morning-brew", label: "morning brew", cron: "15 6 * * 0-5", graceMin: 60 },
  { pattern: "shutdown-debrief", label: "shutdown debrief", cron: "35 16 * * 0-5", graceMin: 60 },
  { pattern: "prime-scout", label: "prime scout", cron: "0 22 * * 0-4,6", graceMin: 120 },
];

interface SchedulerStateShape {
  scheduler?: { lastRun?: Record<string, number> };
  // Older schemas might put lastRun at top level — tolerate both.
  lastRun?: Record<string, number>;
}

function getLastRun(state: SchedulerStateShape): Record<string, number> {
  return state.scheduler?.lastRun ?? state.lastRun ?? {};
}

/**
 * Find the most-recent lastRun timestamp for any task slug that contains
 * `pattern`. Returns 0 when nothing matches.
 */
export function findMostRecentRunMatching(
  lastRun: Record<string, number>,
  pattern: string,
): number {
  let max = 0;
  const lower = pattern.toLowerCase();
  for (const [key, ts] of Object.entries(lastRun)) {
    if (typeof ts !== "number") continue;
    if (!key.toLowerCase().includes(lower)) continue;
    if (ts > max) max = ts;
  }
  return max;
}

function fmtCT(ms: number): string {
  if (ms === 0) return "never";
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) + " CT";
}

export interface WatchdogAlert {
  /** Task pattern from CRITICAL_TASKS (e.g., "morning-brief"). Used for dedup. */
  taskPattern: string;
  /** Human-readable alert message for Telegram delivery. */
  text: string;
  /** ISO date the expected fire was scheduled for (used as part of dedup key). */
  expectedFireDateKey: string;
}

function dateKeyCT(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD
}

/**
 * Pure check: given persisted scheduler state, return structured alerts —
 * one per critical task that's overdue. Each alert carries its `taskPattern`
 * so the CLI can dedup against an already-alerted log. Empty list = all clear.
 */
export function checkAllCriticalTasks(
  state: SchedulerStateShape,
  now: Date = new Date(),
  specs: CriticalTaskSpec[] = CRITICAL_TASKS,
): WatchdogAlert[] {
  const lastRun = getLastRun(state);
  const alerts: WatchdogAlert[] = [];

  for (const spec of specs) {
    let expectedFire: Date;
    try {
      const it = CronExpressionParser.parse(spec.cron, { currentDate: now });
      expectedFire = it.prev().toDate();
    } catch {
      continue;
    }

    // Skip if the task's last expected fire was more than 24h ago — it isn't
    // "due" today (e.g., shutdown-debrief on Saturday with 0-5 cron).
    if (now.getTime() - expectedFire.getTime() > 24 * 60 * 60 * 1000) continue;

    // Skip if the next expected fire is still in the future — `prev()` returned
    // the previous day's fire because today's hasn't happened yet.
    if (expectedFire > now) continue;

    const mostRecent = findMostRecentRunMatching(lastRun, spec.pattern);
    const threshold = expectedFire.getTime() - spec.graceMin * 60_000;
    if (mostRecent >= threshold) continue; // fired within grace window

    const ageMin = Math.round((now.getTime() - expectedFire.getTime()) / 60_000);
    const expectedFireDateKey = dateKeyCT(expectedFire);
    alerts.push({
      taskPattern: spec.pattern,
      expectedFireDateKey,
      text:
        `🚨 ${spec.label} missed its ${expectedFireDateKey} scheduled fire (${ageMin} min late). ` +
        `Last successful run: ${fmtCT(mostRecent)}. ` +
        `Type /status to see current scheduler state.`,
    });
  }

  return alerts;
}

interface SentAlertRecord {
  ts: number;
  taskPattern: string;
  expectedFireDateKey: string;
}

/**
 * Read the alert-history JSONL and return a Set of `${taskPattern}|${dateKey}`
 * keys we've already alerted on. Watchdog uses this to suppress duplicate
 * alerts within the same expected-fire-date — one alert per task per day max.
 */
export function loadSentAlertKeys(path: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SentAlertRecord;
        if (r.taskPattern && r.expectedFireDateKey) {
          out.add(`${r.taskPattern}|${r.expectedFireDateKey}`);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // tolerate read errors — worst case we send a duplicate alert
  }
  return out;
}

/**
 * Append a sent-alert record. Best-effort. Never throws.
 */
export function recordAlertSent(
  path: string,
  taskPattern: string,
  expectedFireDateKey: string,
  now: number = Date.now(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      JSON.stringify({ ts: now, taskPattern, expectedFireDateKey } satisfies SentAlertRecord) + "\n",
    );
  } catch {
    // ignore
  }
}

/**
 * Pure dedup: from a list of alerts, return only those NOT in `alreadySent`.
 */
export function dedupAlerts(
  alerts: WatchdogAlert[],
  alreadySent: Set<string>,
): WatchdogAlert[] {
  return alerts.filter((a) => !alreadySent.has(`${a.taskPattern}|${a.expectedFireDateKey}`));
}

function postAlertToDaemon(
  alert: string,
  port: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ taskName: "critical-task-watchdog", result: alert });
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/deliver-task",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

/**
 * CLI entry — load state.json, run checks, dedup against alert history,
 * deliver each fresh alert to the daemon via /api/deliver-task. Silent
 * (exit 0, no stdout) when nothing new to alert.
 *
 * Dedup pattern: one alert per (taskPattern, expectedFireDateKey) pair
 * MAX. So if morning-brief misses Wed's 6:00 fire, you get exactly ONE
 * alert ever — not 24/day stacked from the hourly cron.
 */
async function runFromCLI(): Promise<void> {
  const maxosHome = process.env.MAXOS_HOME || `${process.env.HOME}/.maxos`;
  const statePath = join(maxosHome, "state.json");
  if (!existsSync(statePath)) {
    return;
  }
  let state: SchedulerStateShape;
  try {
    state = JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return;
  }

  const allAlerts = checkAllCriticalTasks(state);
  if (allAlerts.length === 0) return;

  const alertLogPath = join(maxosHome, "workspace", "memory", "watchdog-alerts.jsonl");
  const alreadySent = loadSentAlertKeys(alertLogPath);
  const fresh = dedupAlerts(allAlerts, alreadySent);

  if (fresh.length === 0) {
    // Suppressed everything — silent exit (no stdout, no Telegram noise).
    return;
  }

  const port = 18790;
  for (const alert of fresh) {
    await postAlertToDaemon(alert.text, port);
    recordAlertSent(alertLogPath, alert.taskPattern, alert.expectedFireDateKey);
  }

  console.log(
    `watchdog: ${fresh.length} fresh alert${fresh.length === 1 ? "" : "s"} sent ` +
    `(${allAlerts.length - fresh.length} suppressed via dedup)`,
  );
}

const isCLI = process.argv[1]?.endsWith("critical-task-watchdog.js");
if (isCLI) {
  runFromCLI().catch((err) => {
    console.error("critical-task-watchdog:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
