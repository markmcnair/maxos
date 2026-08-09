import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runGoogleTasksReconciler,
  exitCodeForResult,
  formatRunSummary,
} from "../src/google-tasks-reconciler.js";
import type { ListTasksResult } from "../src/google-tasks.js";

/**
 * Regression suite for the 2026-08-09 "reports healthy while doing nothing"
 * defects:
 *   1. a failed run exited 0, so cron recorded exit=0 and every monitor
 *      read it as success;
 *   2. the reported creates count was the PRE-API intent, so "creates=2"
 *      could mean two API calls that both silently returned null;
 *   3. a healthy run wrote zero bytes, making log silence indistinguishable
 *      from a dead job.
 */

let home: string;

const loop = (id: string, topic: string) => ({
  id,
  topic,
  firstSeen: "2026-08-01",
  lastUpdated: "2026-08-08",
});

function seed(loops: ReturnType<typeof loop>[], state: Record<string, string> = {}) {
  const memory = join(home, "workspace", "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "open-loops.json"), JSON.stringify(loops, null, 2));
  writeFileSync(
    join(memory, "google-tasks-state.json"),
    JSON.stringify({ loopToTask: state }, null, 2),
  );
}

const okEmpty: ListTasksResult = { ok: true, tasks: [] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gtasks-honesty-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("exitCodeForResult", () => {
  it("returns 0 for a clean run", () => {
    assert.equal(exitCodeForResult({ closures: 0, drops: 0, creates: 0 }), 0);
  });

  it("returns 1 when the run was skipped — cron must not record exit=0", () => {
    assert.equal(
      exitCodeForResult({
        closures: 0,
        drops: 0,
        creates: 0,
        skippedReason: "listTasks failed: dns error",
      }),
      1,
    );
  });

  it("returns 1 when some task creations failed", () => {
    assert.equal(
      exitCodeForResult({ closures: 0, drops: 0, creates: 1, createFailures: 2 }),
      1,
    );
  });

  it("returns 0 when work happened and nothing failed", () => {
    assert.equal(
      exitCodeForResult({ closures: 1, drops: 1, creates: 3, createFailures: 0 }),
      0,
    );
  });
});

describe("formatRunSummary", () => {
  const at = new Date("2026-08-09T17:22:33.000Z");

  it("stamps every line with an ISO timestamp so failure windows are knowable", () => {
    const line = formatRunSummary({ closures: 0, drops: 0, creates: 0 }, at);
    assert.match(line, /^2026-08-09T17:22:33/, `expected a leading timestamp, got: ${line}`);
  });

  it("emits a line even for a no-op run so silence never means 'dead'", () => {
    const line = formatRunSummary({ closures: 0, drops: 0, creates: 0 }, at);
    assert.ok(line.trim().length > 0);
    assert.match(line, /closures=0/);
    assert.match(line, /creates=0/);
  });

  it("surfaces createFailures in the summary when creations failed", () => {
    const line = formatRunSummary(
      { closures: 0, drops: 0, creates: 1, createFailures: 2 },
      at,
    );
    assert.match(line, /createFailures=2/);
  });

  it("marks a skipped run explicitly", () => {
    const line = formatRunSummary(
      { closures: 0, drops: 0, creates: 0, skippedReason: "listTasks failed: dns error" },
      at,
    );
    assert.match(line, /skipped/i);
    assert.match(line, /dns error/);
  });
});

describe("runGoogleTasksReconciler — honest creates accounting", () => {
  it("counts only tasks the API actually created, not the ones it intended to", async () => {
    seed([loop("a", "Loop A"), loop("b", "Loop B")]);
    const res = await runGoogleTasksReconciler({
      maxosHome: home,
      deps: {
        listTasks: async () => okEmpty,
        // Both creations fail the way the live bare-catch path does.
        createTaskForLoop: async () => null,
      },
    });
    assert.equal(res.creates, 0, "two null returns must not be reported as two creates");
    assert.equal(res.createFailures, 2);
  });

  it("reports a mixed run accurately", async () => {
    seed([loop("a", "Loop A"), loop("b", "Loop B")]);
    let n = 0;
    const res = await runGoogleTasksReconciler({
      maxosHome: home,
      deps: {
        listTasks: async () => okEmpty,
        createTaskForLoop: async () => (++n === 1 ? "real-task-id" : null),
      },
    });
    assert.equal(res.creates, 1);
    assert.equal(res.createFailures, 1);
  });

  it("a fully successful run reports zero createFailures", async () => {
    seed([loop("a", "Loop A")]);
    const res = await runGoogleTasksReconciler({
      maxosHome: home,
      deps: {
        listTasks: async () => okEmpty,
        createTaskForLoop: async () => "real-task-id",
      },
    });
    assert.equal(res.creates, 1);
    assert.equal(res.createFailures, 0);
    const state = JSON.parse(
      readFileSync(join(home, "workspace", "memory", "google-tasks-state.json"), "utf-8"),
    );
    assert.equal(state.loopToTask.a, "real-task-id");
  });

  it("a failed creation is NOT recorded in state, so the next run retries it", async () => {
    seed([loop("a", "Loop A")]);
    await runGoogleTasksReconciler({
      maxosHome: home,
      deps: { listTasks: async () => okEmpty, createTaskForLoop: async () => null },
    });
    const state = JSON.parse(
      readFileSync(join(home, "workspace", "memory", "google-tasks-state.json"), "utf-8"),
    );
    assert.equal(state.loopToTask.a, undefined);
  });

  it("still refuses to mutate anything when listTasks fails", async () => {
    seed([loop("a", "Loop A")], { a: "existing-task" });
    const before = readFileSync(
      join(home, "workspace", "memory", "google-tasks-state.json"),
      "utf-8",
    );
    const res = await runGoogleTasksReconciler({
      maxosHome: home,
      deps: {
        listTasks: async () => ({ ok: false, error: "dns error" }),
        createTaskForLoop: async () => {
          throw new Error("must not be called when the list lookup failed");
        },
      },
    });
    assert.ok(res.skippedReason);
    assert.equal(exitCodeForResult(res), 1);
    assert.equal(
      readFileSync(join(home, "workspace", "memory", "google-tasks-state.json"), "utf-8"),
      before,
      "state must be byte-identical after a skipped run",
    );
    assert.equal(
      existsSync(join(home, "workspace", "memory", "dropped-loops.md")),
      false,
      "a skipped run must never write a drop tombstone",
    );
  });
});
