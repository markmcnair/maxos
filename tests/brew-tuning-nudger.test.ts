import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  proposeNudges,
  applyNudges,
  parseWeightLines,
  keyTerms,
  type Nudge,
  type NudgeState,
} from "../src/brew-tuning-nudger.js";
import type { DailyArchive } from "../src/brew-archive.js";

/**
 * Fixtures use the shape the brew ACTUALLY writes today — `learning.topic` +
 * `learning.url`, no `prime`, no `streak`, and a unique free-form slug every
 * day. The 2026-04 test suite used `{topic, day, breadcrumbUrl, alternative}`
 * with a `streak`, which no archive on disk has carried since 2026-06-17; it
 * passed while the live nudger returned an empty set for four straight weeks.
 */
const TUNING = `# Morning Brew Tuning — test fixture

## AI picker weights

- Claude / Anthropic / MCP specific: 1.0
- AI agent orchestration / multi-agent: 0.85
- Open-source model releases: 0.75
- Consumer AI apps: 0.3

## Learning picker

- Quality bar: views/subs > 5x, likes > 90%
- First breadcrumb on new topic: always YouTube video, 5-15 min

## Learning picker weights

- Colombia company records / RUES / Supersociedades: 0.9
- Deal sourcing / owner outreach: 0.8
`;

function day(date: string, headline: string, topic: string): DailyArchive {
  return {
    date,
    ai: { headline, url: "https://example.test/x", source: "GitHub Trending", score: 4.2 },
    learning: { topic, url: "https://example.test/l" },
    feedbackAppliedFrom: null,
  };
}

/** The real 2026-08-30 → 09-06 window, trimmed to what the matcher reads. */
const REAL_WEEK: DailyArchive[] = [
  day("2026-08-30", "The concierge you demo should answer the phone, not a chat box", "off-market-owner-outreach-buyer-introduction-letter"),
  day("2026-08-31", "Someone packaged the whole agent-discipline layer you built by hand", "colombia-share-purchase-foreign-buyer-fdi-registration"),
  day("2026-09-01", "A DESIGN.md is the AGENTS.md for how your UI looks", "colombia-private-company-records-rues-supersociedades-sirem"),
  day("2026-09-03", "A skill that stops your agent from over-building", "sde-multiple-valuation-small-distribution-import-business"),
  day("2026-09-04", "The agent that writes its own skills while it works", "colombia-coffee-exporter-registration-fnc-rnec"),
  day("2026-09-06", "A Spotify engineer cut Claude Code token burn 90% by blocking big file reads with a hook", "RUES — Colombia national commercial registry"),
];

describe("parseWeightLines", () => {
  it("reads only bullets inside a '...weights' section", () => {
    const keys = parseWeightLines(TUNING).map(l => l.key);
    assert.ok(keys.includes("Claude / Anthropic / MCP specific"));
    assert.ok(keys.includes("Colombia company records / RUES / Supersociedades"));
    assert.ok(!keys.includes("Quality bar"), "must not touch Mark's prose rules");
    assert.ok(!keys.includes("First breadcrumb on new topic"));
  });

  it("keeps the numeric value and its section", () => {
    const l = parseWeightLines(TUNING).find(x => x.key === "Consumer AI apps")!;
    assert.equal(l.value, 0.3);
    assert.equal(l.section, "AI picker weights");
  });
});

describe("keyTerms", () => {
  it("drops words that say what a topic is, not which one", () => {
    assert.deepEqual(keyTerms("Open-source model releases"), []);
  });

  it("keeps distinctive words", () => {
    const t = keyTerms("Claude / Anthropic / MCP specific");
    assert.deepEqual(t.sort(), ["anthropic", "claude", "mcp"]);
  });
});

describe("proposeNudges", () => {
  it("fires on the real week that produced zero nudges for four weeks", () => {
    const r = proposeNudges(REAL_WEEK, TUNING);
    assert.ok(r.nudges.length > 0, "the live regression: this returned [] before the rebuild");
  });

  it("bumps a weight the week's picks kept landing on", () => {
    const r = proposeNudges(REAL_WEEK, TUNING);
    const colombia = r.nudges.find(n => n.key.startsWith("Colombia"));
    assert.ok(colombia, "4 of 6 learning picks were Colombia company records");
    assert.ok(colombia!.delta > 0);
    assert.ok(colombia!.delta <= 0.05, "max 0.05 change per week");
  });

  it("only proposes keys that exist in tuning.md, never raw topic slugs", () => {
    const r = proposeNudges(REAL_WEEK, TUNING);
    const known = new Set(parseWeightLines(TUNING).map(l => l.key));
    for (const n of r.nudges) {
      assert.ok(known.has(n.key), `proposed unusable key: ${n.key}`);
    }
  });

  it("never nudges a key with no distinctive terms", () => {
    const r = proposeNudges(REAL_WEEK, TUNING);
    assert.deepEqual(r.unmeasurable, ["Open-source model releases"]);
    assert.ok(!r.nudges.some(n => n.key === "Open-source model releases"));
    assert.ok(!(("Open-source model releases") in r.state.coldWeeks));
  });

  it("reads a legacy archive that spells the subject 'track'", () => {
    const legacy: DailyArchive[] = [1, 2, 3].map(i => ({
      date: `2026-06-1${i}`,
      ai: { headline: "x", url: "u", source: "github", score: 4 },
      prime: null,
      streak: 2,
      learning: { track: "colombia rues filings", day: i, breadcrumbUrl: "b" },
      feedbackAppliedFrom: null,
    }));
    const r = proposeNudges(legacy, TUNING);
    assert.ok(r.nudges.some(n => n.key.startsWith("Colombia")));
  });

  it("does not decay a key until it has been cold three weeks running", () => {
    let state: NudgeState = { coldWeeks: {} };
    const key = "Consumer AI apps";
    for (const week of [1, 2]) {
      const r = proposeNudges(REAL_WEEK, TUNING, state);
      state = r.state;
      assert.ok(!r.nudges.some(n => n.key === key), `decayed too early on week ${week}`);
      assert.equal(state.coldWeeks[key], week);
    }
    const third = proposeNudges(REAL_WEEK, TUNING, state);
    const decay = third.nudges.find(n => n.key === key);
    assert.ok(decay, "third cold week should decay");
    assert.ok(decay!.delta < 0);
    assert.equal(third.state.coldWeeks[key], 0, "counter resets after firing");
  });

  it("resets the cold counter when a key gets a hit", () => {
    const state: NudgeState = { coldWeeks: { "Consumer AI apps": 2 } };
    const hot = [day("2026-09-07", "A consumer AI app for recipes", "consumer apps")];
    const r = proposeNudges(hot, TUNING, state);
    assert.equal(r.state.coldWeeks["Consumer AI apps"], 0);
  });

  it("forgets keys Mark deleted from tuning.md", () => {
    const state: NudgeState = { coldWeeks: { "A weight Mark removed": 2 } };
    const r = proposeNudges(REAL_WEEK, TUNING, state);
    assert.ok(!("A weight Mark removed" in r.state.coldWeeks));
  });
});

describe("applyNudges", () => {
  it("writes the new value into the matching bullet", () => {
    const r = applyNudges(TUNING, [{ key: "Consumer AI apps", delta: 0.03, reason: "t" }]);
    assert.ok(r.text.includes("- Consumer AI apps: 0.33"));
    assert.equal(r.applied.length, 1);
    assert.equal(r.skipped.length, 0);
  });

  it("clamps a single change at +/-0.05", () => {
    const r = applyNudges(TUNING, [{ key: "Consumer AI apps", delta: 0.3, reason: "t" }]);
    assert.ok(r.text.includes("- Consumer AI apps: 0.35"));
    assert.equal(r.applied[0].delta, 0.05);
  });

  it("REPORTS a nudge whose key is not in the file instead of dropping it", () => {
    const nudges: Nudge[] = [{ key: "colombia-coffee-exporter-registration-fnc-rnec", delta: 0.03, reason: "t" }];
    const r = applyNudges(TUNING, nudges);
    assert.equal(r.applied.length, 0);
    assert.equal(r.skipped.length, 1, "silent drop was the defect that read as success");
    assert.match(r.skipped[0].why, /no weight line/);
    assert.equal(r.text, TUNING, "an unlandable nudge must not alter the file");
  });

  it("reports a no-op at the ceiling rather than counting it as applied", () => {
    const r = applyNudges(TUNING, [{ key: "Claude / Anthropic / MCP specific", delta: 0.03, reason: "t" }]);
    assert.equal(r.applied.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].why, /ceiling/);
  });

  it("leaves Mark's prose bullets alone", () => {
    const r = applyNudges(TUNING, [{ key: "Quality bar", delta: 0.05, reason: "t" }]);
    assert.ok(r.text.includes("- Quality bar: views/subs > 5x, likes > 90%"));
    assert.equal(r.skipped.length, 1);
  });

  it("never drives a weight below zero", () => {
    const md = "## AI picker weights\n\n- Tiny thing: 0.01\n";
    const r = applyNudges(md, [{ key: "Tiny thing", delta: -0.05, reason: "t" }]);
    assert.ok(r.text.includes("- Tiny thing: 0"));
    assert.equal(r.applied.length, 1);
  });
});

describe("adversarial", () => {
  it("a key duplicated in tuning.md cannot break the weekly clamp", () => {
    const dup = "## AI picker weights\n\n- Vector DBs: 0.5\n- Vector DBs: 0.5\n";
    const hot = ["d1", "d2", "d3"].map(d => day(d, "vector db benchmarks", "vector"));
    const r = proposeNudges(hot, dup);
    assert.equal(r.nudges.length, 1, "one weight line, one nudge");
    const res = applyNudges(dup, r.nudges);
    assert.ok(res.text.includes("- Vector DBs: 0.53"));
    assert.ok(!res.text.includes("0.56"), "0.06 would exceed the 0.05 weekly clamp");
  });

  it("applyNudges refuses a second nudge on a key it already moved", () => {
    const md = "## AI picker weights\n\n- Vector DBs: 0.5\n";
    const res = applyNudges(md, [
      { key: "Vector DBs", delta: 0.03, reason: "a" },
      { key: "Vector DBs", delta: 0.03, reason: "b" },
    ]);
    assert.equal(res.applied.length, 1);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].why, /already moved/);
    assert.ok(res.text.includes("- Vector DBs: 0.53"));
  });

  it("an empty window decays nothing — no archives is an outage, not disinterest", () => {
    const state: NudgeState = { coldWeeks: { "Consumer AI apps": 2 } };
    const r = proposeNudges([], TUNING, state);
    assert.deepEqual(r.nudges, []);
    assert.equal(r.state.coldWeeks["Consumer AI apps"], 2, "ledger must not advance");
  });

  it("handles regex metacharacters in a weight key", () => {
    const md = "## AI picker weights\n\n- AI infrastructure (inference runtimes, vector DBs): 0.75\n";
    const res = applyNudges(md, [
      { key: "AI infrastructure (inference runtimes, vector DBs)", delta: 0.03, reason: "t" },
    ]);
    assert.equal(res.applied.length, 1);
    assert.ok(res.text.includes(": 0.78"));
  });

  it("does not let a shorter key match a longer bullet", () => {
    const md = "## AI picker weights\n\n- Consumer AI apps: 0.3\n";
    const res = applyNudges(md, [{ key: "Consumer AI", delta: 0.05, reason: "t" }]);
    assert.equal(res.applied.length, 0);
    assert.ok(res.text.includes("- Consumer AI apps: 0.3"));
  });
});
