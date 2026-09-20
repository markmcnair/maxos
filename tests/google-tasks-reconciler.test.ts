import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reconcileTasks,
  runGoogleTasksReconciler,
  formatTaskTitle,
  formatTaskNotes,
  formatTaskDue,
  formatClosureLine,
  formatDropLine,
  ownsAction,
  exitCodeForResult,
  formatRunSummary,
} from "../src/google-tasks-reconciler.js";
import type { OpenLoop } from "../src/loop-reconciler.js";
import type { GoogleTask, ListTasksResult } from "../src/google-tasks.js";

// owner defaults to "mark" so the state-machine tests below keep testing the
// state machine. The ownership GATE has its own describe block at the bottom —
// that is where owner-absent and owner-someone-else are pinned down.
const baseLoop = (overrides: Partial<OpenLoop>): OpenLoop => ({
  id: "test-loop",
  topic: "Test loop topic",
  firstSeen: "2026-04-22",
  lastUpdated: "2026-04-24",
  owner: "mark",
  ...overrides,
});

const baseTask = (overrides: Partial<GoogleTask> & { loopId?: string }): GoogleTask => ({
  id: overrides.id ?? "task-id",
  title: overrides.title ?? "Test task",
  notes: overrides.notes ?? (overrides.loopId ? `[loop:${overrides.loopId}]` : undefined),
  status: overrides.status ?? "needsAction",
  updated: overrides.updated ?? "2026-04-27T12:00:00Z",
  due: overrides.due,
});

describe("reconcileTasks (pure)", () => {
  it("creates tasks for loops not yet tracked", () => {
    const loop = baseLoop({ id: "new-loop" });
    const decision = reconcileTasks({
      loops: [loop],
      tasks: [],
      state: { loopToTask: {} },
    });
    assert.equal(decision.creates.length, 1);
    assert.equal(decision.creates[0].id, "new-loop");
    assert.equal(decision.closures.length, 0);
    assert.equal(decision.drops.length, 0);
  });

  it("emits a CLOSURE when the tracked task is completed", () => {
    const loop = baseLoop({ id: "done-loop", topic: "Send the invoice" });
    const task = baseTask({ id: "t1", loopId: "done-loop", status: "completed" });
    const decision = reconcileTasks({
      loops: [loop],
      tasks: [task],
      state: { loopToTask: { "done-loop": "t1" } },
    });
    assert.equal(decision.closures.length, 1);
    assert.equal(decision.closures[0].loopId, "done-loop");
    assert.equal(decision.closures[0].title, "Send the invoice");
    assert.equal(decision.creates.length, 0);
    assert.equal(decision.drops.length, 0);
    // Completed task removed from new state
    assert.equal(decision.newState.loopToTask["done-loop"], undefined);
  });

  it("emits a DROP when previously-tracked task disappears (Mark deleted)", () => {
    const loop = baseLoop({ id: "fake-loop", topic: "Fake MNDA work" });
    const decision = reconcileTasks({
      loops: [loop],
      tasks: [],
      state: { loopToTask: { "fake-loop": "t-deleted" } },
    });
    assert.equal(decision.drops.length, 1);
    assert.equal(decision.drops[0].loopId, "fake-loop");
    assert.equal(decision.drops[0].title, "Fake MNDA work");
    assert.equal(decision.creates.length, 0);
    assert.equal(decision.closures.length, 0);
    // Dropped task removed from new state
    assert.equal(decision.newState.loopToTask["fake-loop"], undefined);
  });

  it("preserves mapping for active tracked tasks (no-op)", () => {
    const loop = baseLoop({ id: "active-loop" });
    const task = baseTask({ id: "t1", loopId: "active-loop", status: "needsAction" });
    const decision = reconcileTasks({
      loops: [loop],
      tasks: [task],
      state: { loopToTask: { "active-loop": "t1" } },
    });
    assert.equal(decision.closures.length, 0);
    assert.equal(decision.drops.length, 0);
    assert.equal(decision.creates.length, 0);
    assert.equal(decision.newState.loopToTask["active-loop"], "t1");
  });

  it("ignores tasks Mark created manually (no [loop:ID] marker)", () => {
    const manualTask = baseTask({ id: "manual", title: "Buy groceries", notes: "no marker here" });
    const loop = baseLoop({ id: "tracked-loop" });
    const decision = reconcileTasks({
      loops: [loop],
      tasks: [manualTask],
      state: { loopToTask: {} },
    });
    // The manual task is invisible to the reconciler; loop still gets a fresh task created
    assert.equal(decision.creates.length, 1);
    assert.equal(decision.creates[0].id, "tracked-loop");
  });

  it("regression: deleted Google Task drops the loop forever via DECISION line", () => {
    // Mark's promise: delete the task in Google Tasks, MaxOS never raises it again
    const fakeLoop = baseLoop({
      id: "mike-salem-mnda-financials",
      topic: "Mike Salem acquisition — MNDA",
      person: "Mike Salem",
    });
    const decision = reconcileTasks({
      loops: [fakeLoop],
      tasks: [],
      state: { loopToTask: { "mike-salem-mnda-financials": "t-was-here" } },
    });
    assert.equal(decision.drops.length, 1);
    assert.equal(decision.drops[0].loopId, "mike-salem-mnda-financials");
  });

  it("handles a mix of states across multiple loops in one pass", () => {
    const loops = [
      baseLoop({ id: "a", topic: "A active" }),
      baseLoop({ id: "b", topic: "B done" }),
      baseLoop({ id: "c", topic: "C deleted" }),
      baseLoop({ id: "d", topic: "D never tracked" }),
    ];
    const tasks: GoogleTask[] = [
      baseTask({ id: "ta", loopId: "a", status: "needsAction" }),
      baseTask({ id: "tb", loopId: "b", status: "completed" }),
    ];
    const state = { loopToTask: { a: "ta", b: "tb", c: "tc-deleted" } };
    const decision = reconcileTasks({ loops, tasks, state });
    assert.deepEqual(
      decision.closures.map((c) => c.loopId).sort(),
      ["b"],
    );
    assert.deepEqual(
      decision.drops.map((d) => d.loopId).sort(),
      ["c"],
    );
    assert.deepEqual(
      decision.creates.map((l) => l.id).sort(),
      ["d"],
    );
    assert.equal(decision.newState.loopToTask["a"], "ta");
  });
});

describe("formatters", () => {
  // BURN (Mark, 2026-08-18). formatTaskTitle used to return `${person}: ${topic}`
  // and produced "Haley: Check current Colombia sponsorship pool ... with Haley".
  // A "Name:" prefix reads as an assignee in the Tasks UI. Never again.
  it("formatTaskTitle NEVER prefixes the person — that reads as an assignee", () => {
    const loop = baseLoop({ topic: "ship invoice", person: "Alice" });
    assert.equal(formatTaskTitle(loop), "ship invoice");
    assert.doesNotMatch(formatTaskTitle(loop), /^Alice:/);
  });

  it("formatTaskTitle is the topic, with or without a person", () => {
    assert.equal(formatTaskTitle(baseLoop({ topic: "send paperwork" })), "send paperwork");
    assert.equal(
      formatTaskTitle(baseLoop({ topic: "send paperwork", person: "Glenn" })),
      "send paperwork",
    );
  });

  it("formatTaskNotes embeds the deletion-instruction line", () => {
    const loop = baseLoop({ id: "x" });
    const notes = formatTaskNotes(loop);
    assert.match(notes, /Delete this task to tell MaxOS the loop wasn't real/);
    assert.match(notes, /Mark complete when done/);
  });

  it("formatTaskNotes carries the counterparty, since the title no longer does", () => {
    assert.match(formatTaskNotes(baseLoop({ person: "Haley" })), /(^|\n)With: Haley(\n|$)/);
    assert.doesNotMatch(formatTaskNotes(baseLoop({})), /With:/);
  });

  // Mark 2026-08-12: undated tasks sink to the bottom of the Priority Bucket
  // under "No date" and he never sees them. Due date is the whole fix.
  it("formatTaskDue dates the task by firstSeen so older loops rank as more overdue", () => {
    const loop = baseLoop({ firstSeen: "2026-04-22" });
    assert.equal(formatTaskDue(loop, "2026-08-12"), "2026-04-22T00:00:00.000Z");
  });

  it("formatTaskDue pins midnight UTC — Google reads due as a date and drops the time", () => {
    const due = formatTaskDue(baseLoop({ firstSeen: "2026-08-12" }), "2026-08-12");
    assert.match(due, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    // The date in the string must survive UTC parsing unshifted.
    assert.equal(new Date(due).toISOString().slice(0, 10), "2026-08-12");
  });

  it("formatTaskDue falls back to today when firstSeen is missing or junk", () => {
    for (const bad of [undefined, "", "not-a-date", "2026-13-99"]) {
      const loop = { ...baseLoop({}), firstSeen: bad as unknown as string };
      assert.equal(formatTaskDue(loop, "2026-08-12"), "2026-08-12T00:00:00.000Z", `firstSeen=${bad}`);
    }
  });

  it("formatTaskDue returns empty when no date is usable, so the caller omits due", () => {
    const loop = { ...baseLoop({}), firstSeen: undefined as unknown as string };
    assert.equal(formatTaskDue(loop, "garbage"), "");
  });

  it("formatTaskDue tolerates a full ISO timestamp in firstSeen", () => {
    const loop = baseLoop({ firstSeen: "2026-04-22T18:03:00.000Z" });
    assert.equal(formatTaskDue(loop, "2026-08-12"), "2026-04-22T00:00:00.000Z");
  });

  it("formatClosureLine produces a parseable closure entry", () => {
    const line = formatClosureLine(new Date("2026-04-27T15:30:00"), "send the invoice");
    assert.match(line, /^- \[\d{2}:\d{2}\] \[CLOSURE\] Google Task completed — send the invoice$/);
  });

  it("formatClosureLine includes loop id when supplied", () => {
    const line = formatClosureLine(new Date("2026-04-27T15:30:00"), "send the invoice", "loop-123");
    assert.match(line, /\(loop loop-123\)$/);
  });

  it("formatDropLine produces a parseable DECISION drop entry", () => {
    const line = formatDropLine(new Date("2026-04-27T15:30:00"), "Mike Salem acquisition");
    assert.match(line, /^- \[\d{2}:\d{2}\] \[DECISION\] dropped — Google Task deleted/);
    assert.match(line, /Mike Salem acquisition was never real/);
  });

  it("formatDropLine embeds the loop id so closures-to-loops can match by id", () => {
    const line = formatDropLine(new Date("2026-04-27T15:30:00"), "x", "mike-salem-mnda");
    assert.match(line, /\bdropped \(mike-salem-mnda\)/);
    // Must remain a [DECISION] with a "drop" word so the closures parser flags it
    assert.match(line, /\[DECISION\]/);
    assert.match(line, /\bdropped\b/);
  });
});

describe("runGoogleTasksReconciler (orchestrator with FS + mocked deps)", () => {
  let tmp: string;
  let openLoopsPath: string;
  let statePath: string;
  let closuresPath: string;

  function writeLoops(loops: OpenLoop[]) {
    writeFileSync(openLoopsPath, JSON.stringify(loops, null, 2));
  }
  function readLoops(): OpenLoop[] {
    return JSON.parse(readFileSync(openLoopsPath, "utf-8"));
  }
  function writeState(state: { loopToTask: Record<string, string> }) {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  function readState(): { loopToTask: Record<string, string> } {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  }
  function readClosures(): string {
    return existsSync(closuresPath) ? readFileSync(closuresPath, "utf-8") : "";
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gt-recon-"));
    mkdirSync(join(tmp, "workspace", "memory"), { recursive: true });
    openLoopsPath = join(tmp, "workspace", "memory", "open-loops.json");
    statePath = join(tmp, "workspace", "memory", "google-tasks-state.json");
    closuresPath = join(tmp, "workspace", "memory", "closures-2026-04-27.md");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const fixedNow = new Date("2026-04-27T12:00:00");

  it("BAILS without mutation when state.json is corrupt (audit P1-1)", async () => {
    // If google-tasks-state.json gets corrupted (truncated, partial write,
    // disk full mid-save), the OLD code silently treated state as empty —
    // which means every active tracked task gets the "tracked but missing"
    // treatment on the next run = mass DROP for every loop. Same failure
    // mode as the listTasks-fail bug. Bail out instead.
    writeLoops([
      { id: "x", topic: "X", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
    ]);
    // Corrupt state file — valid JSON but wrong shape
    writeFileSync(statePath, '{"loopToTask": "not-an-object"}');

    const r = await runGoogleTasksReconciler({
      maxosHome: tmp,
      now: fixedNow,
      deps: {
        listTasks: async () => ({ ok: true, tasks: [] }),
        createTaskForLoop: async () => "should-never-be-called",
      },
    });

    assert.equal(r.skippedReason !== undefined, true, "should bail out");
    assert.match(r.skippedReason ?? "", /state/i);
    // No mutations
    assert.equal(readClosures(), "");
  });

  it("BAILS without mutation when listTasks fails (regression for ISSUE-001)", async () => {
    writeLoops([
      { id: "x", topic: "X", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
      { id: "y", topic: "Y", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
    ]);
    writeState({ loopToTask: { x: "tx", y: "ty" } });

    const r = await runGoogleTasksReconciler({
      maxosHome: tmp,
      now: fixedNow,
      deps: {
        listTasks: async (): Promise<ListTasksResult> => ({ ok: false, error: "auth refresh required" }),
        createTaskForLoop: async () => "should-never-be-called",
      },
    });

    assert.equal(r.closures, 0);
    assert.equal(r.drops, 0);
    assert.equal(r.creates, 0);
    assert.equal(r.skippedReason, "auth refresh required");
    // No closures lines written
    assert.equal(readClosures(), "");
    // No state mutation
    assert.deepEqual(readState().loopToTask, { x: "tx", y: "ty" });
    // open-loops untouched
    assert.equal(readLoops().length, 2);
  });

  it("creates tasks for untracked loops, no closures or drops on a fresh slate", async () => {
    writeLoops([
      { id: "x", topic: "X topic", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
    ]);
    let createCalled = 0;
    const r = await runGoogleTasksReconciler({
      maxosHome: tmp,
      now: fixedNow,
      deps: {
        listTasks: async () => ({ ok: true, tasks: [] }),
        createTaskForLoop: async (loopId) => {
          createCalled++;
          return `task-for-${loopId}`;
        },
      },
    });
    assert.equal(r.creates, 1);
    assert.equal(r.closures, 0);
    assert.equal(r.drops, 0);
    assert.equal(createCalled, 1);
    assert.equal(readState().loopToTask["x"], "task-for-x");
  });

  // The regression Mark hit: every task was inserted with no `due`, so Google
  // filed them all under "No date" at the bottom of the list.
  it("passes a due date on every create so tasks never land under 'No date'", async () => {
    writeLoops([
      { id: "x", topic: "X topic", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
      { id: "y", topic: "Y topic", firstSeen: "2026-08-01", lastUpdated: "2026-08-01", owner: "mark" },
    ]);
    const seen: Record<string, string | undefined> = {};
    await runGoogleTasksReconciler({
      maxosHome: tmp,
      now: fixedNow,
      deps: {
        listTasks: async () => ({ ok: true, tasks: [] }),
        createTaskForLoop: async (loopId, _title, options) => {
          seen[loopId] = options.due;
          return `task-for-${loopId}`;
        },
      },
    });
    assert.equal(seen["x"], "2026-04-22T00:00:00.000Z");
    assert.equal(seen["y"], "2026-08-01T00:00:00.000Z");
  });

  it("emits a CLOSURE and removes the loop when a tracked task is completed", async () => {
    writeLoops([
      { id: "x", topic: "Send the invoice", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
    ]);
    writeState({ loopToTask: { x: "tx" } });
    const completedTask: GoogleTask = {
      id: "tx",
      title: "Send the invoice",
      notes: "[loop:x]",
      status: "completed",
      updated: "2026-04-27T11:00:00Z",
    };
    const r = await runGoogleTasksReconciler({
      maxosHome: tmp,
      now: fixedNow,
      deps: {
        listTasks: async () => ({ ok: true, tasks: [completedTask] }),
        createTaskForLoop: async () => null,
      },
    });
    assert.equal(r.closures, 1);
    assert.equal(r.drops, 0);
    assert.equal(r.creates, 0);
    assert.match(readClosures(), /\[CLOSURE\] Google Task completed — Send the invoice/);
    assert.equal(readLoops().length, 0);
    assert.equal(readState().loopToTask["x"], undefined);
  });

  it("emits a DECISION drop line when a tracked task disappears", async () => {
    writeLoops([
      { id: "fake", topic: "Fake MNDA work", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
    ]);
    writeState({ loopToTask: { fake: "t-was-here" } });
    const r = await runGoogleTasksReconciler({
      maxosHome: tmp,
      now: fixedNow,
      deps: {
        listTasks: async () => ({ ok: true, tasks: [] }),
        createTaskForLoop: async () => null,
      },
    });
    assert.equal(r.drops, 1);
    assert.equal(r.closures, 0);
    assert.equal(r.creates, 0);
    assert.match(readClosures(), /\[DECISION\] dropped \(fake\)/);
    // closures-to-loops handles the actual open-loops removal on the next watcher cycle,
    // so the loop is still in open-loops.json after this run — that's by design.
    assert.equal(readLoops().length, 1);
    // State mapping for the dropped loop is gone
    assert.equal(readState().loopToTask["fake"], undefined);
  });

  it("writes a permanent tombstone to dropped-loops.md when a task is deleted (Round O)", async () => {
    // Round O regression: deleted Google Tasks were re-created the next day
    // because closures-{date}.md is only scanned for 2 days. The reconciler
    // now ALSO writes to dropped-loops.md (permanent) so the LLM-driven
    // debrief can't re-extract the same loop from a fresh meeting transcript.
    writeLoops([
      {
        id: "kcr-wholesale-ordering-v1",
        topic: "KCR wholesale ordering system v1",
        person: "Mark",
        firstSeen: "2026-04-28",
        lastUpdated: "2026-04-30",
      },
    ]);
    writeState({ loopToTask: { "kcr-wholesale-ordering-v1": "t-deleted" } });

    await runGoogleTasksReconciler({
      maxosHome: tmp,
      now: fixedNow,
      deps: {
        listTasks: async () => ({ ok: true, tasks: [] }),
        createTaskForLoop: async () => null,
      },
    });

    const droppedPath = join(tmp, "workspace", "memory", "dropped-loops.md");
    assert.ok(existsSync(droppedPath), "dropped-loops.md must exist after a Google Task deletion");
    const droppedContent = readFileSync(droppedPath, "utf-8");
    assert.match(droppedContent, /\*\*KCR wholesale ordering system v1\*\*/, "topic appears bolded");
    assert.match(droppedContent, /\(Mark\)/, "person appears in parens");
    assert.match(droppedContent, /\(loop:kcr-wholesale-ordering-v1\)/, "loop id marker for idempotency");
    assert.match(droppedContent, /Google Task deletion/i, "source labeled");
  });

  it("is idempotent — second run with same inputs is a no-op", async () => {
    writeLoops([
      { id: "x", topic: "Active loop", firstSeen: "2026-04-22", lastUpdated: "2026-04-24", owner: "mark" },
    ]);
    writeState({ loopToTask: { x: "tx" } });
    const activeTask: GoogleTask = {
      id: "tx",
      title: "Active loop",
      notes: "[loop:x]",
      status: "needsAction",
      updated: "2026-04-27T11:00:00Z",
    };
    const deps = {
      listTasks: async (): Promise<ListTasksResult> => ({ ok: true, tasks: [activeTask] }),
      createTaskForLoop: async () => null,
    };
    const r1 = await runGoogleTasksReconciler({ maxosHome: tmp, now: fixedNow, deps });
    const r2 = await runGoogleTasksReconciler({ maxosHome: tmp, now: fixedNow, deps });
    assert.deepEqual(r1, r2);
    assert.equal(r2.closures, 0);
    assert.equal(r2.drops, 0);
    assert.equal(r2.creates, 0);
    assert.equal(readState().loopToTask["x"], "tx");
    assert.equal(readClosures(), ""); // No spurious lines on second pass
  });

  // ⛔ BURN 2026-08-17. Mark: "You're doing multiple google tasks for the same
  // thing- why?" The reconciler had created FIVE tasks for the loop
  // cathy-benson-kcr-website and was adding one more every 15-minute pass.
  //
  // Cause: tasks are indexed into a Map keyed by loop id, so LAST WRITE WINS and
  // one loop can only ever be represented by one task. With three completed
  // leftovers and two live ones sharing the id, the winner was a COMPLETED task
  // from four days earlier. Its id did not match the tracked id, so it took the
  // "leftover from an earlier incarnation → mirror the loop afresh" branch and
  // created another task. The task it created was ALSO not the Map winner next
  // run, so it never converged.
  //
  // The pagination fix is what exposed this: stale completed tasks used to drift
  // past the un-paginated first 100 and vanish. The source comment says so.
  //
  // An OPEN task for a loop must win the index over any completed one, and the
  // TRACKED task must win over everything.
  it("BURN never re-creates when an open task for the loop already exists", async () => {
    writeLoops([
      { id: "cathy", topic: "Send Cathy the KCR link", firstSeen: "2026-08-17", lastUpdated: "2026-08-17", owner: "mark" },
    ]);
    writeState({ loopToTask: { cathy: "open-new" } });
    // Real shape of Mark's list: the stale COMPLETED leftover sorts LAST.
    const tasks: GoogleTask[] = [
      { id: "done-recent", title: "Send Cathy the KCR link", notes: "[loop:cathy]", status: "completed", updated: "2026-08-17T21:33:29Z" },
      { id: "open-new", title: "Send Cathy the KCR link", notes: "[loop:cathy]", status: "needsAction", updated: "2026-08-17T23:22:04Z" },
      { id: "open-older", title: "Send Cathy the KCR link", notes: "[loop:cathy]", status: "needsAction", updated: "2026-08-17T22:37:28Z" },
      { id: "done-stale", title: "Send Cathy the KCR link", notes: "[loop:cathy]", status: "completed", updated: "2026-08-13T02:00:52Z" },
    ];
    let created = 0;
    const deps = {
      listTasks: async (): Promise<ListTasksResult> => ({ ok: true, tasks }),
      createTaskForLoop: async () => { created++; return null; },
    };
    const r = await runGoogleTasksReconciler({ maxosHome: tmp, now: fixedNow, deps });
    assert.equal(r.creates, 0, "a loop with a live open task must never be re-created");
    assert.equal(created, 0, "no API create call");
    assert.equal(r.closures, 0, "a stale completed leftover must not close the loop either");
    assert.equal(readState().loopToTask["cathy"], "open-new", "tracked task is preserved");
  });

  // The tracked task completing IS the close signal, even when stale leftovers
  // carrying the same id sort after it. Losing this would mean Mark ticks the
  // box and the loop never closes.
  it("BURN the tracked task completing still closes the loop", async () => {
    writeLoops([
      { id: "cathy", topic: "Send Cathy the KCR link", firstSeen: "2026-08-17", lastUpdated: "2026-08-17", owner: "mark" },
    ]);
    writeState({ loopToTask: { cathy: "tracked" } });
    const tasks: GoogleTask[] = [
      { id: "tracked", title: "Send Cathy the KCR link", notes: "[loop:cathy]", status: "completed", updated: "2026-08-17T23:52:13Z" },
      { id: "done-stale", title: "Send Cathy the KCR link", notes: "[loop:cathy]", status: "completed", updated: "2026-08-13T02:00:52Z" },
    ];
    const deps = {
      listTasks: async (): Promise<ListTasksResult> => ({ ok: true, tasks }),
      createTaskForLoop: async () => null,
    };
    const r = await runGoogleTasksReconciler({ maxosHome: tmp, now: fixedNow, deps });
    assert.equal(r.closures, 1, "completing the tracked task closes the loop");
    assert.equal(r.creates, 0);
  });
});

/**
 * The ownership gate. Origin: Mark, 2026-08-18.
 *
 * A loop captured from the 2:30 Compassion meeting became the Google Task
 * "Haley: Check current Colombia sponsorship pool/availability with Haley and
 * report back to Josh Farmer and Joey Cook."
 *
 * Mark: "This obviously shouldn't be and is not my job... My google tasks needs
 * to be a FOCUSED bucket on only the things that I MUST get done."
 *
 * Every case here is a BURN case. If one starts failing, fix the code.
 */
describe("ownsAction — only Mark's own verbs reach the Priority Bucket", () => {
  const loop = (o: Partial<OpenLoop>): OpenLoop => ({
    id: "l",
    topic: "T",
    firstSeen: "2026-08-18",
    lastUpdated: "2026-08-18",
    ...o,
  });

  it("owner 'mark' opens the gate", () => {
    assert.equal(ownsAction(loop({ owner: "mark" })), true);
    assert.equal(ownsAction(loop({ owner: "Mark" })), true);
    assert.equal(ownsAction(loop({ owner: "  MARK  " })), true);
    assert.equal(ownsAction(loop({ owner: "Mark McNair" })), true);
  });

  it("FAILS CLOSED with no owner — an unlabelled loop never becomes a task", () => {
    assert.equal(ownsAction(loop({})), false);
    assert.equal(ownsAction(loop({ owner: "" })), false);
    assert.equal(ownsAction(loop({ owner: "   " })), false);
  });

  it("someone else's verb is never Mark's task", () => {
    assert.equal(ownsAction(loop({ owner: "Haley" })), false);
    assert.equal(ownsAction(loop({ owner: "Josh Farmer" })), false);
  });

  it("person is NOT owner — a counterparty named Mark does not open the gate", () => {
    // "Send the MNDA to Mark's lawyer" is not automatically Mark's action, and
    // more to the point: person has never meant owner. Reading it as one is the
    // exact bug. Only the owner field decides.
    assert.equal(ownsAction(loop({ person: "Mark" })), false);
  });

  it("BURN: the Haley/Colombia loop produces NO task", () => {
    const haley = loop({
      id: "colombia-sponsorship-pool",
      topic: "Check current Colombia sponsorship pool/availability and report back to Josh and Joey",
      person: "Haley",
    });
    const decision = reconcileTasks({ loops: [haley], tasks: [], state: { loopToTask: {} } });
    assert.equal(decision.creates.length, 0, "Haley checks the pool, not Mark");
    assert.equal(decision.skippedNotMarks.length, 1);
    assert.equal(decision.skippedNotMarks[0].id, "colombia-sponsorship-pool");
  });

  it("BURN: Mark's own reach-out DOES produce a task", () => {
    // The narrow exception: he said in the meeting that he would check in.
    const reachOut = loop({
      id: "check-in-haley-colombia",
      topic: "Check in with Haley on the Colombia pool",
      person: "Haley",
      owner: "mark",
    });
    const decision = reconcileTasks({ loops: [reachOut], tasks: [], state: { loopToTask: {} } });
    assert.equal(decision.creates.length, 1);
    assert.equal(decision.skippedNotMarks.length, 0);
    assert.equal(formatTaskTitle(decision.creates[0]), "Check in with Haley on the Colombia pool");
  });

  it("the gate also covers the stale-completed-leftover create path", () => {
    // A leftover completed task normally makes the reconciler mirror the loop
    // afresh. That path must be gated too, or it becomes a back door.
    const notMine = loop({ id: "x", topic: "Josh confirms the Cambodia budget", owner: "Josh" });
    const leftover = baseTask({ id: "old", loopId: "x", status: "completed" });
    const decision = reconcileTasks({
      loops: [notMine],
      tasks: [leftover],
      state: { loopToTask: {} },
    });
    assert.equal(decision.creates.length, 0);
    assert.equal(decision.skippedNotMarks.length, 1);
  });

  it("a withheld loop is NOT dropped and NOT closed — it stays tracked in open-loops", () => {
    const notMine = loop({ id: "x", owner: "Haley" });
    const decision = reconcileTasks({ loops: [notMine], tasks: [], state: { loopToTask: {} } });
    assert.equal(decision.drops.length, 0);
    assert.equal(decision.closures.length, 0);
  });

  it("withholding is not a failure — exit code stays 0 and the summary says so", () => {
    const r = { closures: 0, drops: 0, creates: 0, createFailures: 0, skippedNotMarks: 3 };
    assert.equal(exitCodeForResult(r), 0);
    assert.match(formatRunSummary(r, new Date("2026-08-18T12:00:00Z")), /notMarks=3/);
  });
});
