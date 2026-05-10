import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runRecordHit,
  runProposeRule,
  runLifecycle,
  runList,
} from "../src/email-triage-rules-cli.js";
import { saveRules, type Rule, type RuleStore } from "../src/email-rule-store.js";

describe("runRecordHit", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rules-cli-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("records a kept hit, increments triggers + raises confidence", () => {
    saveRules(home, {
      version: 1,
      rules: [{
        id: "rule-A",
        kind: "sender_pattern",
        pattern: { sender_regex: "x" },
        action: "delete",
        confidence: 0.5,
        status: "proposed",
        stats: { triggers: 0, kept_count: 0, corrected_count: 0 },
        created_at: "2026-05-01",
        created_from: "test",
      }],
    });
    const r = runRecordHit(home, { ruleId: "rule-A", signal: "kept" }, new Date("2026-05-05T22:00:00Z"));
    assert.equal(r.ok, true);
    assert.equal(r.rule?.stats.triggers, 1);
    assert.ok((r.rule?.confidence ?? 0) > 0.5);
  });

  it("returns ok=false when ruleId not found", () => {
    saveRules(home, { version: 1, rules: [] });
    const r = runRecordHit(home, { ruleId: "nope", signal: "kept" }, new Date());
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found/i);
  });

  it("validates signal value", () => {
    saveRules(home, { version: 1, rules: [] });
    // @ts-expect-error testing invalid
    const r = runRecordHit(home, { ruleId: "x", signal: "garbage" }, new Date());
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /signal/i);
  });
});

describe("runProposeRule", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rules-cli-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("adds a new proposed rule, persists, returns the new id", () => {
    const r = runProposeRule(
      home,
      {
        kind: "sender_subject_pattern",
        sender_regex: "@mealtrain\\.com$",
        subject_regex: "(?i)^You have signed up",
        action: "delete",
        created_from: "training-2026-05-05",
        notes: "Mark moved 2 from see-mail",
      },
      new Date("2026-05-05T22:00:00Z"),
    );
    assert.equal(r.ok, true);
    assert.match(r.rule!.id, /^rule-2026-05-05/);
    assert.equal(r.rule!.status, "proposed");
    assert.equal(r.rule!.confidence, 0.5);

    const path = join(home, ".config", "email-triage", "rules.json");
    assert.ok(existsSync(path));
    const persisted = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(persisted.rules.length, 1);
  });

  it("rejects when both sender_regex and subject_regex are absent (need at least one)", () => {
    const r = runProposeRule(
      home,
      { kind: "sender_pattern", action: "delete", created_from: "x" } as any,
      new Date(),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /pattern/i);
  });

  it("rejects invalid action bucket", () => {
    const r = runProposeRule(
      home,
      {
        kind: "sender_pattern",
        sender_regex: "x",
        action: "garbage" as any,
        created_from: "x",
      },
      new Date(),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /action/i);
  });

  it("rejects regex that fails to compile", () => {
    const r = runProposeRule(
      home,
      {
        kind: "sender_pattern",
        sender_regex: "[unclosed",
        action: "delete",
        created_from: "x",
      },
      new Date(),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /regex/i);
  });
});

describe("runLifecycle", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rules-cli-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("promotes proposed rules that meet thresholds, retires bad active rules", () => {
    saveRules(home, {
      version: 1,
      rules: [
        {
          id: "ready",
          kind: "sender_pattern",
          pattern: { sender_regex: "x" },
          action: "delete",
          confidence: 0.92,
          status: "proposed",
          stats: { triggers: 4, kept_count: 4, corrected_count: 0 },
          created_at: "2026-05-01",
          created_from: "test",
        },
        {
          id: "bad",
          kind: "sender_pattern",
          pattern: { sender_regex: "z" },
          action: "delete",
          confidence: 0.4,
          status: "active",
          stats: { triggers: 8, kept_count: 2, corrected_count: 6 },
          created_at: "2026-04-01",
          created_from: "test",
        },
      ],
    });
    const r = runLifecycle(home);
    assert.deepEqual(r.promoted, ["ready"]);
    assert.deepEqual(r.retired, ["bad"]);

    const persisted = JSON.parse(
      readFileSync(join(home, ".config", "email-triage", "rules.json"), "utf-8"),
    );
    const promoted = persisted.rules.find((x: Rule) => x.id === "ready");
    const retired = persisted.rules.find((x: Rule) => x.id === "bad");
    assert.equal(promoted.status, "active");
    assert.equal(retired.status, "retired");
  });

  it("returns empty arrays when no rules need lifecycle action", () => {
    saveRules(home, { version: 1, rules: [] });
    const r = runLifecycle(home);
    assert.deepEqual(r.promoted, []);
    assert.deepEqual(r.retired, []);
  });
});

describe("runList", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rules-cli-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns a structured summary of all rules", () => {
    saveRules(home, {
      version: 1,
      rules: [
        {
          id: "r1",
          kind: "sender_pattern",
          pattern: { sender_regex: "@x\\.com" },
          action: "delete",
          confidence: 0.95,
          status: "active",
          stats: { triggers: 10, kept_count: 10, corrected_count: 0 },
          created_at: "2026-05-01",
          created_from: "test",
        },
        {
          id: "r2",
          kind: "sender_pattern",
          pattern: { sender_regex: "@y\\.com" },
          action: "see-mail",
          confidence: 0.6,
          status: "proposed",
          stats: { triggers: 1, kept_count: 1, corrected_count: 0 },
          created_at: "2026-05-04",
          created_from: "test",
        },
      ],
    });
    const r = runList(home);
    assert.equal(r.totals.active, 1);
    assert.equal(r.totals.proposed, 1);
    assert.equal(r.totals.retired, 0);
    assert.equal(r.totals.byBucket.delete, 1);
    assert.equal(r.totals.byBucket["see-mail"], 1);
  });
});
