import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listTasks, createTaskForLoop, type GwsExec } from "../src/google-tasks.js";

/**
 * Regression suite for the 2026-08-09 pagination data-loss bug.
 *
 * listTasks asked for maxResults:100 and ignored nextPageToken. Mark's
 * "‼️ Priority Bucket" holds 255 tasks, so the reconciler only ever saw the
 * first 100 — and returned ok:true, which is indistinguishable from "that is
 * the whole list." Any tracked loop whose task sat past position 100 read as
 * "Mark deleted it" and got DROPPED with a permanent tombstone in
 * dropped-loops.md. Five loops died that way on 2026-07-07, five days after
 * the switch from the small dedicated list into the 255-task Priority Bucket.
 */

/**
 * Fail-closed gws binary name for every test in this file.
 *
 * These tests inject a fake `exec`, but an injected seam only protects you if
 * the code under test actually honours it. While this suite was first run RED,
 * `createTaskForLoop` did not yet accept `exec` — it ignored the fake and
 * called the REAL Tasks API, creating three junk "[loop:some-loop]" tasks in
 * Mark's live Priority Bucket. Naming a binary that cannot exist means the
 * worst case is ENOENT against a nonexistent command instead of a write to
 * Mark's account. Never point a test at "gws-personal".
 */
const FAKE_GWS = "gws-DOES-NOT-EXIST-test-only";

/** Build a page of N tasks with ids prefixed by the page label. */
function page(label: string, count: number, nextPageToken?: string): string {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `${label}-task-${i}`,
    title: `${label} task ${i}`,
    notes: `[loop:${label}-loop-${i}]`,
    status: "needsAction",
    updated: "2026-08-09T12:00:00Z",
  }));
  return JSON.stringify(nextPageToken ? { items, nextPageToken } : { items });
}

/** Record every call so tests can assert the pageToken wiring. */
function recordingExec(pages: string[]): { exec: GwsExec; calls: string[][] } {
  const calls: string[][] = [];
  let n = 0;
  const exec: GwsExec = async (args) => {
    calls.push(args);
    const out = pages[Math.min(n, pages.length - 1)];
    n++;
    return out;
  };
  return { exec, calls };
}

/** Pull the --params JSON object out of a recorded gws argv. */
function paramsOf(args: string[]): Record<string, unknown> {
  const i = args.indexOf("--params");
  assert.ok(i >= 0, "expected --params in gws argv");
  return JSON.parse(args[i + 1]);
}

describe("listTasks pagination (regression: 155 invisible tasks)", () => {
  it("follows nextPageToken and returns tasks from EVERY page", async () => {
    const { exec } = recordingExec([
      page("p1", 100, "TOKEN-2"),
      page("p2", 100, "TOKEN-3"),
      page("p3", 55),
    ]);
    const res = await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // 100 + 100 + 55 = 255 — the real size of Mark's Priority Bucket.
    assert.equal(res.tasks.length, 255);
    assert.ok(
      res.tasks.some((t) => t.id === "p3-task-54"),
      "a task on the LAST page must be visible — this is the loop that used to get dropped",
    );
  });

  it("sends the pageToken it was handed on each subsequent request", async () => {
    const { exec, calls } = recordingExec([
      page("p1", 100, "TOKEN-2"),
      page("p2", 100, "TOKEN-3"),
      page("p3", 1),
    ]);
    await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.equal(calls.length, 3, "expected exactly three requests");
    assert.equal(paramsOf(calls[0]).pageToken, undefined, "first call must not send a pageToken");
    assert.equal(paramsOf(calls[1]).pageToken, "TOKEN-2");
    assert.equal(paramsOf(calls[2]).pageToken, "TOKEN-3");
  });

  it("keeps tasklist/showCompleted/showHidden on every page, not just the first", async () => {
    const { exec, calls } = recordingExec([page("p1", 2, "TOKEN-2"), page("p2", 1)]);
    await listTasks("@default", FAKE_GWS, 10_000, exec);
    for (const args of calls) {
      const p = paramsOf(args);
      assert.equal(p.tasklist, "@default");
      assert.equal(p.showCompleted, true);
      assert.equal(p.showHidden, true);
    }
  });

  it("returns ok:false when a LATER page fails — never a partial list as ok:true", async () => {
    let n = 0;
    const exec: GwsExec = async () => {
      n++;
      if (n === 1) return page("p1", 100, "TOKEN-2");
      throw new Error("dns error: failed to lookup address information");
    };
    const res = await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.equal(
      res.ok,
      false,
      "a partial list MUST NOT be reported as ok:true — that is the mass-drop trigger",
    );
    if (res.ok) return;
    assert.match(res.error, /dns error/);
  });

  it("returns ok:false when a later page is unparseable rather than truncating silently", async () => {
    let n = 0;
    const exec: GwsExec = async () => {
      n++;
      return n === 1 ? page("p1", 100, "TOKEN-2") : "Using keyring backend: keyring\nnot json";
    };
    const res = await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.equal(res.ok, false);
  });

  it("stops instead of looping forever when the API repeats the same token", async () => {
    let n = 0;
    const exec: GwsExec = async () => {
      n++;
      return page(`p${n}`, 1, "SAME-TOKEN");
    };
    const res = await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.ok(n < 50, `expected a pagination guard to stop the loop, made ${n} requests`);
    assert.equal(res.ok, false, "a repeated pageToken means we cannot trust the list");
  });

  it("still handles a single-page list with no nextPageToken", async () => {
    const { exec, calls } = recordingExec([page("only", 7)]);
    const res = await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.tasks.length, 7);
    assert.equal(calls.length, 1, "no extra request when there is no nextPageToken");
  });

  it("strips gws header noise on every page, not just the first", async () => {
    const { exec } = recordingExec([
      `Using keyring backend: keyring\n${page("p1", 2, "TOKEN-2")}`,
      `Using keyring backend: keyring\n${page("p2", 3)}`,
    ]);
    const res = await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.tasks.length, 5);
  });

  it("treats a first-page failure as ok:false (unchanged behaviour)", async () => {
    const exec: GwsExec = async () => {
      throw new Error("spawn gws-personal ENOENT");
    };
    const res = await listTasks("@default", FAKE_GWS, 10_000, exec);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /ENOENT/);
  });
});

describe("createTaskForLoop error visibility", () => {
  it("reports the failure reason instead of swallowing it in a bare catch", async () => {
    const seen: string[] = [];
    const exec: GwsExec = async () => {
      throw new Error("error[auth]: Authentication failed: Failed to get token");
    };
    const id = await createTaskForLoop("test-only-loop", "TEST ONLY — must never reach the API", {
      gws: FAKE_GWS,
      exec,
      onError: (msg) => seen.push(msg),
    });
    assert.equal(id, null);
    assert.equal(seen.length, 1, "a swallowed create failure is invisible to every monitor");
    assert.match(seen[0], /Authentication failed/);
  });

  it("reports a failure when stdout carries no parseable JSON", async () => {
    const seen: string[] = [];
    const exec: GwsExec = async () => "Using keyring backend: keyring\n";
    const id = await createTaskForLoop("test-only-loop", "TEST ONLY — must never reach the API", {
      gws: FAKE_GWS,
      exec,
      onError: (msg) => seen.push(msg),
    });
    assert.equal(id, null);
    assert.equal(seen.length, 1);
  });

  it("returns the new task id and reports nothing on success", async () => {
    const seen: string[] = [];
    const exec: GwsExec = async () => JSON.stringify({ id: "created-123" });
    const id = await createTaskForLoop("test-only-loop", "TEST ONLY — must never reach the API", {
      gws: FAKE_GWS,
      exec,
      onError: (msg) => seen.push(msg),
    });
    assert.equal(id, "created-123");
    assert.equal(seen.length, 0);
  });
});
