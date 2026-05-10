import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadRules,
  saveRules,
  findMatchingRule,
  recordRuleHit,
  proposeRule,
  promoteRule,
  retireRule,
  evaluateRulesForLifecycle,
  applyConfidenceDelta,
  type Rule,
  type RuleStore,
  type EmailFeatures,
} from "../src/email-rule-store.js";

// ───── Pure: confidence math ─────

describe("applyConfidenceDelta", () => {
  it("kept on proposed rule (start 0.5) increases toward 1.0 with diminishing returns", () => {
    let c = 0.5;
    c = applyConfidenceDelta(c, "kept");
    assert.ok(c > 0.5);
    assert.ok(c < 1);
    const c1 = c;
    c = applyConfidenceDelta(c, "kept");
    const c2 = c;
    // Diminishing returns: each kept adds less than the previous
    assert.ok(c2 - c1 < c1 - 0.5);
  });

  it("never exceeds 1.0 with arbitrary kept signals", () => {
    let c = 0.5;
    for (let i = 0; i < 200; i++) c = applyConfidenceDelta(c, "kept");
    assert.ok(c <= 1.0);
    assert.ok(c > 0.99);
  });

  it("corrected drops by 0.3 and clamps at 0", () => {
    assert.equal(applyConfidenceDelta(0.5, "corrected"), 0.2);
    assert.equal(applyConfidenceDelta(0.25, "corrected"), 0);
    assert.equal(applyConfidenceDelta(0, "corrected"), 0);
  });

  it("monotone under repeated kept signals (never decreases)", () => {
    let prev = 0.5;
    for (let i = 0; i < 50; i++) {
      const next = applyConfidenceDelta(prev, "kept");
      assert.ok(next >= prev, `step ${i}: ${prev} → ${next} should not decrease`);
      prev = next;
    }
  });
});

// ───── Persistence ─────

describe("loadRules / saveRules", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rule-store-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns an empty store when file is missing", () => {
    const store = loadRules(home);
    assert.equal(store.version, 1);
    assert.deepEqual(store.rules, []);
  });

  it("roundtrips save → load", () => {
    const rule: Rule = {
      id: "rule-test-1",
      kind: "sender_pattern",
      pattern: { sender_regex: "@example\\.com$" },
      action: "delete",
      confidence: 0.9,
      status: "active",
      stats: { triggers: 5, kept_count: 5, corrected_count: 0, last_triggered: "2026-05-04T15:00:00Z" },
      created_at: "2026-04-15T22:00:00Z",
      created_from: "training-test",
    };
    saveRules(home, { version: 1, rules: [rule] });
    const path = join(home, ".config", "email-triage", "rules.json");
    assert.ok(existsSync(path));
    const reloaded = loadRules(home);
    assert.equal(reloaded.rules.length, 1);
    assert.equal(reloaded.rules[0].id, "rule-test-1");
    assert.equal(reloaded.rules[0].confidence, 0.9);
  });

  it("returns empty store for malformed file (no crash)", () => {
    const path = join(home, ".config", "email-triage", "rules.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json {");
    const store = loadRules(home);
    assert.deepEqual(store.rules, []);
  });

  it("filters out malformed rule entries silently", () => {
    const path = join(home, ".config", "email-triage", "rules.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "valid",
            kind: "sender_pattern",
            pattern: { sender_regex: "x" },
            action: "delete",
            confidence: 0.9,
            status: "active",
            stats: { triggers: 0, kept_count: 0, corrected_count: 0 },
            created_at: "2026-04-15",
            created_from: "x",
          },
          { junk: "missing fields" },
          "not even an object",
        ],
      }),
    );
    const store = loadRules(home);
    assert.equal(store.rules.length, 1);
    assert.equal(store.rules[0].id, "valid");
  });
});

// ───── Matching ─────

describe("findMatchingRule", () => {
  function rule(overrides: Partial<Rule> = {}): Rule {
    return {
      id: overrides.id ?? "r1",
      kind: overrides.kind ?? "sender_pattern",
      pattern: overrides.pattern ?? { sender_regex: "@example\\.com$" },
      action: overrides.action ?? "delete",
      confidence: overrides.confidence ?? 0.9,
      status: overrides.status ?? "active",
      stats: overrides.stats ?? { triggers: 0, kept_count: 0, corrected_count: 0 },
      created_at: overrides.created_at ?? "2026-04-15",
      created_from: overrides.created_from ?? "test",
      ...overrides,
    };
  }

  it("returns null when no rules match", () => {
    const store: RuleStore = { version: 1, rules: [rule({ pattern: { sender_regex: "@nope\\." } })] };
    const r = findMatchingRule(store.rules, {
      from: "user@example.com",
      subject: "hello",
    });
    assert.equal(r, null);
  });

  it("matches a sender_pattern rule", () => {
    const store: RuleStore = { version: 1, rules: [rule()] };
    const r = findMatchingRule(store.rules, {
      from: "noreply@example.com",
      subject: "hi",
    });
    assert.equal(r?.id, "r1");
  });

  it("matches a sender_subject_pattern rule (both regexes must match)", () => {
    const r = rule({
      kind: "sender_subject_pattern",
      pattern: { sender_regex: "@mealtrain\\.com$", subject_regex: "(?i)^You have signed up" },
      action: "delete",
    });
    const matches = findMatchingRule([r], {
      from: "noreply@mealtrain.com",
      subject: "You have signed up for Smith family",
    });
    assert.equal(matches?.id, r.id);

    // Subject doesn't match — rule should not match
    const noMatch = findMatchingRule([r], {
      from: "noreply@mealtrain.com",
      subject: "We need volunteers",
    });
    assert.equal(noMatch, null);
  });

  it("ignores retired rules", () => {
    const r = rule({ status: "retired" });
    assert.equal(
      findMatchingRule([r], { from: "x@example.com", subject: "y" }),
      null,
    );
  });

  it("includes proposed rules but flags them differently (caller decides what to do)", () => {
    const r = rule({ status: "proposed", confidence: 0.6 });
    const match = findMatchingRule([r], { from: "x@example.com", subject: "y" });
    assert.equal(match?.id, r.id);
    assert.equal(match?.status, "proposed");
  });

  it("when multiple match, returns the highest-confidence active rule", () => {
    const r1 = rule({ id: "r-low", confidence: 0.7 });
    const r2 = rule({ id: "r-high", confidence: 0.95 });
    const r = findMatchingRule([r1, r2], { from: "x@example.com", subject: "y" });
    assert.equal(r?.id, "r-high");
  });

  it("ties broken by most-recent last_triggered", () => {
    const r1 = rule({
      id: "older",
      confidence: 0.9,
      stats: { triggers: 10, kept_count: 9, corrected_count: 1, last_triggered: "2026-04-01T00:00:00Z" },
    });
    const r2 = rule({
      id: "newer",
      confidence: 0.9,
      stats: { triggers: 5, kept_count: 5, corrected_count: 0, last_triggered: "2026-05-04T00:00:00Z" },
    });
    const r = findMatchingRule([r1, r2], { from: "x@example.com", subject: "y" });
    assert.equal(r?.id, "newer");
  });

  it("invalid regex in a rule does not crash matching (treats rule as non-matching)", () => {
    const r = rule({ pattern: { sender_regex: "[unclosed" } });
    const result = findMatchingRule([r], { from: "x@example.com", subject: "y" });
    assert.equal(result, null);
  });
});

// ───── Lifecycle ─────

describe("recordRuleHit", () => {
  function baseStore(): RuleStore {
    return {
      version: 1,
      rules: [
        {
          id: "r1",
          kind: "sender_pattern",
          pattern: { sender_regex: "@x\\." },
          action: "delete",
          confidence: 0.5,
          status: "proposed",
          stats: { triggers: 0, kept_count: 0, corrected_count: 0 },
          created_at: "2026-05-05",
          created_from: "test",
        },
      ],
    };
  }

  it("kept increments triggers + kept_count + raises confidence", () => {
    const store = baseStore();
    const after = recordRuleHit(store, "r1", "kept", new Date("2026-05-05T22:00:00Z"));
    const r = after.rules[0];
    assert.equal(r.stats.triggers, 1);
    assert.equal(r.stats.kept_count, 1);
    assert.equal(r.stats.corrected_count, 0);
    assert.ok(r.confidence > 0.5);
    assert.equal(r.stats.last_triggered, "2026-05-05T22:00:00.000Z");
  });

  it("corrected increments triggers + corrected_count + drops confidence", () => {
    const store = baseStore();
    const after = recordRuleHit(store, "r1", "corrected", new Date("2026-05-05T22:00:00Z"));
    const r = after.rules[0];
    assert.equal(r.stats.corrected_count, 1);
    assert.equal(r.confidence, 0.2);
  });

  it("unknown rule id is a no-op (returns store unchanged)", () => {
    const store = baseStore();
    const after = recordRuleHit(store, "does-not-exist", "kept", new Date());
    assert.deepEqual(after, store);
  });
});

describe("proposeRule + promoteRule + retireRule", () => {
  it("proposeRule adds a new rule with status=proposed and confidence=0.5", () => {
    const store: RuleStore = { version: 1, rules: [] };
    const after = proposeRule(store, {
      kind: "sender_pattern",
      pattern: { sender_regex: "@spam\\." },
      action: "delete",
      created_from: "training-2026-05-05",
      notes: "Mark moved 1 from see-mail to delete",
    }, new Date("2026-05-05T22:00:00Z"));
    assert.equal(after.rules.length, 1);
    const r = after.rules[0];
    assert.equal(r.status, "proposed");
    assert.equal(r.confidence, 0.5);
    assert.match(r.id, /^rule-2026-05-05/);
    assert.equal(r.stats.triggers, 0);
  });

  it("promoteRule flips proposed → active", () => {
    const store: RuleStore = {
      version: 1,
      rules: [
        {
          id: "r1",
          kind: "sender_pattern",
          pattern: { sender_regex: "x" },
          action: "delete",
          confidence: 0.9,
          status: "proposed",
          stats: { triggers: 3, kept_count: 3, corrected_count: 0 },
          created_at: "2026-05-01",
          created_from: "test",
        },
      ],
    };
    const after = promoteRule(store, "r1");
    assert.equal(after.rules[0].status, "active");
  });

  it("retireRule flips status to retired", () => {
    const store: RuleStore = {
      version: 1,
      rules: [
        {
          id: "r1",
          kind: "sender_pattern",
          pattern: { sender_regex: "x" },
          action: "delete",
          confidence: 0.5,
          status: "active",
          stats: { triggers: 5, kept_count: 2, corrected_count: 3 },
          created_at: "2026-05-01",
          created_from: "test",
        },
      ],
    };
    const after = retireRule(store, "r1");
    assert.equal(after.rules[0].status, "retired");
  });
});

describe("evaluateRulesForLifecycle", () => {
  it("recommends promoting proposed rules with triggers >= 3 AND confidence >= 0.85", () => {
    const store: RuleStore = {
      version: 1,
      rules: [
        {
          id: "ready",
          kind: "sender_pattern",
          pattern: { sender_regex: "x" },
          action: "delete",
          confidence: 0.88,
          status: "proposed",
          stats: { triggers: 4, kept_count: 4, corrected_count: 0 },
          created_at: "2026-05-01",
          created_from: "test",
        },
        {
          id: "not-ready",
          kind: "sender_pattern",
          pattern: { sender_regex: "y" },
          action: "delete",
          confidence: 0.7,
          status: "proposed",
          stats: { triggers: 3, kept_count: 2, corrected_count: 1 },
          created_at: "2026-05-01",
          created_from: "test",
        },
      ],
    };
    const decisions = evaluateRulesForLifecycle(store);
    assert.deepEqual(decisions.toPromote, ["ready"]);
    assert.deepEqual(decisions.toRetire, []);
  });

  it("recommends retiring active rules with triggers >= 5 AND confidence < 0.6", () => {
    const store: RuleStore = {
      version: 1,
      rules: [
        {
          id: "bad-rule",
          kind: "sender_pattern",
          pattern: { sender_regex: "z" },
          action: "delete",
          confidence: 0.4,
          status: "active",
          stats: { triggers: 7, kept_count: 2, corrected_count: 5 },
          created_at: "2026-05-01",
          created_from: "test",
        },
      ],
    };
    const decisions = evaluateRulesForLifecycle(store);
    assert.deepEqual(decisions.toRetire, ["bad-rule"]);
  });

  it("does NOT retire a single-correction proposed rule prematurely", () => {
    // proposed rule: triggers=1, corrected=1 → confidence dropped to 0.2.
    // Should NOT retire yet (triggers < 5). Avoids premature retirement
    // from a single bad signal.
    const store: RuleStore = {
      version: 1,
      rules: [
        {
          id: "young-rule",
          kind: "sender_pattern",
          pattern: { sender_regex: "z" },
          action: "delete",
          confidence: 0.2,
          status: "proposed",
          stats: { triggers: 1, kept_count: 0, corrected_count: 1 },
          created_at: "2026-05-05",
          created_from: "test",
        },
      ],
    };
    const decisions = evaluateRulesForLifecycle(store);
    assert.deepEqual(decisions.toRetire, []);
  });
});
