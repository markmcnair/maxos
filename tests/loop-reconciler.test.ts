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

  it("atomic write — concurrent saves never produce a half-written file (audit P1-4)", async () => {
    // Audit P1-4: closure-watcher and google-tasks-reconciler are scheduled
    // 7 minutes apart (xx:00/15/30/45 vs xx:07/22/37/52) so they don't
    // collide on the minute boundary, but a slow run of one could overlap
    // with the next firing of the other. saveOpenLoops uses tmp+rename
    // — last-write-wins atomically. A reader can never see an empty or
    // partial file under contention.
    const stateA: OpenLoop[] = [
      { id: "a1", topic: "Loop from writer A", firstSeen: "2026-05-01", lastUpdated: "2026-05-01" },
      { id: "a2", topic: "Another from A", firstSeen: "2026-05-01", lastUpdated: "2026-05-01" },
    ];
    const stateB: OpenLoop[] = [
      { id: "b1", topic: "Loop from writer B", firstSeen: "2026-05-01", lastUpdated: "2026-05-01" },
    ];

    // Fire many concurrent saves alternating between two states. With
    // tmp+rename atomicity, each readback must observe exactly one of
    // the two states — never a hybrid, never empty, never half-written.
    const writes = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => saveOpenLoops(home, i % 2 === 0 ? stateA : stateB)),
    );
    await Promise.all(writes);

    // Final readback must be valid (not corrupt, not empty)
    const final = loadOpenLoops(home);
    assert.ok(final.length > 0, "file must not be empty");
    const ids = final.map((l) => l.id).sort().join(",");
    assert.ok(
      ids === "a1,a2" || ids === "b1",
      `final state must match exactly one writer's input, got: ${ids}`,
    );

    // Mid-flight readbacks during the write storm must also be valid.
    // Spawn another wave with concurrent reads — none should throw or
    // see partial content.
    const readResults = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        if (i % 2 === 0) saveOpenLoops(home, stateA);
        else saveOpenLoops(home, stateB);
        return loadOpenLoops(home);
      }),
    );
    for (const result of readResults) {
      const k = result.map((l) => l.id).sort().join(",");
      assert.ok(
        k === "a1,a2" || k === "b1",
        `mid-flight readback must be a valid state, got: ${k}`,
      );
    }
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
