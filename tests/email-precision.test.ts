import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePrecisionWindow,
  formatPrecisionDigestLine,
  type PrecisionWindow,
} from "../src/email-precision.js";
import type { TrainingRunRecord } from "../src/email-triage-telemetry.js";

function writeRuns(home: string, records: TrainingRunRecord[]) {
  mkdirSync(join(home, ".config", "email-triage"), { recursive: true });
  writeFileSync(
    join(home, ".config", "email-triage", "training-runs.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

describe("computePrecisionWindow", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ep-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns insufficient-data marker when no runs in window", () => {
    const r = computePrecisionWindow(home, Date.now(), 30);
    assert.equal(r.insufficient, true);
    assert.equal(r.totalEmails, 0);
  });

  it("computes precision per bucket from runs that have totalsByBucket", () => {
    const now = Date.parse("2026-05-05T22:00:00Z");
    writeRuns(home, [
      {
        date: "2026-05-04",
        ranAt: "2026-05-04T22:00:00Z",
        correctionsFound: 2,
        corrections: [
          { from: "a", subject: "x", originalBucket: "see-mail", correctedBucket: "delete" },
          { from: "b", subject: "y", originalBucket: "delete", correctedBucket: "see-mail" },
        ],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        totalTriaged: 26,
        totalsByBucket: { "re-mail": 5, "see-mail": 8, archive: 8, delete: 5 },
      },
      {
        date: "2026-05-05",
        ranAt: "2026-05-05T22:00:00Z",
        correctionsFound: 1,
        corrections: [
          { from: "c", subject: "z", originalBucket: "delete", correctedBucket: "see-mail" },
        ],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        totalTriaged: 30,
        totalsByBucket: { "re-mail": 6, "see-mail": 9, archive: 10, delete: 5 },
      },
    ]);

    const r = computePrecisionWindow(home, now, 30);
    assert.equal(r.insufficient, false);
    assert.equal(r.totalEmails, 56);
    assert.equal(r.totalCorrections, 3);
    // see-mail: 8+9 = 17 triaged, 1 corrected → precision 16/17
    assert.equal(r.byBucket["see-mail"]?.triaged, 17);
    assert.equal(r.byBucket["see-mail"]?.corrected, 1);
    assert.ok(Math.abs(r.byBucket["see-mail"]!.precision - 16 / 17) < 0.001);
    // delete: 5+5 = 10 triaged, 2 corrected → precision 8/10
    assert.equal(r.byBucket.delete?.triaged, 10);
    assert.equal(r.byBucket.delete?.corrected, 2);
  });

  it("excludes runs older than window", () => {
    const now = Date.parse("2026-06-15T22:00:00Z");
    writeRuns(home, [
      {
        date: "2026-04-01",
        ranAt: "2026-04-01T22:00:00Z",
        correctionsFound: 99,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        totalTriaged: 1000,
        totalsByBucket: { "see-mail": 1000 },
      },
      {
        date: "2026-06-10",
        ranAt: "2026-06-10T22:00:00Z",
        correctionsFound: 1,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        totalTriaged: 10,
        totalsByBucket: { "see-mail": 10 },
      },
    ]);
    // 30-day window from 2026-06-15: only the 2026-06-10 record is inside
    const r = computePrecisionWindow(home, now, 30);
    assert.equal(r.totalEmails, 10);
  });

  it("ignores runs missing totalTriaged (pre-Round-S records)", () => {
    const now = Date.parse("2026-05-05T22:00:00Z");
    writeRuns(home, [
      {
        date: "2026-05-04",
        ranAt: "2026-05-04T22:00:00Z",
        correctionsFound: 1,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        // No totalTriaged
      },
      {
        date: "2026-05-05",
        ranAt: "2026-05-05T22:00:00Z",
        correctionsFound: 0,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        totalTriaged: 20,
        totalsByBucket: { "see-mail": 20 },
      },
    ]);
    const r = computePrecisionWindow(home, now, 30);
    assert.equal(r.totalEmails, 20, "pre-Round-S record should be excluded");
  });

  it("aggregates rule coverage when present", () => {
    const now = Date.parse("2026-05-05T22:00:00Z");
    writeRuns(home, [
      {
        date: "2026-05-05",
        ranAt: "2026-05-05T22:00:00Z",
        correctionsFound: 0,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        totalTriaged: 26,
        totalsByBucket: { "see-mail": 8, delete: 5, archive: 8, "re-mail": 5 },
        ruleCoverage: { ruleDecided: 18, lowConfidenceRule: 3, llmFallback: 5 },
      },
    ]);
    const r = computePrecisionWindow(home, now, 30);
    assert.equal(r.ruleCoverage.ruleDecided, 18);
    assert.equal(r.ruleCoverage.llmFallback, 5);
  });
});

describe("formatPrecisionDigestLine", () => {
  it("formats bucket precision as percentages", () => {
    const w: PrecisionWindow = {
      insufficient: false,
      totalEmails: 100,
      totalCorrections: 4,
      windowDays: 30,
      byBucket: {
        "re-mail": { triaged: 25, corrected: 0, precision: 1.0 },
        "see-mail": { triaged: 30, corrected: 1, precision: 29 / 30 },
        archive: { triaged: 30, corrected: 1, precision: 29 / 30 },
        delete: { triaged: 15, corrected: 2, precision: 13 / 15 },
      },
      ruleCoverage: { ruleDecided: 75, lowConfidenceRule: 10, llmFallback: 15 },
    };
    const line = formatPrecisionDigestLine(w);
    assert.match(line, /see-mail/);
    assert.match(line, /\d+%/);
    assert.match(line, /30d|window/i);
  });

  it("returns a benign placeholder when insufficient data", () => {
    const w: PrecisionWindow = {
      insufficient: true,
      totalEmails: 0,
      totalCorrections: 0,
      windowDays: 30,
      byBucket: {},
      ruleCoverage: { ruleDecided: 0, lowConfidenceRule: 0, llmFallback: 0 },
    };
    const line = formatPrecisionDigestLine(w);
    assert.match(line, /(insufficient|no data|not yet)/i);
  });
});
