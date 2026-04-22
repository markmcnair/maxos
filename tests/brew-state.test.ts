import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readBrewState,
  writeBrewState,
  emptyState,
  advanceBreadcrumb,
  rotateTopic,
  tickStreak,
  type BrewState,
} from "../src/brew-state.js";

describe("brew-state", () => {
  let tmp: string;
  let p: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "brew-state-"));
    p = join(tmp, "state.json");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("emptyState returns a fresh state", () => {
    const s = emptyState();
    assert.equal(s.current_track, null);
    assert.equal(s.new_topic_streak, 0);
    assert.equal(s.awaiting_response, false);
  });

  it("writes and reads state round-trip", () => {
    const s = emptyState();
    s.new_topic_streak = 3;
    writeBrewState(p, s);
    const loaded = readBrewState(p);
    assert.equal(loaded.new_topic_streak, 3);
  });

  it("readBrewState returns emptyState when file missing", () => {
    const s = readBrewState(p);
    assert.deepEqual(s, emptyState());
  });

  it("advanceBreadcrumb appends to delivered list and clears next_planned", () => {
    const s: BrewState = {
      ...emptyState(),
      current_track: {
        topic: "RAG",
        started: "2026-04-19",
        breadcrumbs_delivered: [],
        next_planned: { type: "video", intent: "first intro" },
      },
    };
    const updated = advanceBreadcrumb(s, {
      date: "2026-04-19",
      type: "video",
      url: "https://youtu.be/x",
      title: "RAG 101",
      why_picked: "top tier channel",
    });
    assert.equal(updated.current_track?.breadcrumbs_delivered.length, 1);
    assert.equal(updated.current_track?.next_planned, null);
  });

  it("rotateTopic promotes alternative and resets delivered", () => {
    const s: BrewState = {
      ...emptyState(),
      current_track: { topic: "RAG", started: "2026-04-19", breadcrumbs_delivered: [], next_planned: null },
      alternative_offered: { topic: "Vectors", one_line_pitch: "up next", why_picked: "QMD match" },
    };
    const updated = rotateTopic(s, "2026-04-22");
    assert.equal(updated.current_track?.topic, "Vectors");
    assert.equal(updated.current_track?.breadcrumbs_delivered.length, 0);
    assert.equal(updated.alternative_offered, null);
  });

  it("tickStreak increments on switch, resets on continue", () => {
    const s = { ...emptyState(), new_topic_streak: 2 };
    assert.equal(tickStreak(s, "switch").new_topic_streak, 3);
    assert.equal(tickStreak(s, "continue").new_topic_streak, 0);
    assert.equal(tickStreak(s, "hold").new_topic_streak, 2);
  });
});
