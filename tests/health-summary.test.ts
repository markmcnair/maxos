import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHealthSummaryParts,
  formatHealthSummary,
  formatHealthDetail,
  buildHealthSummary,
  prettyTaskName,
} from "../src/health-summary.js";

describe("prettyTaskName", () => {
  it("recognizes script-task slugs by content keyword", () => {
    assert.equal(
      prettyTaskName("cd-usersmaxprojectsmaxos-node-distsrcgoogletasksreconcilerjs"),
      "google-tasks-reconciler",
    );
    assert.equal(
      prettyTaskName("cd-usersmaxprojectsmaxos-node-distsrcclosurewatcherjs-hours-03"),
      "closure-watcher",
    );
    assert.equal(
      prettyTaskName("cd-usersmaxprojectsmaxos-node-distsrcjournalarchiverjs-agedays-30"),
      "journal-archiver",
    );
    assert.equal(
      prettyTaskName("cd-usersmaxprojectsmaxos-node-distsrccriticaltaskwatchdogjs"),
      "critical-task-watchdog",
    );
  });

  it("recognizes the journal-checkpoint pattern from heartbeat slug", () => {
    assert.equal(
      prettyTaskName("if-there-has-been-any-substantive-work-decisions-or-conversations-since"),
      "journal-checkpoint",
    );
  });

  it("strips run-(the-) prefix and read-tasks tail for normal task slugs", () => {
    assert.equal(
      prettyTaskName("run-the-morning-brief-read-tasksmorningbriefmd-and-execute-every-step"),
      "morning-brief",
    );
    assert.equal(
      prettyTaskName("run-shutdown-debrief-read-tasksshutdowndebriefmd-and-execute-every-step"),
      "shutdown-debrief",
    );
  });

  it("falls back to the original slug if nothing matches", () => {
    assert.equal(prettyTaskName("totally-random-name"), "totally-random-name");
  });
});

describe("buildHealthSummaryParts", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "health-"));
    mkdirSync(join(tmp, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const fixedNow = new Date("2026-04-27T18:00:00").getTime();
  const startTime = fixedNow - 3 * 3600_000; // started 3h ago

  it("returns zero-state when no files exist", () => {
    const parts = buildHealthSummaryParts({
      maxosHome: tmp,
      daemonStartTime: startTime,
      now: fixedNow,
    });
    assert.equal(parts.daemon.uptimeMs, 3 * 3600_000);
    assert.equal(parts.loops.openCount, 0);
    assert.equal(parts.loops.googleTasksTracked, 0);
    assert.equal(parts.todayActivity.closureCount, 0);
    assert.equal(parts.outbound24h.total, 0);
    assert.deepEqual(parts.schedulerHighlights.disabled, []);
  });

  it("counts open loops correctly", () => {
    writeFileSync(
      join(tmp, "workspace", "memory", "open-loops.json"),
      JSON.stringify([
        { id: "a", topic: "x", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
        { id: "b", topic: "y", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
      ]),
    );
    const parts = buildHealthSummaryParts({
      maxosHome: tmp, daemonStartTime: startTime, now: fixedNow,
    });
    assert.equal(parts.loops.openCount, 2);
  });

  it("counts Google Tasks tracked from state.json", () => {
    writeFileSync(
      join(tmp, "workspace", "memory", "google-tasks-state.json"),
      JSON.stringify({ loopToTask: { a: "ta", b: "tb", c: "tc" } }),
    );
    const parts = buildHealthSummaryParts({
      maxosHome: tmp, daemonStartTime: startTime, now: fixedNow,
    });
    assert.equal(parts.loops.googleTasksTracked, 3);
  });

  it("counts today's closures and reads journal char count", () => {
    writeFileSync(
      join(tmp, "workspace", "memory", "2026-04-27.md"),
      "## scheduled task fired\nblah",
    );
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      [
        "- [09:00] [CLOSURE] sent invoice",
        "- [10:30] [DECISION] dropped X",
        "- [14:15] [FACT] Ruth went to ER",
        "not a closure line",
      ].join("\n"),
    );
    const parts = buildHealthSummaryParts({
      maxosHome: tmp, daemonStartTime: startTime, now: fixedNow,
    });
    assert.ok(parts.todayActivity.journalChars > 0);
    assert.equal(parts.todayActivity.closureCount, 3);
  });

  it("highlights failing scheduled tasks (only those that ran recently)", () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        scheduler: {
          failures: {
            "run-the-morning-brief-read-tasks": 2,    // recent
            "other-task": 0,
            "stuck-thing": 5,                          // recent
            "stale-old-slug-from-50char-era": 3,       // NOT recent → filtered out
          },
          disabled: ["if-there-has-been-any-substantive-work", "stale-disabled-old-slug"],
          lastRun: {
            "run-the-morning-brief-read-tasks": fixedNow - 3600_000,
            "stuck-thing": fixedNow - 60_000,
            "if-there-has-been-any-substantive-work": fixedNow - 3600_000,
            // "stale-old-slug-from-50char-era": no lastRun → stale
            // "stale-disabled-old-slug": no lastRun → stale
          },
        },
      }),
    );
    const parts = buildHealthSummaryParts({
      maxosHome: tmp, daemonStartTime: startTime, now: fixedNow,
    });
    // Failing tasks sorted by failure count desc — stale one filtered out
    assert.equal(parts.schedulerHighlights.failingNow.length, 2);
    assert.equal(parts.schedulerHighlights.failingNow[0].failures, 5);
    // Disabled list filtered to active only
    assert.deepEqual(parts.schedulerHighlights.disabled, ["journal-checkpoint"]);
  });

  it("regression: filters out stale state.json entries from old slug truncation (ISSUE-stale-slugs)", () => {
    // Mimics the real bug: state.json carries 50-char-truncated slugs from
    // before the truncation bumped to 100 chars. Those entries have no
    // recent lastRun. They must NOT clutter /status forever.
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        scheduler: {
          failures: {
            "run-notion-sync-execute-export-nvmdirhomenvm-s-nvm": 3, // OLD, never matches a current task
            "run-notion-sync-execute-export-nvmdirhomenvm-s-nvmdirnvmsh-nvmdirnvmsh-cd-maxosworkspaceservicesnoti": 0, // NEW, healthy
          },
          disabled: ["run-notion-sync-execute-export-nvmdirhomenvm-s-nvm"],
          lastRun: {
            "run-notion-sync-execute-export-nvmdirhomenvm-s-nvmdirnvmsh-nvmdirnvmsh-cd-maxosworkspaceservicesnoti": fixedNow - 30_000,
          },
        },
      }),
    );
    const parts = buildHealthSummaryParts({
      maxosHome: tmp, daemonStartTime: startTime, now: fixedNow,
    });
    assert.deepEqual(parts.schedulerHighlights.failingNow, [], "stale failure should not surface");
    assert.deepEqual(parts.schedulerHighlights.disabled, [], "stale disabled should not surface");
  });

  it("ranks recent task runs by lastRun desc", () => {
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        scheduler: {
          lastRun: {
            "task-a": fixedNow - 3600_000,
            "task-b": fixedNow - 60_000,
            "task-c": fixedNow - 600_000,
          },
        },
      }),
    );
    const parts = buildHealthSummaryParts({
      maxosHome: tmp, daemonStartTime: startTime, now: fixedNow,
    });
    assert.equal(parts.schedulerHighlights.recentRuns[0].task, "task-b");
    assert.equal(parts.schedulerHighlights.recentRuns[1].task, "task-c");
    assert.equal(parts.schedulerHighlights.recentRuns[2].task, "task-a");
  });

  it("aggregates outbound 24h from outbound-events.jsonl", () => {
    writeFileSync(
      join(tmp, "workspace", "memory", "outbound-events.jsonl"),
      [
        JSON.stringify({ ts: fixedNow - 3600_000, conversationId: "dm", chunkCount: 1, totalChars: 100, durationMs: 50, status: "ok" }),
        JSON.stringify({ ts: fixedNow - 1800_000, conversationId: "dm", chunkCount: 2, totalChars: 4000, durationMs: 200, status: "failed", error: "boom" }),
        JSON.stringify({ ts: fixedNow - 2 * 86400_000, conversationId: "dm", chunkCount: 1, totalChars: 100, durationMs: 50, status: "ok" }), // outside 24h window
      ].join("\n"),
    );
    const parts = buildHealthSummaryParts({
      maxosHome: tmp, daemonStartTime: startTime, now: fixedNow,
    });
    assert.equal(parts.outbound24h.total, 2);
    assert.equal(parts.outbound24h.failed, 1);
    assert.equal(parts.outbound24h.lastFailure?.error, "boom");
  });
});

describe("formatHealthSummary", () => {
  const fixedNow = new Date("2026-04-27T18:00:00").getTime();

  it("renders a complete health block with all sections", () => {
    const block = formatHealthSummary(
      {
        daemon: { uptimeMs: 3600_000, startedAt: fixedNow - 3600_000, sessionCount: 1, sessionMessageTotal: 12 },
        loops: { openCount: 4, googleTasksTracked: 4 },
        schedulerHighlights: {
          disabled: ["bad-task"],
          failingNow: [{ task: "shaky-task", failures: 2 }],
          recentRuns: [
            { task: "morning-brief", lastRunMs: fixedNow - 60_000 },
            { task: "closure-watcher", lastRunMs: fixedNow - 300_000 },
          ],
        },
        todayActivity: { journalChars: 1500, closureCount: 3 },
        outbound24h: { total: 25, ok: 24, failed: 1, retried: 0, successRate: 0.96, totalChars: 50000, averageDurationMs: 120 },
      },
      fixedNow,
    );
    assert.match(block, /MaxOS status/);
    assert.match(block, /Daemon up 1h/);
    assert.match(block, /4 open loops · 4 mirrored/);
    assert.match(block, /1500c journal/);
    assert.match(block, /25 sent, 96% ok/);
    assert.match(block, /shaky-task \(2\)/);
    assert.match(block, /disabled by circuit breaker: bad-task/);
    assert.match(block, /morning-brief —/);
  });

  it("omits the failing-tasks line when nothing's failing", () => {
    const block = formatHealthSummary(
      {
        daemon: { uptimeMs: 60_000, startedAt: fixedNow - 60_000, sessionCount: 1, sessionMessageTotal: 0 },
        loops: { openCount: 0, googleTasksTracked: 0 },
        schedulerHighlights: { disabled: [], failingNow: [], recentRuns: [] },
        todayActivity: { journalChars: 0, closureCount: 0 },
        outbound24h: { total: 0, ok: 0, failed: 0, retried: 0, successRate: 1, totalChars: 0, averageDurationMs: 0 },
      },
      fixedNow,
    );
    assert.doesNotMatch(block, /failing scheduled tasks/);
    assert.doesNotMatch(block, /circuit breaker/);
    assert.match(block, /outbound \(24h\): silent/);
  });
});

describe("formatHealthDetail", () => {
  const fixedNow = new Date("2026-04-27T18:00:00").getTime();

  it("renders a multi-section detail block with task slugs and timestamps", () => {
    const block = formatHealthDetail(
      {
        daemon: { uptimeMs: 7200_000, startedAt: fixedNow - 7200_000, sessionCount: 1, sessionMessageTotal: 5 },
        loops: { openCount: 4, googleTasksTracked: 3 },
        schedulerHighlights: {
          disabled: ["bad-task"],
          failingNow: [{ task: "shaky", failures: 2 }],
          recentRuns: [{ task: "morning-brief", lastRunMs: fixedNow - 60_000 }],
        },
        todayActivity: { journalChars: 1500, closureCount: 2 },
        outbound24h: { total: 10, ok: 9, failed: 1, retried: 0, successRate: 0.9, totalChars: 2000, averageDurationMs: 100, lastFailure: { ts: fixedNow - 3600_000, conversationId: "dm", chunkCount: 1, totalChars: 100, durationMs: 50, status: "failed", error: "Bad Request: chat not found" } },
      },
      fixedNow,
    );
    assert.match(block, /MaxOS detailed status/);
    assert.match(block, /uptime: 2h/);
    assert.match(block, /Failing scheduled tasks/);
    assert.match(block, /Disabled by circuit breaker/);
    assert.match(block, /Last 6 scheduled runs/);
    assert.match(block, /last failure: "Bad Request/);
  });

  it("hides empty sections", () => {
    const block = formatHealthDetail(
      {
        daemon: { uptimeMs: 60_000, startedAt: fixedNow - 60_000, sessionCount: 0, sessionMessageTotal: 0 },
        loops: { openCount: 0, googleTasksTracked: 0 },
        schedulerHighlights: { disabled: [], failingNow: [], recentRuns: [] },
        todayActivity: { journalChars: 0, closureCount: 0 },
        outbound24h: { total: 0, ok: 0, failed: 0, retried: 0, successRate: 1, totalChars: 0, averageDurationMs: 0 },
      },
      fixedNow,
    );
    assert.doesNotMatch(block, /Failing scheduled tasks/);
    assert.doesNotMatch(block, /Disabled by circuit breaker/);
    assert.match(block, /silent \(no messages sent/);
  });
});

describe("buildHealthSummary (smoke — no FS)", () => {
  it("returns a string with no exceptions when maxosHome is empty/missing", () => {
    const block = buildHealthSummary({
      maxosHome: "/tmp/nonexistent-maxos-home-test",
      daemonStartTime: Date.now() - 60_000,
      now: Date.now(),
    });
    assert.equal(typeof block, "string");
    assert.match(block, /MaxOS status/);
  });
});
