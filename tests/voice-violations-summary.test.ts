import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeViolations, formatSummary } from "../src/voice-violations-summary.js";

describe("summarizeViolations", () => {
  const sample = [
    JSON.stringify({
      ts: 100, task: "morning-brief", conversationId: "dm",
      totalChars: 500, violationCount: 2,
      violations: [
        { pattern: "—", category: "em-dash" },
        { pattern: "I hope this email finds you well", category: "phrase" },
      ],
    }),
    JSON.stringify({
      ts: 200, task: "morning-brew", conversationId: "dm",
      totalChars: 800, violationCount: 1,
      violations: [{ pattern: "—", category: "em-dash" }],
    }),
    JSON.stringify({
      ts: 300, task: undefined, conversationId: "dm",
      totalChars: 100, violationCount: 1,
      violations: [{ pattern: "Leverage", category: "word" }],
    }),
    JSON.stringify({
      ts: 99999, task: "outside-window", conversationId: "dm",
      totalChars: 50, violationCount: 5,
      violations: [{ pattern: "x", category: "phrase" }],
    }),
  ].join("\n");

  it("counts entries + total violations within window", () => {
    const s = summarizeViolations(sample, 0, 999);
    assert.equal(s.totalEntries, 3);
    assert.equal(s.totalViolations, 4);
  });

  it("buckets by category", () => {
    const s = summarizeViolations(sample, 0, 999);
    assert.equal(s.byCategory["em-dash"], 2);
    assert.equal(s.byCategory.phrase, 1);
    assert.equal(s.byCategory.word, 1);
  });

  it("aggregates patterns sorted by count desc", () => {
    const s = summarizeViolations(sample, 0, 999);
    assert.equal(s.byPattern[0].pattern, "—");
    assert.equal(s.byPattern[0].count, 2);
  });

  it("buckets by task with (unknown) for missing task", () => {
    const s = summarizeViolations(sample, 0, 999);
    assert.equal(s.byTask["morning-brief"], 2);
    assert.equal(s.byTask["morning-brew"], 1);
    assert.equal(s.byTask["(unknown)"], 1);
  });

  it("excludes entries outside the time window", () => {
    const s = summarizeViolations(sample, 0, 250);
    assert.equal(s.totalEntries, 2);
    assert.equal(s.totalViolations, 3);
  });

  it("handles empty input", () => {
    const s = summarizeViolations("", 0);
    assert.equal(s.totalEntries, 0);
    assert.equal(s.totalViolations, 0);
    assert.deepEqual(s.byPattern, []);
  });

  it("tolerates corrupt JSON lines", () => {
    const messy = sample + "\nnot-json\n{broken\n";
    const s = summarizeViolations(messy, 0, 999);
    assert.equal(s.totalEntries, 3);
  });
});

describe("formatSummary", () => {
  it("renders the clean-window case", () => {
    const out = formatSummary({
      windowHours: 24, totalEntries: 0, totalViolations: 0,
      byCategory: {}, byPattern: [], byTask: {}, cleanRate: 1,
    });
    assert.match(out, /clean window/);
    assert.match(out, /last 24h/);
  });

  it("renders categories and top patterns when present", () => {
    const out = formatSummary({
      windowHours: 24,
      totalEntries: 3,
      totalViolations: 4,
      byCategory: { "em-dash": 2, phrase: 1, word: 1 },
      byPattern: [
        { pattern: "—", category: "em-dash", count: 2 },
        { pattern: "Leverage", category: "word", count: 1 },
      ],
      byTask: { "morning-brief": 2, "(unknown)": 1, "morning-brew": 1 },
      cleanRate: 1,
    });
    assert.match(out, /em-dash/);
    assert.match(out, /Leverage/);
    assert.match(out, /\(interactive chat\)/);
    assert.match(out, /Top patterns/);
  });
});
