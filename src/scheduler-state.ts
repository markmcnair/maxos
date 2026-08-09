import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading "when did each scheduled job last run?" — shared by doctor.ts and
 * health-summary.ts so both surfaces agree, and so neither has to import the
 * other's heavier dependencies.
 *
 * Two sources exist, because the scheduler was replaced during the Hermes
 * migration and the health surfaces were never repointed:
 *   - legacy `$MAXOS_HOME/state.json` → `scheduler.lastRun` (epoch ms). Under
 *     Hermes this file does not exist at all, so every consumer silently saw
 *     an empty map and reported health by omission.
 *   - live `$MAXOS_HOME/cron/maxos-cron-state.json` → `{ job: "YYYY-MM-DDTHH:MM" }`
 *     local-time strings, written by `~/.hermes/bin/maxos-cron.py`.
 *
 * Both are merged, and per job the NEWER timestamp wins: a frozen legacy value
 * must never mask a live one.
 */
export function readSchedulerLastRun(maxosHome: string): Record<string, number> {
  const merged: Record<string, number> = {};

  const record = (job: string, ts: number) => {
    if (!Number.isFinite(ts)) return;
    if (merged[job] === undefined || ts > merged[job]) merged[job] = ts;
  };

  const legacy = join(maxosHome, "state.json");
  if (existsSync(legacy)) {
    try {
      const raw = JSON.parse(readFileSync(legacy, "utf-8"));
      const lastRun = raw?.scheduler?.lastRun;
      if (lastRun && typeof lastRun === "object" && !Array.isArray(lastRun)) {
        for (const [job, ts] of Object.entries(lastRun)) {
          if (typeof ts === "number") record(job, ts);
        }
      }
    } catch {
      // A corrupt legacy file must not blind us to the live ticker.
    }
  }

  const ticker = join(maxosHome, "cron", "maxos-cron-state.json");
  if (existsSync(ticker)) {
    try {
      const raw = JSON.parse(readFileSync(ticker, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [job, stamp] of Object.entries(raw)) {
          if (typeof stamp !== "string") continue;
          // A bare "YYYY-MM-DDTHH:MM" parses as LOCAL time, which is what the
          // ticker writes. Anything unparseable is skipped, not thrown.
          const t = new Date(stamp).getTime();
          if (!Number.isNaN(t)) record(job, t);
        }
      }
    } catch {
      // Unreadable ticker file → callers see "no scheduler state" instead of
      // a crash.
    }
  }

  return merged;
}
