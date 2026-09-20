import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchive, readArchive, learningTopicOf, type DailyArchive } from "../src/brew-archive.js";

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
    // writeArchive stamps a deterministic topicKey; everything else round-trips.
    assert.equal(read!.learning!.topicKey, "rag");
    assert.deepEqual(
      { ...read, learning: { ...read!.learning, topicKey: undefined } },
      { ...snap, learning: { ...snap.learning, topicKey: undefined } },
    );
  });

  it("stamps a stable topicKey so a repeated subject is countable", () => {
    const mk = (date: string, topic: string): DailyArchive => ({
      date,
      ai: { headline: "h", url: "u", source: "github", score: 4 },
      learning: { topic },
      feedbackAppliedFrom: null,
    });
    writeArchive(tmp, mk("2026-09-01", "RUES — Colombia national commercial registry"));
    writeArchive(tmp, mk("2026-09-02", "rues colombia national commercial registry"));
    const a = readArchive(join(tmp, "2026-09-01.json"))!;
    const b = readArchive(join(tmp, "2026-09-02.json"))!;
    assert.equal(a.learning!.topicKey, b.learning!.topicKey);
    assert.equal(a.learning!.topicKey, "rues-colombia-national-commercial-registry");
  });

  it("reads a modern archive that has no prime and no streak", () => {
    const snap: DailyArchive = {
      date: "2026-09-06",
      ai: { headline: "h", url: "u", source: "Hacker News", score: 4.8 },
      learning: { topic: "RUES", url: "https://www.rues.org.co/", why: "track B" },
      feedbackAppliedFrom: null,
    };
    writeArchive(tmp, snap);
    const read = readArchive(join(tmp, "2026-09-06.json"))!;
    assert.equal(read.prime, undefined);
    assert.equal(read.streak, undefined);
    assert.equal(learningTopicOf(read), "RUES");
  });

  it("returns null on missing archive", () => {
    assert.equal(readArchive(join(tmp, "nope.json")), null);
  });
});
