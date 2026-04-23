import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proposeNudges, applyNudges, type Nudge } from "../src/brew-tuning-nudger.js";
import type { DailyArchive } from "../src/brew-archive.js";

describe("proposeNudges", () => {
  it("bumps a weight when Mark stuck with a topic 3+ days", () => {
    const archives: DailyArchive[] = [1, 2, 3].map(d => ({
      date: `2026-04-${18 + d}`,
      ai: { headline: "x", url: "u", source: "github", score: 4 },
      prime: null,
      learning: { topic: "RAG", day: d, breadcrumbUrl: "b", alternative: "V" },
      streak: 0,
      feedbackAppliedFrom: null,
    }));
    const nudges = proposeNudges(archives);
    const rag = nudges.find(n => n.key.toLowerCase().includes("rag"));
    assert.ok(rag);
    assert.ok(rag!.delta > 0);
    assert.ok(rag!.delta <= 0.05, "max 0.5% change per week");
  });

  it("lowers a weight when Mark switched away from a topic quickly", () => {
    const archives: DailyArchive[] = [
      { date: "2026-04-15", ai: { headline: "x", url: "u", source: "github", score: 4 }, prime: null, learning: { topic: "Cursor tips", day: 1, breadcrumbUrl: "b", alternative: "V" }, streak: 1, feedbackAppliedFrom: null },
      { date: "2026-04-16", ai: { headline: "x", url: "u", source: "github", score: 4 }, prime: null, learning: { topic: "V", day: 1, breadcrumbUrl: "b", alternative: "X" }, streak: 2, feedbackAppliedFrom: null },
    ];
    const nudges = proposeNudges(archives);
    const c = nudges.find(n => n.key.toLowerCase().includes("cursor"));
    assert.ok(c);
    assert.ok(c!.delta < 0);
  });
});

describe("applyNudges", () => {
  it("clamps total change per week at +/-0.05", () => {
    const before = "- Claude / Anthropic / MCP specific: 1.0\n- AI coding tools: 0.7\n";
    const nudges: Nudge[] = [
      { key: "AI coding tools", delta: 0.3 },
    ];
    const after = applyNudges(before, nudges);
    assert.ok(after.includes("AI coding tools: 0.75"), "should clamp to 0.7 + 0.05");
  });
});
