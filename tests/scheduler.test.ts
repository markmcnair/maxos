import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHeartbeat, isInProtectedWindow, buildTaskFailureLogEntry } from "../src/scheduler.js";

describe("parseHeartbeat", () => {
  it("parses 'Every N minutes' format", () => {
    const md = "## Every 30 minutes\n- Check for new messages";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, "check-for-new-messages");
    assert.equal(tasks[0].cron, "*/30 * * * *");
    assert.equal(tasks[0].prompt, "Check for new messages");
  });

  it("parses 'Every N hours' format", () => {
    const md = "## Every 2 hours\n- Run health check";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].cron, "0 */2 * * *");
  });

  it("parses raw cron expression", () => {
    const md = "## 0 6 * * 0-5 (Morning brief)\n- Run morning brief: read tasks/morning-brief.md";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "0 6 * * 0-5");
    assert.equal(tasks[0].prompt, "Run morning brief: read tasks/morning-brief.md");
  });

  it("parses multiple tasks", () => {
    const md = [
      "# Heartbeat Tasks",
      "",
      "## Every 30 minutes",
      "- Task one",
      "",
      "## 0 9 * * 1 (Monday check)",
      "- Task two",
    ].join("\n");
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 2);
  });

  it("handles multi-line bullet points under one heading", () => {
    const md = "## Every 45 minutes\n- First task\n- Second task";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 2);
  });

  it("parses [script] tag on headings — marks task as deterministic shell exec", () => {
    const md = "## */15 * * * * [script]\n- cd /tmp && echo hello";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].script, true);
    // Script tasks are always silent (no user delivery)
    assert.equal(tasks[0].silent, true);
    assert.equal(tasks[0].prompt, "cd /tmp && echo hello");
  });

  it("parses [script] with other tags like [timeout:2m]", () => {
    const md = "## */15 * * * * [script] [timeout:2m]\n- do the thing";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].script, true);
    assert.equal(tasks[0].timeout, 120_000);
  });

  it("non-script tasks do not have script set", () => {
    const md = "## 0 6 * * *\n- Regular LLM task";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].script, undefined);
  });

  it("parses [silent] tag on headings", () => {
    const md = "## Every 45 minutes [silent]\n- Write a checkpoint to today's journal";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "*/45 * * * *");
    assert.equal(tasks[0].silent, true);
  });

  it("non-silent tasks have silent as false", () => {
    const md = "## 0 6 * * 0-5 (Morning brief)\n- Run morning brief";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].silent, false);
  });

  it("parses [timeout:Nm] tag on headings", () => {
    const md = "## 55 15 * * 0-5 [timeout:20m]\n- Run email triage";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "55 15 * * 0-5");
    assert.equal(tasks[0].timeout, 1_200_000);
  });

  it("parses [timeout:Ns] tag as seconds (fast script tasks)", () => {
    const md = "## 30 5 * * * [script] [timeout:30s]\n- echo done";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "30 5 * * *");
    assert.equal(tasks[0].timeout, 30_000);
    assert.equal(tasks[0].script, true);
  });

  it("regression: [timeout:30s] no longer silently drops the task (ISSUE-011)", () => {
    // Pre-fix: timeout regex only matched "m", leaving [timeout:30s] in the
    // heading. The cron regex then failed to match and the task vanished
    // from the schedule with no error log. The daily state backup at
    // 30 5 * * * was un-registered for weeks because of this.
    const md = "## 30 5 * * * [script] [silent] [timeout:30s]\n- cp /a /b";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1, "task must register, not silently drop");
    assert.equal(tasks[0].cron, "30 5 * * *");
  });

  it("an unrecognized [tag] does not crash the parser (warns instead)", () => {
    // The new sentinel emits a logger.warn for cron-shaped headings that
    // don't match any cron form (likely unrecognized tag or typo). This
    // test just confirms the parser doesn't throw and skips the task,
    // rather than crashing or registering a malformed cron.
    const md = "## 25,55 * * * * [made-up-tag]\n- some prompt";
    assert.doesNotThrow(() => parseHeartbeat(md));
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 0, "unrecognized tag leaves heading unparseable, task is skipped (but warned)");
  });

  it("non-cron prose headings (like '## Notes') do not trigger a false-positive warning path", () => {
    // The sentinel must only fire for cron-shaped headings. A pure prose
    // heading like "## Notes" or "## Backup procedures" should be silently
    // ignored without warning, since it's clearly not a malformed cron.
    const md = "## Notes about the system\n- some bullet that should not register";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 0);
  });

  it("parses both [silent] and [timeout:Nm] tags together", () => {
    const md = "## Every 45 minutes [silent] [timeout:5m]\n- Quick checkpoint";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].silent, true);
    assert.equal(tasks[0].timeout, 300_000);
    assert.equal(tasks[0].cron, "*/45 * * * *");
  });

  it("parses [model:NAME] tag and sets task.model", () => {
    const md = "## 25,55 * * * * [silent] [model:sonnet]\n- Journal checkpoint";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].model, "sonnet");
    assert.equal(tasks[0].silent, true);
    assert.equal(tasks[0].cron, "25,55 * * * *");
  });

  it("accepts hyphenated + versioned model names", () => {
    const md = "## 0 6 * * * [model:claude-haiku-4-5]\n- Cheap one-shot";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].model, "claude-haiku-4-5");
  });

  it("tasks without [model:NAME] have undefined model (fall back to config default)", () => {
    const md = "## 0 6 * * 0-5\n- Run morning brief";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].model, undefined);
  });

  it("[model:NAME] does not pollute subsequent task without its own model tag", () => {
    const md = [
      "## 0 6 * * * [model:sonnet]",
      "- Cheap task",
      "## 0 7 * * *",
      "- Default-model task",
    ].join("\n");
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].model, "sonnet");
    assert.equal(tasks[1].model, undefined);
  });

  it("tasks without [timeout:Nm] have undefined timeout", () => {
    const md = "## 0 6 * * 0-5\n- Run morning brief";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].timeout, undefined);
  });

  it("preserves enough slug for full task names like morning-brew", () => {
    const md = "## 15 6 * * 0-5\n- Run morning brew: read tasks/morning-brew.md and execute every step";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].name.length <= 100, "slug should fit in 100 chars");
    assert.ok(
      tasks[0].name.endsWith("step"),
      "slug should end on a complete word, not mid-truncate to 'execu' as it did when the limit was 50",
    );
  });

  it("pins the slug truncation at exactly 100 chars (regression for ISSUE-010)", () => {
    // Build a prompt whose slug is exactly 120 chars before truncation. If
    // the limit is loosened past 120, the assertion fails. If tightened
    // below 100, the assertion fails. Pins both directions.
    const longBody = "Run an extra long task name that contains many many many many words to push the slug well past one hundred chars";
    const md = `## 15 6 * * 0-5\n- ${longBody}`;
    const tasks = parseHeartbeat(md);
    const slug = tasks[0].name;
    assert.equal(slug.length, 100, `expected slug truncated to exactly 100, got ${slug.length}`);
    // Sanity: this slug at the OLD 50-limit would have been truncated even shorter
    assert.ok(longBody.length > 100, "test setup: prompt must be long enough to truncate");
  });

  it("does not truncate slugs already shorter than 100 (regression for ISSUE-010)", () => {
    const md = "## 0 6 * * *\n- Short prompt";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].name, "short-prompt");
    assert.ok(tasks[0].name.length < 100);
  });
});

describe("Scheduler.pruneStaleState", () => {
  it("removes failures/disabled/lastRun entries not in currentTaskNames", async () => {
    const { Scheduler } = await import("../src/scheduler.js");
    const noop = async () => "";
    const noopDeliver = () => {};
    const noopAlert = () => {};
    const sched = new Scheduler(3, 3, [], noop, noopDeliver, noopAlert);
    sched.loadState({
      failures: { "current-task": 2, "stale-old-slug": 3 },
      disabled: ["stale-old-slug", "current-task"],
      lastRun: { "current-task": 1000, "stale-old-slug": 500 },
    });
    const pruned = sched.pruneStaleState(new Set(["current-task"]));
    assert.deepEqual(pruned.failuresPruned, ["stale-old-slug"]);
    assert.deepEqual(pruned.disabledPruned, ["stale-old-slug"]);
    assert.deepEqual(pruned.lastRunPruned, ["stale-old-slug"]);
    const after = sched.getState();
    assert.deepEqual(after.failures, { "current-task": 2 });
    assert.deepEqual(after.disabled, ["current-task"]);
    assert.deepEqual(after.lastRun, { "current-task": 1000 });
  });

  it("returns empty pruned arrays when nothing is stale", async () => {
    const { Scheduler } = await import("../src/scheduler.js");
    const sched = new Scheduler(3, 3, [], async () => "", () => {}, () => {});
    sched.loadState({
      failures: { a: 1 },
      disabled: [],
      lastRun: { a: 100 },
    });
    const pruned = sched.pruneStaleState(new Set(["a", "b"]));
    assert.deepEqual(pruned.failuresPruned, []);
    assert.deepEqual(pruned.disabledPruned, []);
    assert.deepEqual(pruned.lastRunPruned, []);
  });

  it("regression: prevents the orphan-slug accumulation that bit /status today", async () => {
    // After scheduler.ts slug truncation bumped 50 → 100, state.json carried
    // both old-50char and new-100char slugs. The new daemon's task list only
    // has the 100-char version; the old slug is orphan. Without pruning it
    // would surface as "circuit-breaker disabled" in /status forever.
    const { Scheduler } = await import("../src/scheduler.js");
    const sched = new Scheduler(3, 3, [], async () => "", () => {}, () => {});
    sched.loadState({
      failures: {
        "run-notion-sync-execute-export-nvmdirhomenvm-s-nvm": 3, // OLD (50 chars)
        "run-notion-sync-execute-export-nvmdirhomenvm-s-nvmdirnvmsh-nvmdirnvmsh-cd-maxosworkspaceservicesnoti": 0,
      },
      disabled: ["run-notion-sync-execute-export-nvmdirhomenvm-s-nvm"],
      lastRun: {
        "run-notion-sync-execute-export-nvmdirhomenvm-s-nvmdirnvmsh-nvmdirnvmsh-cd-maxosworkspaceservicesnoti": Date.now(),
      },
    });
    const currentTasks = new Set([
      "run-notion-sync-execute-export-nvmdirhomenvm-s-nvmdirnvmsh-nvmdirnvmsh-cd-maxosworkspaceservicesnoti",
    ]);
    sched.pruneStaleState(currentTasks);
    const after = sched.getState();
    assert.equal(Object.keys(after.failures).length, 1);
    assert.equal(after.disabled.length, 0);
  });
});

describe("isInProtectedWindow", () => {
  it("detects time within start-end range", () => {
    const windows = [{ name: "sleep", start: "22:00", end: "06:00" }];
    const date = new Date("2026-03-27T23:00:00");
    assert.equal(isInProtectedWindow(date, windows), true);
  });

  it("detects time outside start-end range", () => {
    const windows = [{ name: "sleep", start: "22:00", end: "06:00" }];
    const date = new Date("2026-03-27T12:00:00");
    assert.equal(isInProtectedWindow(date, windows), false);
  });

  it("detects day-based window", () => {
    const windows = [{ name: "family-time", day: "saturday" }];
    const date = new Date("2026-03-28T12:00:00");
    assert.equal(isInProtectedWindow(date, windows), true);
  });

  it("detects day+time window", () => {
    const windows = [{ name: "focus-block", day: "thursday", start: "17:30" }];
    const date = new Date("2026-03-26T18:00:00");
    assert.equal(isInProtectedWindow(date, windows), true);
  });

  it("returns false when no windows match", () => {
    const windows = [{ name: "family-time", day: "saturday" }];
    const date = new Date("2026-03-25T12:00:00");
    assert.equal(isInProtectedWindow(date, windows), false);
  });
});

describe("buildTaskFailureLogEntry (Round Q observability fix)", () => {
  it("includes the error message — silent swallowing was the Monday-token-storm bug", () => {
    // Pre-fix: scheduler:task_failed only logged { task, failures }. When
    // claude CLI started returning 401 on Monday morning, the daemon log
    // showed 50+ "task_failed" lines with no clue WHY. Mark and I had to
    // run the CLI manually to discover the auth error. Now the err.message
    // is in every log line so a tail of daemon.log surfaces the cause.
    const err = new Error(
      'oneShot exited with code 1: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
    );
    const entry = buildTaskFailureLogEntry("morning-brief", 1, err);
    assert.equal(entry.task, "morning-brief");
    assert.equal(entry.failures, 1);
    assert.match(entry.error, /401/);
    assert.match(entry.error, /authentication/i);
  });

  it("handles non-Error throwables (string, undefined, etc.) without crashing", () => {
    assert.equal(buildTaskFailureLogEntry("x", 2, "raw string error").error, "raw string error");
    assert.equal(buildTaskFailureLogEntry("x", 1, undefined).error, "undefined");
    assert.equal(buildTaskFailureLogEntry("x", 1, null).error, "null");
    assert.equal(buildTaskFailureLogEntry("x", 1, 42).error, "42");
  });

  it("truncates pathologically long error strings so log lines stay parseable", () => {
    const longErr = new Error("X".repeat(5000));
    const entry = buildTaskFailureLogEntry("x", 1, longErr);
    // The whole entry is JSON-logged; keep error field bounded so a
    // single bad task doesn't blow up the log line size budget.
    assert.ok(entry.error.length <= 1000, `error should be truncated, got ${entry.error.length}`);
  });
});
