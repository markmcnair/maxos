import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideBucketFromRules,
  type Decision,
} from "../src/email-triage-decide.js";
import type { Rule } from "../src/email-rule-store.js";

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: overrides.id ?? "r1",
    kind: overrides.kind ?? "sender_pattern",
    pattern: overrides.pattern ?? { sender_regex: "@spam\\.example" },
    action: overrides.action ?? "delete",
    confidence: overrides.confidence ?? 0.95,
    status: overrides.status ?? "active",
    stats: overrides.stats ?? { triggers: 5, kept_count: 5, corrected_count: 0 },
    created_at: overrides.created_at ?? "2026-04-15",
    created_from: overrides.created_from ?? "test",
    ...overrides,
  };
}

describe("decideBucketFromRules", () => {
  it("returns rule decision when confidence >= 0.9", () => {
    const r = rule({ confidence: 0.95 });
    const d: Decision = decideBucketFromRules({ from: "x@spam.example", subject: "y" }, [r]);
    assert.equal(d.source, "rule");
    assert.equal(d.bucket, "delete");
    assert.equal(d.ruleId, "r1");
    assert.equal(d.confidence, 0.95);
    assert.equal(d.novel, false);
  });

  it("returns rule decision flagged low-confidence in [0.7, 0.9)", () => {
    const r = rule({ confidence: 0.8 });
    const d = decideBucketFromRules({ from: "x@spam.example", subject: "y" }, [r]);
    assert.equal(d.source, "rule-low-confidence");
    assert.equal(d.bucket, "delete");
  });

  it("returns llm-fallback when matching rule confidence < 0.7", () => {
    // Borderline-bad match — let LLM decide rather than trust shaky rule
    const r = rule({ confidence: 0.65 });
    const d = decideBucketFromRules({ from: "x@spam.example", subject: "y" }, [r]);
    assert.equal(d.source, "llm-fallback");
    assert.equal(d.novel, true);
  });

  it("returns llm-fallback when no rule matches at all", () => {
    const r = rule({ pattern: { sender_regex: "@nope\\." } });
    const d = decideBucketFromRules({ from: "x@example.com", subject: "y" }, [r]);
    assert.equal(d.source, "llm-fallback");
    assert.equal(d.bucket, null);
    assert.equal(d.ruleId, null);
    assert.equal(d.novel, true);
  });

  it("returns llm-fallback on empty rule set", () => {
    const d = decideBucketFromRules({ from: "x@y.com", subject: "z" }, []);
    assert.equal(d.source, "llm-fallback");
    assert.equal(d.novel, true);
  });

  it("retired rules don't get used (matching skips retired)", () => {
    const r = rule({ confidence: 0.95, status: "retired" });
    const d = decideBucketFromRules({ from: "x@spam.example", subject: "y" }, [r]);
    assert.equal(d.source, "llm-fallback");
  });

  it("proposed rules count as a low-confidence rule decision", () => {
    // Proposed rules are part of the matching pool, but caller should
    // treat them as "rule-low-confidence" regardless of their actual
    // confidence number — they haven't earned active status yet.
    const r = rule({ status: "proposed", confidence: 0.95 });
    const d = decideBucketFromRules({ from: "x@spam.example", subject: "y" }, [r]);
    assert.equal(d.source, "rule-low-confidence");
    assert.equal(d.bucket, "delete");
  });
});
