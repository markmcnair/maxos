import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectMissedRuns,
  formatMissedAlert,
  type TaskLastRunInfo,
  type MissedRun,
} from "../src/missed-cron.js";

const NOW = new Date("2026-04-23T07:00:00-05:00"); // Wed 7am CDT
const ONE_HOUR = 60 * 60 * 1000;
const THREE_HOURS = 3 * ONE_HOUR;

describe("detectMissedRuns", () => {
  it("flags a task that should have fired 1 hour ago but hasn't", () => {
    const tasks: TaskLastRunInfo[] = [
      {
        name: "morning-brief",
        cron: "0 6 * * 0-5", // 6am Sun-Fri
        silent: false,
        lastRun: NOW.getTime() - 2 * 24 * ONE_HOUR, // last ran 2 days ago
      },
    ];
    const missed = detectMissedRuns(tasks, NOW, 4);
    assert.equal(missed.length, 1);
    assert.equal(missed[0].taskName, "morning-brief");
  });

  it("skips tasks that already ran at/after the most recent scheduled fire", () => {
    const tasks: TaskLastRunInfo[] = [
      {
        name: "morning-brief",
        cron: "0 6 * * 0-5",
        silent: false,
        lastRun: NOW.getTime() - 30 * 60 * 1000, // ran 30 min ago (after 6am)
      },
    ];
    const missed = detectMissedRuns(tasks, NOW, 4);
    assert.deepEqual(missed, []);
  });

  it("skips tasks whose most recent fire was outside the window", () => {
    // Task scheduled daily at 6am, but we're checking at 7am NEXT day,
    // so the most recent fire was 25 hours ago, outside a 4-hour window.
    const tasks: TaskLastRunInfo[] = [
      {
        name: "morning-brief",
        cron: "0 6 * * 0-5",
        silent: false,
        lastRun: NOW.getTime() - 5 * 24 * ONE_HOUR,
      },
    ];
    // Windowing: don't alert on runs more than 4 hours old
    const missed = detectMissedRuns(tasks, NOW, 4);
    assert.equal(missed.length, 1, "6am today is within 4h of 7am — flagged");

    // Narrow window to 30 min — 6am is 1h ago → should be SKIPPED
    const missedShort = detectMissedRuns(tasks, NOW, 0.5);
    assert.equal(missedShort.length, 0);
  });

  it("handles tasks that never ran (lastRun undefined)", () => {
    const tasks: TaskLastRunInfo[] = [
      {
        name: "morning-brief",
        cron: "0 6 * * 0-5",
        silent: false,
        lastRun: undefined,
      },
    ];
    const missed = detectMissedRuns(tasks, NOW, 4);
    assert.equal(missed.length, 1, "never-ran tasks should be flagged if within window");
  });

  it("handles invalid cron expressions gracefully (skips)", () => {
    const tasks: TaskLastRunInfo[] = [
      { name: "bad-cron", cron: "not valid", silent: false, lastRun: undefined },
    ];
    const missed = detectMissedRuns(tasks, NOW, 4);
    assert.deepEqual(missed, []);
  });

  it("reports the scheduled fire time for the missed task", () => {
    const tasks: TaskLastRunInfo[] = [
      {
        name: "debrief",
        cron: "35 16 * * 0-5", // 4:35pm
        silent: false,
        lastRun: NOW.getTime() - 2 * 24 * ONE_HOUR,
      },
    ];
    // NOW is Wed 7am, so "4:35pm most recently" is yesterday Tue 4:35pm.
    // That's ~14 hours ago — outside default 4h window. Use 24h.
    const missed = detectMissedRuns(tasks, NOW, 24);
    assert.equal(missed.length, 1);
    const fireTime = new Date(missed[0].scheduledFireTime);
    assert.equal(fireTime.getHours(), 16);
    assert.equal(fireTime.getMinutes(), 35);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(detectMissedRuns([], NOW, 4), []);
  });
});

describe("formatMissedAlert", () => {
  it("produces a single-paragraph alert for one missed task", () => {
    const missed: MissedRun[] = [
      {
        taskName: "morning-brief",
        scheduledFireTime: new Date("2026-04-23T06:00:00-05:00").toISOString(),
        lastRun: undefined,
        silent: false,
        ageMinutes: 60,
      },
    ];
    const alert = formatMissedAlert(missed);
    assert.ok(alert.includes("morning-brief"));
    assert.ok(alert.toLowerCase().includes("missed"));
    assert.ok(alert.includes("run-task"));
  });

  it("produces a multi-task summary when multiple were missed", () => {
    const missed: MissedRun[] = [
      { taskName: "morning-brief", scheduledFireTime: "2026-04-23T11:00:00Z", lastRun: undefined, silent: false, ageMinutes: 60 },
      { taskName: "debrief", scheduledFireTime: "2026-04-22T21:35:00Z", lastRun: undefined, silent: false, ageMinutes: 500 },
    ];
    const alert = formatMissedAlert(missed);
    assert.ok(alert.includes("morning-brief"));
    assert.ok(alert.includes("debrief"));
    assert.ok(alert.match(/\b2\b.*tasks?/i));
  });

  it("returns empty string when nothing was missed", () => {
    assert.equal(formatMissedAlert([]), "");
  });
});
