import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkAllCriticalTasks,
  findMostRecentRunMatching,
  loadSentAlertKeys,
  recordAlertSent,
  dedupAlerts,
  CRITICAL_TASKS,
  type CriticalTaskSpec,
  type WatchdogAlert,
} from "../src/critical-task-watchdog.js";

describe("findMostRecentRunMatching", () => {
  it("returns the largest ts whose key matches the pattern (case-insensitive)", () => {
    const lastRun = {
      "run-the-morning-brief-read-tasks": 1000,
      "run-morning-brief-other-slug": 2000,
      "run-shutdown-debrief-something": 5000,
      "MORNING-BRIEF-CAPS": 1500,
    };
    assert.equal(findMostRecentRunMatching(lastRun, "morning-brief"), 2000);
  });

  it("returns 0 when no match", () => {
    assert.equal(findMostRecentRunMatching({}, "anything"), 0);
    assert.equal(findMostRecentRunMatching({ x: 1 }, "missing"), 0);
  });

  it("ignores non-number values", () => {
    const lastRun = { "morning-brief": "not a number" as unknown as number, "run-morning-brief": 99 };
    assert.equal(findMostRecentRunMatching(lastRun, "morning-brief"), 99);
  });
});

describe("checkAllCriticalTasks", () => {
  const tuesdayMorning = new Date("2026-04-28T11:30:00Z"); // 6:30 AM CT
  const todaysBriefFire = new Date("2026-04-28T11:00:00Z").getTime();

  it("returns no alerts when every critical task fired within its grace window", () => {
    const state = {
      scheduler: {
        lastRun: {
          "run-the-morning-brief-read-tasksmorningbriefmd": todaysBriefFire + 30_000,
          "run-morning-brew-read-tasks": todaysBriefFire + 15 * 60_000 + 5_000,
        },
      },
    };
    const specs: CriticalTaskSpec[] = CRITICAL_TASKS.filter((s) =>
      s.pattern === "morning-brief" || s.pattern === "morning-brew",
    );
    const alerts = checkAllCriticalTasks(state, tuesdayMorning, specs);
    assert.deepEqual(alerts, []);
  });

  it("alerts when morning-brief missed today's 6:00 fire (returns structured WatchdogAlert)", () => {
    const yesterdayBrief = new Date("2026-04-27T11:00:30Z").getTime();
    const state = {
      scheduler: {
        lastRun: {
          "run-the-morning-brief-read-tasksmorningbriefmd": yesterdayBrief,
        },
      },
    };
    const specs = [CRITICAL_TASKS.find((s) => s.pattern === "morning-brief")!];
    const alerts = checkAllCriticalTasks(state, tuesdayMorning, specs);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].taskPattern, "morning-brief");
    assert.equal(alerts[0].expectedFireDateKey, "2026-04-28");
    assert.match(alerts[0].text, /morning brief missed its 2026-04-28 scheduled fire/);
    assert.match(alerts[0].text, /\/status/);
  });

  it("alerts when a critical task has NEVER fired", () => {
    const state = { scheduler: { lastRun: {} } };
    const specs = [CRITICAL_TASKS.find((s) => s.pattern === "morning-brief")!];
    const alerts = checkAllCriticalTasks(state, tuesdayMorning, specs);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /Last successful run: never/);
  });

  it("does NOT alert when the previous expected fire is more than 24h ago", () => {
    const saturdayMorning = new Date("2026-05-02T17:30:00Z");
    const state = {
      scheduler: {
        lastRun: {
          "run-shutdown-debrief-read-tasks": new Date("2026-05-01T21:35:00Z").getTime(),
        },
      },
    };
    const specs = [CRITICAL_TASKS.find((s) => s.pattern === "shutdown-debrief")!];
    const alerts = checkAllCriticalTasks(state, saturdayMorning, specs);
    assert.deepEqual(alerts, []);
  });

  it("tolerates missing scheduler section in state", () => {
    assert.deepEqual(checkAllCriticalTasks({}, tuesdayMorning, []), []);
  });

  it("respects per-task graceMin", () => {
    const state = {
      scheduler: {
        lastRun: {
          "run-the-morning-brief-read-tasks": todaysBriefFire - 90 * 60_000,
        },
      },
    };
    const specs = [CRITICAL_TASKS.find((s) => s.pattern === "morning-brief")!];
    const alerts = checkAllCriticalTasks(state, tuesdayMorning, specs);
    assert.equal(alerts.length, 1);
  });

  it("regression: 2026-04-28 morning-brief skip would have been caught", () => {
    const yesterday = new Date("2026-04-27T11:00:00Z").getTime();
    const state = {
      scheduler: {
        lastRun: {
          "run-the-morning-brief-read-tasksmorningbriefmd-and-execute-every-step": yesterday,
        },
      },
    };
    const specs = [CRITICAL_TASKS.find((s) => s.pattern === "morning-brief")!];
    const alerts = checkAllCriticalTasks(state, tuesdayMorning, specs);
    assert.equal(alerts.length, 1);
  });
});

describe("dedupAlerts + loadSentAlertKeys + recordAlertSent (regression for hourly spam)", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "watchdog-dedup-"));
    path = join(tmp, "watchdog-alerts.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const sampleAlerts: WatchdogAlert[] = [
    { taskPattern: "morning-brief", expectedFireDateKey: "2026-04-29", text: "🚨 brief missed Wed" },
    { taskPattern: "shutdown-debrief", expectedFireDateKey: "2026-04-28", text: "🚨 debrief missed Tue" },
    { taskPattern: "shutdown-debrief", expectedFireDateKey: "2026-04-29", text: "🚨 debrief missed Wed" },
  ];

  it("first run sends every alert (nothing in log yet)", () => {
    const sent = loadSentAlertKeys(path);
    const fresh = dedupAlerts(sampleAlerts, sent);
    assert.equal(fresh.length, 3);
  });

  it("second run with same alerts produces zero fresh — full suppression", () => {
    for (const a of sampleAlerts) recordAlertSent(path, a.taskPattern, a.expectedFireDateKey);
    const sent = loadSentAlertKeys(path);
    const fresh = dedupAlerts(sampleAlerts, sent);
    assert.equal(fresh.length, 0);
  });

  it("dedup is per (taskPattern, expectedFireDateKey) — different date is fresh", () => {
    recordAlertSent(path, "morning-brief", "2026-04-28");
    recordAlertSent(path, "morning-brief", "2026-04-29");
    const sent = loadSentAlertKeys(path);
    // alert for 2026-04-30 is still fresh
    const fresh = dedupAlerts(
      [{ taskPattern: "morning-brief", expectedFireDateKey: "2026-04-30", text: "..." }],
      sent,
    );
    assert.equal(fresh.length, 1);
  });

  it("regression: 24-hourly watchdog ticks against the same overdue task = ONE alert", () => {
    // Simulate: hourly watchdog runs at xx:33 from 06:33 to 17:33 (12 ticks).
    // First tick logs the alert; subsequent 11 should suppress.
    const overdue: WatchdogAlert[] = [
      { taskPattern: "shutdown-debrief", expectedFireDateKey: "2026-04-28", text: "🚨 debrief missed Tue" },
    ];

    let totalSent = 0;
    for (let i = 0; i < 12; i++) {
      const sent = loadSentAlertKeys(path);
      const fresh = dedupAlerts(overdue, sent);
      for (const a of fresh) {
        totalSent++;
        recordAlertSent(path, a.taskPattern, a.expectedFireDateKey);
      }
    }
    assert.equal(totalSent, 1, "12 hourly ticks for the same overdue task should produce exactly 1 alert");
  });

  it("recordAlertSent never throws on bad path", () => {
    assert.doesNotThrow(() => {
      recordAlertSent("/nonexistent-dir/file.jsonl", "x", "2026-04-29");
    });
  });

  it("loadSentAlertKeys returns empty Set when file missing", () => {
    const sent = loadSentAlertKeys(join(tmp, "no-such-file.jsonl"));
    assert.equal(sent.size, 0);
  });

  it("loadSentAlertKeys tolerates corrupt JSON lines", () => {
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: 1, taskPattern: "morning-brief", expectedFireDateKey: "2026-04-29" }),
        "not-json",
        "{broken",
        JSON.stringify({ ts: 2, taskPattern: "shutdown-debrief", expectedFireDateKey: "2026-04-29" }),
      ].join("\n"),
    );
    const sent = loadSentAlertKeys(path);
    assert.equal(sent.size, 2);
  });
});
