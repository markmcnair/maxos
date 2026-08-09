import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSchedulerLastRun, checkRecentTaskActivity } from "../src/doctor.js";
import { buildHealthSummaryParts } from "../src/health-summary.js";

/**
 * Regression suite for the 2026-08-09 dead-safety-net defect.
 *
 * doctor.checkRecentTaskActivity and health-summary both read
 * `$MAXOS_HOME/state.json` → `scheduler.lastRun`. Under Hermes that file does
 * not exist: the live ticker records job runs in
 * `$MAXOS_HOME/cron/maxos-cron-state.json` as `{ "<job>": "YYYY-MM-DDTHH:MM" }`
 * local-time strings. So the "NO scheduled tasks have fired in the last 6
 * hours — scheduler may be hung" alarm could never fire, and health-summary's
 * failing-task list was permanently empty — silence reading as health.
 */

let home: string;

/** Write the Hermes ticker's state file. */
function writeCronState(entries: Record<string, string>) {
  const dir = join(home, "cron");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "maxos-cron-state.json"), JSON.stringify(entries, null, 2));
}

/** Format a Date the way the Hermes ticker does: local time, minute precision. */
function tickerStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sched-fresh-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("readSchedulerLastRun", () => {
  it("reads the Hermes ticker state file when state.json is absent", () => {
    const now = new Date("2026-08-09T12:00:00");
    writeCronState({
      "google-tasks-reconciler": tickerStamp(new Date("2026-08-09T11:37:00")),
      "closure-watcher": tickerStamp(new Date("2026-08-09T12:00:00")),
    });
    const lastRun = readSchedulerLastRun(home);
    assert.ok(lastRun["google-tasks-reconciler"], "expected the reconciler entry to be found");
    const age = now.getTime() - lastRun["google-tasks-reconciler"];
    assert.ok(age >= 0 && age < 60 * 60_000, `expected a ~23min age, got ${age}ms`);
  });

  it("returns an empty map when neither source exists", () => {
    assert.deepEqual(readSchedulerLastRun(home), {});
  });

  it("still reads legacy state.json scheduler.lastRun when present", () => {
    const ts = new Date("2026-08-09T11:00:00").getTime();
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({ scheduler: { lastRun: { "morning-brief": ts } } }),
    );
    const lastRun = readSchedulerLastRun(home);
    assert.equal(lastRun["morning-brief"], ts);
  });

  it("merges both sources, preferring the more recent timestamp per job", () => {
    const older = new Date("2026-08-03T20:37:00");
    const newer = new Date("2026-08-09T11:37:00");
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        scheduler: { lastRun: { "google-tasks-reconciler": older.getTime() } },
      }),
    );
    writeCronState({ "google-tasks-reconciler": tickerStamp(newer) });
    const lastRun = readSchedulerLastRun(home);
    assert.equal(
      lastRun["google-tasks-reconciler"],
      newer.getTime(),
      "the frozen Aug 3 state.json value must not mask the live Aug 9 ticker value",
    );
  });

  it("ignores unparseable ticker timestamps instead of throwing", () => {
    writeCronState({ "bad-job": "not-a-date", "good-job": tickerStamp(new Date()) });
    const lastRun = readSchedulerLastRun(home);
    assert.equal(lastRun["bad-job"], undefined);
    assert.ok(lastRun["good-job"]);
  });
});

describe("checkRecentTaskActivity", () => {
  it("PASSES when the Hermes ticker shows recent runs", async () => {
    const now = Date.now();
    writeCronState({
      "closure-watcher": tickerStamp(new Date(now - 5 * 60_000)),
      "google-tasks-reconciler": tickerStamp(new Date(now - 20 * 60_000)),
    });
    const res = await checkRecentTaskActivity(home);
    assert.equal(res.status, "PASS", `expected PASS, got ${res.status}: ${res.detail}`);
    assert.match(res.detail, /2 task/);
  });

  it("FAILS when every recorded run is older than 6 hours — the alarm must fire", async () => {
    const stale = new Date(Date.now() - 30 * 3600_000);
    writeCronState({ "closure-watcher": tickerStamp(stale) });
    const res = await checkRecentTaskActivity(home);
    assert.equal(
      res.status,
      "FAIL",
      "a scheduler frozen for 30h must FAIL, not WARN 'no state.json'",
    );
    assert.match(res.detail, /hung|fired/i);
  });

  it("WARNs only when there is genuinely no scheduler state at all", async () => {
    const res = await checkRecentTaskActivity(home);
    assert.equal(res.status, "WARN");
  });
});

describe("health-summary Google Tasks freshness", () => {
  it("reports how long ago the reconciler last synced, not just a file count", () => {
    const memory = join(home, "workspace", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(
      join(memory, "google-tasks-state.json"),
      JSON.stringify({ loopToTask: { a: "t1", b: "t2" } }),
    );
    const parts = buildHealthSummaryParts({ maxosHome: home, daemonStartTime: Date.now() - 1000 });
    assert.equal(parts.loops.googleTasksTracked, 2);
    assert.ok(
      typeof parts.loops.googleTasksSyncAgeMs === "number",
      "expected a sync-age so a dead integration cannot masquerade as healthy",
    );
    assert.ok(parts.loops.googleTasksSyncAgeMs! < 60_000);
  });

  it("marks the Google Tasks mirror stale when the state file has not been written recently", () => {
    const memory = join(home, "workspace", "memory");
    mkdirSync(memory, { recursive: true });
    const p = join(memory, "google-tasks-state.json");
    writeFileSync(p, JSON.stringify({ loopToTask: { a: "t1" } }));
    // Pretend "now" is three days after the file was written.
    const parts = buildHealthSummaryParts({
      maxosHome: home,
      daemonStartTime: Date.now() - 1000,
      now: Date.now() + 3 * 24 * 3600_000,
    });
    assert.equal(parts.loops.googleTasksStale, true);
  });

  it("is not stale when the mirror was written minutes ago", () => {
    const memory = join(home, "workspace", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "google-tasks-state.json"), JSON.stringify({ loopToTask: {} }));
    const parts = buildHealthSummaryParts({ maxosHome: home, daemonStartTime: Date.now() - 1000 });
    assert.equal(parts.loops.googleTasksStale, false);
  });

  it("picks up scheduler runs from the Hermes ticker state file", () => {
    writeCronState({ "closure-watcher": tickerStamp(new Date(Date.now() - 5 * 60_000)) });
    const parts = buildHealthSummaryParts({ maxosHome: home, daemonStartTime: Date.now() - 1000 });
    assert.ok(
      parts.schedulerHighlights.recentRuns.some((r) => r.task === "closure-watcher"),
      "health-summary must see the live ticker's runs, not only legacy state.json",
    );
  });
});
