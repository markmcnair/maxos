import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractLoopId, notesWithLoopMarker, stripGwsHeaderNoise } from "../src/google-tasks.js";

describe("extractLoopId", () => {
  it("pulls a loop id from notes containing the marker", () => {
    assert.equal(extractLoopId("[loop:rachel-newlywed-basket]"), "rachel-newlywed-basket");
  });

  it("pulls the id even when surrounded by free text", () => {
    const notes = "[loop:kr-wholesale]\n\nFirst seen: 2026-04-09\n\nCreated by MaxOS.";
    assert.equal(extractLoopId(notes), "kr-wholesale");
  });

  it("returns null when no marker is present", () => {
    assert.equal(extractLoopId("just some notes Mark wrote"), null);
  });

  it("returns null on undefined / empty", () => {
    assert.equal(extractLoopId(undefined), null);
    assert.equal(extractLoopId(""), null);
  });

  it("tolerates dots and hyphens in ids", () => {
    assert.equal(extractLoopId("[loop:mike.salem-mnda_v2]"), "mike.salem-mnda_v2");
  });
});

describe("notesWithLoopMarker", () => {
  it("prepends the marker on its own when freeText is empty", () => {
    assert.equal(notesWithLoopMarker("rachel"), "[loop:rachel]");
  });

  it("prepends the marker with freeText below it", () => {
    const out = notesWithLoopMarker("kr-wholesale", "First seen: 2026-04-09");
    assert.equal(out, "[loop:kr-wholesale]\n\nFirst seen: 2026-04-09");
  });

  it("trims whitespace-only freeText to nothing", () => {
    assert.equal(notesWithLoopMarker("x", "   "), "[loop:x]");
  });

  it("round-trips through extractLoopId", () => {
    const id = "joey-cook-chris-kear";
    assert.equal(extractLoopId(notesWithLoopMarker(id, "any free text")), id);
  });
});

describe("stripGwsHeaderNoise", () => {
  it("strips the keyring backend status line", () => {
    const raw = `Using keyring backend: keyring\n{"items":[]}`;
    assert.equal(stripGwsHeaderNoise(raw), `{"items":[]}`);
  });

  it("returns the JSON if no header noise", () => {
    assert.equal(stripGwsHeaderNoise(`{"x":1}`), `{"x":1}`);
  });

  it("handles array responses", () => {
    const raw = `Using keyring backend: keyring\n[{"a":1}]`;
    assert.equal(stripGwsHeaderNoise(raw), `[{"a":1}]`);
  });

  it("returns empty string when no JSON structure present", () => {
    assert.equal(stripGwsHeaderNoise(`Using keyring backend: keyring\nno json here`), "");
  });

  it("skips a [WARN]-style preamble line that starts with [ but isn't JSON", () => {
    // Defends against a future gws release adding a deprecation/auth-warning
    // preamble — the old impl would mis-pick `[WARN]` as the start of JSON.
    const raw = `[WARN] credentials expire in 30 days\n[{"task":"x"}]`;
    assert.equal(stripGwsHeaderNoise(raw), `[{"task":"x"}]`);
  });

  it("returns empty when no candidate line parses as valid JSON", () => {
    const raw = `[WARN] something\nstill not json`;
    assert.equal(stripGwsHeaderNoise(raw), "");
  });
});
