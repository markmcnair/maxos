import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAndNormalize } from "../src/email-triage-record-run.js";

describe("validateAndNormalize", () => {
  const valid = {
    date: "2026-05-05",
    ranAt: "2026-05-05T22:01:00.000Z",
    correctionsFound: 0,
    corrections: [],
    rulesAdded: 0,
    rulesRetired: 0,
    skillUpdated: false,
  };

  it("accepts a fully-valid payload", () => {
    const r = validateAndNormalize(valid);
    assert.equal(r.date, "2026-05-05");
    assert.equal(r.correctionsFound, 0);
  });

  it("preserves optional reason field", () => {
    const r = validateAndNormalize({ ...valid, reason: "no daily-log.json" });
    assert.equal(r.reason, "no daily-log.json");
  });

  it("strips unknown fields silently", () => {
    const r = validateAndNormalize({ ...valid, garbage: "x", extra: 42 });
    assert.equal((r as Record<string, unknown>).garbage, undefined);
  });

  it("rejects non-object inputs", () => {
    assert.throws(() => validateAndNormalize(null), /JSON object/i);
    assert.throws(() => validateAndNormalize("string"), /JSON object/i);
    assert.throws(() => validateAndNormalize(42), /JSON object/i);
  });

  it("rejects malformed dates", () => {
    assert.throws(() => validateAndNormalize({ ...valid, date: "not-a-date" }), /YYYY-MM-DD/);
    assert.throws(() => validateAndNormalize({ ...valid, date: "2026/05/05" }), /YYYY-MM-DD/);
    assert.throws(() => validateAndNormalize({ ...valid, date: undefined }), /required/);
  });

  it("rejects negative numbers", () => {
    assert.throws(() => validateAndNormalize({ ...valid, correctionsFound: -1 }), /correctionsFound/);
    assert.throws(() => validateAndNormalize({ ...valid, rulesAdded: -1 }), /rulesAdded/);
    assert.throws(() => validateAndNormalize({ ...valid, rulesRetired: -1 }), /rulesRetired/);
  });

  it("rejects missing required fields", () => {
    const { ranAt: _, ...noRanAt } = valid;
    assert.throws(() => validateAndNormalize(noRanAt), /ranAt/);
    const { skillUpdated: __, ...noSkillUpdated } = valid;
    assert.throws(() => validateAndNormalize(noSkillUpdated), /skillUpdated/);
  });

  it("rejects non-array corrections", () => {
    assert.throws(() => validateAndNormalize({ ...valid, corrections: "x" }), /corrections/);
  });
});
