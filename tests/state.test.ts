import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../src/state.js";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("StateStore", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maxos-state-"));
    store = new StateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("initializes with empty state when no file exists", () => {
    const state = store.load();
    assert.deepEqual(state.sessions, {});
    assert.deepEqual(state.scheduler, { failures: {}, disabled: [], lastRun: {} });
  });

  it("saves and loads state roundtrip", () => {
    store.update((s) => {
      s.sessions["main"] = {
        claudeSessionId: "abc",
        lastActivity: Date.now(),
        messageCount: 5,
      };
    });
    store.flush();
    const store2 = new StateStore(dir);
    const loaded = store2.load();
    assert.equal(loaded.sessions["main"]?.claudeSessionId, "abc");
    assert.equal(loaded.sessions["main"]?.messageCount, 5);
  });

  it("appends to crash journal", () => {
    store.journalAppend("test_event", { detail: "something" });
    store.journalAppend("test_event_2", {});
    const journalPath = join(dir, "crash.log");
    assert.ok(existsSync(journalPath));
    const lines = readFileSync(journalPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "test_event");
    assert.equal(entry.detail, "something");
    assert.ok(entry.ts > 0);
  });

  it("getLastJournalEvent returns the most recent entry", () => {
    store.journalAppend("daemon_start", { recovery: "clean" });
    store.journalAppend("daemon_stop", { reason: "shutdown" });
    const last = store.getLastJournalEvent();
    assert.ok(last);
    assert.equal(last.event, "daemon_stop");
    assert.ok(last.ts > 0);
  });

  it("getLastJournalEvent returns null when no journal exists", () => {
    assert.equal(store.getLastJournalEvent(), null);
  });

  it("trims crash journal to max entries", () => {
    for (let i = 0; i < 5; i++) {
      store.journalAppend(`event_${i}`, {});
    }
    store.journalTrim(3);
    const lines = readFileSync(join(dir, "crash.log"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.ok(JSON.parse(lines[0]).event === "event_2"); // kept last 3
  });
});
