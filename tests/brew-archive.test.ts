import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchive, readArchive, type DailyArchive } from "../src/brew-archive.js";

describe("brew-archive", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "archive-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes and reads a daily snapshot", () => {
    const snap: DailyArchive = {
      date: "2026-04-22",
      ai: { headline: "h", url: "u", source: "github", score: 4.2 },
      prime: { headline: "p", built: true, prototypeUrl: "pu" },
      learning: { topic: "RAG", day: 3, breadcrumbUrl: "b", alternative: "Vectors" },
      streak: 0,
      feedbackAppliedFrom: null,
    };
    writeArchive(tmp, snap);
    const read = readArchive(join(tmp, "2026-04-22.json"));
    assert.deepEqual(read, snap);
  });

  it("returns null on missing archive", () => {
    assert.equal(readArchive(join(tmp, "nope.json")), null);
  });
});
