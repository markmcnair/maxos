import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { parseTimeToTimestamp } from "../src/utils/time.js";
import type { PendingOneShot } from "../src/state.js";

// --- parseTimeToTimestamp ---

describe("parseTimeToTimestamp", () => {
  it("parses 12-hour AM/PM format", () => {
    const ts = parseTimeToTimestamp("9:57pm");
    assert.ok(ts, "should return a timestamp");
    const d = new Date(ts);
    assert.equal(d.getHours(), 21);
    assert.equal(d.getMinutes(), 57);
  });

  it("parses 12-hour format with space before am/pm", () => {
    const ts = parseTimeToTimestamp("9:57 pm");
    assert.ok(ts, "should return a timestamp");
    const d = new Date(ts);
    assert.equal(d.getHours(), 21);
    assert.equal(d.getMinutes(), 57);
  });

  it("parses 24-hour military format", () => {
    const ts = parseTimeToTimestamp("14:30");
    assert.ok(ts, "should return a timestamp");
    const d = new Date(ts);
    assert.equal(d.getHours(), 14);
    assert.equal(d.getMinutes(), 30);
  });

  it("handles 12:00am as midnight", () => {
    const ts = parseTimeToTimestamp("12:00am");
    assert.ok(ts, "should return a timestamp");
    const d = new Date(ts);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  });

  it("handles 12:00pm as noon", () => {
    const ts = parseTimeToTimestamp("12:00pm");
    assert.ok(ts, "should return a timestamp");
    const d = new Date(ts);
    assert.equal(d.getHours(), 12);
    assert.equal(d.getMinutes(), 0);
  });

  it("returns null for invalid input", () => {
    assert.equal(parseTimeToTimestamp("banana"), null);
    assert.equal(parseTimeToTimestamp("25:00"), null);
    assert.equal(parseTimeToTimestamp(""), null);
  });

  it("rolls to tomorrow if time already passed", () => {
    const now = new Date();
    // Use a time that's definitely in the past (1 hour ago)
    const pastHour = (now.getHours() - 1 + 24) % 24;
    const timeStr = `${pastHour}:${String(now.getMinutes()).padStart(2, "0")}`;
    const ts = parseTimeToTimestamp(timeStr);
    assert.ok(ts, "should return a timestamp");
    assert.ok(ts > now.getTime(), "timestamp should be in the future (tomorrow)");
  });
});

// --- Scheduler one-shot methods ---

describe("Scheduler one-shot", () => {
  let scheduler: Scheduler;
  let runResults: Array<{ prompt: string; taskName: string }>;
  let deliveredResults: Array<{ result: string; taskName: string }>;
  let alerts: string[];
  let stateCallbackShots: PendingOneShot[] | null;

  beforeEach(() => {
    runResults = [];
    deliveredResults = [];
    alerts = [];
    stateCallbackShots = null;

    scheduler = new Scheduler(
      3, // maxConcurrent
      3, // circuitBreakerThreshold
      [], // no protected windows
      async (prompt, taskName) => {
        runResults.push({ prompt, taskName });
        return `Result for: ${prompt}`;
      },
      async (result, taskName) => {
        deliveredResults.push({ result, taskName });
      },
      async (msg) => {
        alerts.push(msg);
      },
    );

    scheduler.onOneShotChange((shots) => {
      stateCallbackShots = [...shots];
    });
  });

  it("addOneShot creates a pending one-shot with unique ID", () => {
    const id = scheduler.addOneShot(Date.now() + 60_000, "Test prompt");
    assert.ok(id, "should return an ID");
    assert.equal(typeof id, "string");
    assert.equal(id.length, 8); // 4 random bytes = 8 hex chars

    const pending = scheduler.getPendingOneShots();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, id);
    assert.equal(pending[0].prompt, "Test prompt");
    assert.equal(pending[0].silent, false);
  });

  it("addOneShot with silent flag", () => {
    scheduler.addOneShot(Date.now() + 60_000, "Silent task", true);
    const pending = scheduler.getPendingOneShots();
    assert.equal(pending[0].silent, true);
  });

  it("addOneShot triggers state callback", () => {
    scheduler.addOneShot(Date.now() + 60_000, "Test");
    assert.ok(stateCallbackShots, "callback should have fired");
    assert.equal(stateCallbackShots!.length, 1);
  });

  it("removeOneShot removes by ID", () => {
    const id = scheduler.addOneShot(Date.now() + 60_000, "To remove");
    assert.equal(scheduler.getPendingOneShots().length, 1);

    const removed = scheduler.removeOneShot(id);
    assert.equal(removed, true);
    assert.equal(scheduler.getPendingOneShots().length, 0);
  });

  it("removeOneShot returns false for nonexistent ID", () => {
    assert.equal(scheduler.removeOneShot("nonexistent"), false);
  });

  it("loadOneShots restores persisted state", () => {
    const shots: PendingOneShot[] = [
      { id: "abc123", fireAt: Date.now() + 60_000, prompt: "Restored", silent: false, createdAt: Date.now() },
    ];
    scheduler.loadOneShots(shots);
    const pending = scheduler.getPendingOneShots();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "abc123");
  });

  it("getPendingOneShots returns a copy, not a reference", () => {
    scheduler.addOneShot(Date.now() + 60_000, "Test");
    const a = scheduler.getPendingOneShots();
    const b = scheduler.getPendingOneShots();
    assert.notEqual(a, b); // different array references
    assert.deepEqual(a, b); // same content
  });

  it("multiple one-shots get unique IDs", () => {
    const id1 = scheduler.addOneShot(Date.now() + 60_000, "First");
    const id2 = scheduler.addOneShot(Date.now() + 60_000, "Second");
    assert.notEqual(id1, id2);
    assert.equal(scheduler.getPendingOneShots().length, 2);
  });

  it("stopAll clears the one-shot interval", () => {
    scheduler.startOneShotLoop();
    scheduler.stopAll(); // should not throw
    // After stopAll, adding a one-shot should still work (data structure intact)
    scheduler.addOneShot(Date.now() + 60_000, "After stop");
    assert.equal(scheduler.getPendingOneShots().length, 1);
  });
});
