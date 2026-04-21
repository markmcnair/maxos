import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOpenLoops,
  saveOpenLoops,
  classifyLoopEvidence,
  formatLoopReconciliation,
  type OpenLoop,
  type ReconciliationResult,
} from "../src/loop-reconciler.js";

describe("loadOpenLoops / saveOpenLoops", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "loops-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty array when no file exists", () => {
    assert.deepEqual(loadOpenLoops(home), []);
  });

  it("returns empty array when file is malformed JSON", () => {
    writeFileSync(join(home, "workspace", "memory", "open-loops.json"), "{ garbage");
    assert.deepEqual(loadOpenLoops(home), []);
  });

  it("roundtrips save → load", () => {
    const loops: OpenLoop[] = [
      { id: "torie-deposit", topic: "Torie micro-deposit", person: "Torie", phone: "+15551234", firstSeen: "2026-04-10", lastUpdated: "2026-04-20" },
      { id: "kr-email", topic: "Kingdom Roasters email system", firstSeen: "2026-04-09", lastUpdated: "2026-04-20" },
    ];
    saveOpenLoops(home, loops);
    const loaded = loadOpenLoops(home);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].id, "torie-deposit");
    assert.equal(loaded[0].phone, "+15551234");
  });

  it("filters out malformed entries silently", () => {
    writeFileSync(
      join(home, "workspace", "memory", "open-loops.json"),
      JSON.stringify([
        { id: "valid", topic: "valid topic", firstSeen: "2026-04-10", lastUpdated: "2026-04-10" },
        { missing_id: true },  // malformed
        "not an object",
        { id: "also-valid", topic: "another", firstSeen: "2026-04-11", lastUpdated: "2026-04-11" },
      ]),
    );
    const loops = loadOpenLoops(home);
    assert.equal(loops.length, 2);
  });
});

describe("classifyLoopEvidence", () => {
  it("returns 'resolved' when iMessage scan found an outgoing message", () => {
    const result = classifyLoopEvidence({
      hasIMessageEvidence: true,
      hasEmailEvidence: false,
    });
    assert.equal(result.kind, "resolved");
  });

  it("returns 'resolved' when email scan found a sent message", () => {
    const result = classifyLoopEvidence({
      hasIMessageEvidence: false,
      hasEmailEvidence: true,
    });
    assert.equal(result.kind, "resolved");
  });

  it("returns 'still-open' when no evidence was found", () => {
    const result = classifyLoopEvidence({
      hasIMessageEvidence: false,
      hasEmailEvidence: false,
    });
    assert.equal(result.kind, "still-open");
  });

  it("returns 'cannot-verify' when loop has no phone or email to check", () => {
    const result = classifyLoopEvidence({
      hasIMessageEvidence: false,
      hasEmailEvidence: false,
      noContactInfo: true,
    });
    assert.equal(result.kind, "cannot-verify");
  });
});

describe("formatLoopReconciliation", () => {
  const result: ReconciliationResult = {
    resolved: [
      {
        loop: { id: "torie", topic: "Torie micro-deposit", person: "Torie", phone: "+15551234", firstSeen: "2026-04-10", lastUpdated: "2026-04-20" },
        evidence: "Sent iMessage to +15551234 on 2026-04-20: \"verified, thanks!\"",
      },
    ],
    stillOpen: [
      {
        loop: { id: "kr-email", topic: "Kingdom Roasters email system", firstSeen: "2026-04-09", lastUpdated: "2026-04-20" },
        reason: "No outgoing messages found",
      },
    ],
    cannotVerify: [
      {
        loop: { id: "generic-task", topic: "AP Intego workers comp", firstSeen: "2026-04-15", lastUpdated: "2026-04-20" },
        reason: "No contact info to scan",
      },
    ],
  };

  it("emits a deterministic header with the non-negotiable trust directive", () => {
    const block = formatLoopReconciliation(result);
    assert.ok(block.includes("## Loop Reconciliation"));
    assert.ok(block.toLowerCase().includes("deterministic"));
    assert.ok(block.toLowerCase().includes("do not re-raise resolved"));
  });

  it("lists resolved loops with evidence so LLM must NOT re-raise them", () => {
    const block = formatLoopReconciliation(result);
    assert.ok(block.includes("Torie"));
    assert.ok(block.includes("verified, thanks"));
    assert.ok(block.toLowerCase().includes("resolved"));
  });

  it("lists still-open loops so the LLM can carry them forward", () => {
    const block = formatLoopReconciliation(result);
    assert.ok(block.includes("Kingdom Roasters"));
  });

  it("lists cannot-verify loops separately — agent must ASK user, not assume", () => {
    const block = formatLoopReconciliation(result);
    assert.ok(block.includes("AP Intego"));
    assert.ok(block.toLowerCase().includes("ask"));
  });

  it("gracefully handles empty result", () => {
    const empty: ReconciliationResult = { resolved: [], stillOpen: [], cannotVerify: [] };
    const block = formatLoopReconciliation(empty);
    assert.ok(block.toLowerCase().includes("no open loops"));
  });
});
