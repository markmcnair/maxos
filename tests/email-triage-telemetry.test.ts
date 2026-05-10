import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordTrainingRun,
  loadRecentTrainingRuns,
  summarizeForDigest,
  formatDigestLine,
  type TrainingRunRecord,
} from "../src/email-triage-telemetry.js";

describe("recordTrainingRun", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "etriage-tel-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates ~/.config/email-triage/training-runs.jsonl when missing and writes one record", () => {
    recordTrainingRun(home, {
      date: "2026-05-05",
      ranAt: "2026-05-05T22:01:00.000Z",
      correctionsFound: 0,
      corrections: [],
      rulesAdded: 0,
      rulesRetired: 0,
      skillUpdated: false,
      reason: "no daily-log.json found",
    });
    const path = join(home, ".config", "email-triage", "training-runs.jsonl");
    assert.ok(existsSync(path));
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as TrainingRunRecord;
    assert.equal(parsed.date, "2026-05-05");
    assert.equal(parsed.correctionsFound, 0);
    assert.equal(parsed.reason, "no daily-log.json found");
  });

  it("appends to an existing file (multi-night history preserved)", () => {
    recordTrainingRun(home, {
      date: "2026-05-04",
      ranAt: "2026-05-04T22:01:00.000Z",
      correctionsFound: 2,
      corrections: [],
      rulesAdded: 1,
      rulesRetired: 0,
      skillUpdated: true,
    });
    recordTrainingRun(home, {
      date: "2026-05-05",
      ranAt: "2026-05-05T22:01:00.000Z",
      correctionsFound: 0,
      corrections: [],
      rulesAdded: 0,
      rulesRetired: 0,
      skillUpdated: false,
      reason: "zero corrections",
    });
    const path = join(home, ".config", "email-triage", "training-runs.jsonl");
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("never silently swallows zero-correction nights — writes a record EVERY run", () => {
    // The bug this fixes: previous training task said "exit silently if zero
    // corrections" → no audit trail → 3 weeks of "did it run?" uncertainty.
    // The contract is now: record every run, even no-op ones. The presence
    // of a row IS the proof the cron fired.
    for (let day = 1; day <= 7; day++) {
      recordTrainingRun(home, {
        date: `2026-05-0${day}`,
        ranAt: `2026-05-0${day}T22:01:00.000Z`,
        correctionsFound: 0,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
        reason: "no corrections",
      });
    }
    const path = join(home, ".config", "email-triage", "training-runs.jsonl");
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 7, "should have one record per night, even zero-correction");
  });
});

describe("loadRecentTrainingRuns", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "etriage-load-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty array when file missing", () => {
    assert.deepEqual(loadRecentTrainingRuns(home, 30), []);
  });

  it("filters to records within N days of now", () => {
    mkdirSync(join(home, ".config", "email-triage"), { recursive: true });
    const now = Date.parse("2026-05-05T00:00:00.000Z");
    const lines = [
      // 40 days ago — outside window
      JSON.stringify({
        date: "2026-03-26",
        ranAt: "2026-03-26T22:00:00.000Z",
        correctionsFound: 1,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
      }),
      // 5 days ago — inside
      JSON.stringify({
        date: "2026-04-30",
        ranAt: "2026-04-30T22:00:00.000Z",
        correctionsFound: 2,
        corrections: [],
        rulesAdded: 1,
        rulesRetired: 0,
        skillUpdated: true,
      }),
      // today
      JSON.stringify({
        date: "2026-05-05",
        ranAt: "2026-05-05T22:00:00.000Z",
        correctionsFound: 0,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
      }),
    ];
    writeFileSync(
      join(home, ".config", "email-triage", "training-runs.jsonl"),
      lines.join("\n") + "\n",
    );

    const r = loadRecentTrainingRuns(home, 30, now);
    assert.equal(r.length, 2, "30-day window excludes the 40-day-old record");
    const dates = r.map((x) => x.date).sort();
    assert.deepEqual(dates, ["2026-04-30", "2026-05-05"]);
  });

  it("tolerates malformed lines without crashing", () => {
    mkdirSync(join(home, ".config", "email-triage"), { recursive: true });
    writeFileSync(
      join(home, ".config", "email-triage", "training-runs.jsonl"),
      [
        "{garbage line",
        JSON.stringify({
          date: "2026-05-05",
          ranAt: "2026-05-05T22:00:00.000Z",
          correctionsFound: 0,
          corrections: [],
          rulesAdded: 0,
          rulesRetired: 0,
          skillUpdated: false,
        }),
        "",
      ].join("\n"),
    );
    const r = loadRecentTrainingRuns(home, 30);
    assert.equal(r.length, 1);
  });
});

describe("summarizeForDigest", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "etriage-sum-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("counts runs, corrections, rules added/retired across the window", () => {
    const now = Date.parse("2026-05-05T22:00:00.000Z");
    mkdirSync(join(home, ".config", "email-triage"), { recursive: true });
    const records: TrainingRunRecord[] = [
      { date: "2026-05-01", ranAt: "2026-05-01T22:00:00Z", correctionsFound: 2, corrections: [], rulesAdded: 1, rulesRetired: 0, skillUpdated: true },
      { date: "2026-05-02", ranAt: "2026-05-02T22:00:00Z", correctionsFound: 0, corrections: [], rulesAdded: 0, rulesRetired: 1, skillUpdated: false },
      { date: "2026-05-03", ranAt: "2026-05-03T22:00:00Z", correctionsFound: 1, corrections: [], rulesAdded: 1, rulesRetired: 0, skillUpdated: true },
      { date: "2026-05-04", ranAt: "2026-05-04T22:00:00Z", correctionsFound: 0, corrections: [], rulesAdded: 0, rulesRetired: 0, skillUpdated: false },
    ];
    writeFileSync(
      join(home, ".config", "email-triage", "training-runs.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    const summary = summarizeForDigest(home, now, 30);
    assert.equal(summary.runs, 4);
    assert.equal(summary.totalCorrections, 3);
    assert.equal(summary.totalRulesAdded, 2);
    assert.equal(summary.totalRulesRetired, 1);
    assert.equal(summary.lastRunDate, "2026-05-04");
    assert.equal(summary.nightsSinceLastRun, 1);  // last ran yesterday
  });

  it("handles zero-data case gracefully", () => {
    const summary = summarizeForDigest(home, Date.now(), 30);
    assert.equal(summary.runs, 0);
    assert.equal(summary.totalCorrections, 0);
    assert.equal(summary.lastRunDate, null);
    assert.equal(summary.nightsSinceLastRun, null);
  });

  it("flags missed nights — gap between last run and now > 1 day", () => {
    const now = Date.parse("2026-05-05T22:00:00.000Z");
    mkdirSync(join(home, ".config", "email-triage"), { recursive: true });
    writeFileSync(
      join(home, ".config", "email-triage", "training-runs.jsonl"),
      JSON.stringify({
        date: "2026-05-01",
        ranAt: "2026-05-01T22:00:00Z",
        correctionsFound: 0,
        corrections: [],
        rulesAdded: 0,
        rulesRetired: 0,
        skillUpdated: false,
      }) + "\n",
    );
    const summary = summarizeForDigest(home, now, 30);
    assert.equal(summary.nightsSinceLastRun, 4, "should flag 4-night gap");
  });
});

describe("formatDigestLine", () => {
  it("formats the one-liner that goes into maxos-digest", () => {
    const line = formatDigestLine({
      runs: 7,
      totalCorrections: 3,
      totalRulesAdded: 2,
      totalRulesRetired: 0,
      lastRunDate: "2026-05-04",
      nightsSinceLastRun: 1,
    });
    // Should mention recent activity in a compact form
    assert.match(line, /7 runs/);
    assert.match(line, /3 corrections/);
    assert.match(line, /2 rules added/);
  });

  it("flags when training hasn't run recently (gap > 1)", () => {
    const line = formatDigestLine({
      runs: 1,
      totalCorrections: 0,
      totalRulesAdded: 0,
      totalRulesRetired: 0,
      lastRunDate: "2026-04-28",
      nightsSinceLastRun: 7,
    });
    // The whole point of this telemetry is to surface the silence
    assert.match(line, /(stale|missed|gap|7 night)/i);
  });

  it("formats compactly when no data yet", () => {
    const line = formatDigestLine({
      runs: 0,
      totalCorrections: 0,
      totalRulesAdded: 0,
      totalRulesRetired: 0,
      lastRunDate: null,
      nightsSinceLastRun: null,
    });
    assert.match(line, /(no data|never|not yet)/i);
  });
});
