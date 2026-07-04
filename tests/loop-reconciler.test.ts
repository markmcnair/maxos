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
  imessageEvidenceFromCache,
  reconcileAllLoops,
  type OpenLoop,
  type ReconciliationResult,
} from "../src/loop-reconciler.js";
import { localScanTimestamp } from "../src/outgoing-dms-cache.js";

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

describe("imessageEvidenceFromCache", () => {
  // Cache window: generated 2026-07-03T19:00Z covering the trailing 168h.
  const cache = {
    generatedAt: new Date("2026-07-03T19:00:00Z"),
    hours: 168,
    lines: [
      "2026-07-03 13:54:22|+15012695797|Niiiiice lol",
      "and a continuation line with digits 5012695797 | pipes | too",
      "2026-07-01 09:15:00|+15017646415|Sent the deposit this morning",
      "2026-06-28 08:00:00|+15012695797|older message to Miguel",
    ],
  };

  it("cache hit: finds outgoing evidence for a contact since the bound", () => {
    const r = imessageEvidenceFromCache("+15017646415", "2026-06-30 00:00:00", cache);
    assert.ok(r);
    assert.equal(r.found, true);
    assert.ok(r.snippet?.includes("Sent the deposit"));
  });

  it("normalizes contact digits — formatting variants match the same handle", () => {
    for (const phone of ["+1 (501) 764-6415", "501.764.6415", "15017646415", "501-764-6415"]) {
      const r = imessageEvidenceFromCache(phone, "2026-06-30 00:00:00", cache);
      assert.ok(r, `servable for ${phone}`);
      assert.equal(r.found, true, `found for ${phone}`);
    }
  });

  it("since-bound filtering: lines before the bound don't count", () => {
    // Only line for this contact is 2026-07-01 09:15 — a later bound excludes it.
    const r = imessageEvidenceFromCache("+15017646415", "2026-07-02 00:00:00", cache);
    assert.ok(r);
    assert.equal(r.found, false, "authoritative negative within the cache window");
  });

  it("bound is inclusive (timestamp >= since)", () => {
    const r = imessageEvidenceFromCache("+15017646415", "2026-07-01 09:15:00", cache);
    assert.ok(r);
    assert.equal(r.found, true);
  });

  it("unknown contact within the window yields found:false, not a fallback", () => {
    const r = imessageEvidenceFromCache("+15559990000", "2026-06-30 00:00:00", cache);
    assert.ok(r);
    assert.equal(r.found, false);
  });

  it("out-of-window: since bound older than generated_at minus hours → null (fall back to spawn)", () => {
    // Window starts 2026-06-26T19:00Z; a 2026-06-20 bound predates it.
    assert.equal(imessageEvidenceFromCache("+15012695797", "2026-06-20 00:00:00", cache), null);
  });

  it("not servable for handles without 10 digits (emails, short codes) → null", () => {
    assert.equal(imessageEvidenceFromCache("miguel@example.com", "2026-06-30 00:00:00", cache), null);
    assert.equal(imessageEvidenceFromCache("865-30", "2026-06-30 00:00:00", cache), null);
    assert.equal(imessageEvidenceFromCache("", "2026-06-30 00:00:00", cache), null);
  });

  it("continuation lines never match, even when the body contains digits and pipes", () => {
    const bodyTrap = {
      ...cache,
      lines: ["and a continuation line with digits 5012695797 | pipes | too"],
    };
    const r = imessageEvidenceFromCache("+15012695797", "2026-06-30 00:00:00", bodyTrap);
    assert.ok(r);
    assert.equal(r.found, false);
  });

  it("snippet is the first matching line, trimmed to 120 chars", () => {
    const long = {
      ...cache,
      lines: [`2026-07-02 10:00:00|+15012695797|${"x".repeat(300)}`],
    };
    const r = imessageEvidenceFromCache("+15012695797", "2026-06-30 00:00:00", long);
    assert.ok(r);
    assert.equal(r.found, true);
    assert.equal(r.snippet?.length, 120);
  });
});

describe("reconcileAllLoops — cache-first iMessage evidence (FDA-safe path)", () => {
  let home: string;

  // A fake imessage-scan the spawn fallback will hit. Emits a distinctive
  // marker so tests can tell spawn evidence from cache evidence.
  const installFakeScan = () => {
    const toolsDir = join(home, "workspace", "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(
      join(toolsDir, "imessage-scan"),
      '#!/bin/sh\necho "2026-01-02 10:00:00|spawned|SPAWNED-EVIDENCE"\n',
      { mode: 0o755 },
    );
  };

  const writeCache = (obj: unknown) => {
    writeFileSync(
      join(home, "workspace", "memory", "outgoing-dms-cache.json"),
      JSON.stringify(obj),
    );
  };

  const daysAgoYmd = (days: number) =>
    localScanTimestamp(new Date(Date.now() - days * 24 * 3_600_000)).slice(0, 10);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "loops-cache-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
    installFakeScan();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves a loop from the cache without spawning", async () => {
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      hours: 168,
      lines: [`${localScanTimestamp(new Date(Date.now() - 24 * 3_600_000))}|+15012695797|Paid you back just now`],
    });
    saveOpenLoops(home, [
      { id: "miguel-repay", topic: "Miguel repayment", person: "Miguel", phone: "+1 (501) 269-5797", firstSeen: daysAgoYmd(10), lastUpdated: daysAgoYmd(3) },
    ]);

    const result = await reconcileAllLoops(home);
    assert.equal(result.resolved.length, 1);
    assert.ok(result.resolved[0].evidence.includes("Paid you back"), "evidence must come from the cache");
    assert.ok(!result.resolved[0].evidence.includes("SPAWNED-EVIDENCE"));
  });

  it("cache negative within the window is authoritative — no spawn, loop stays open", async () => {
    // The fake scan WOULD return evidence; a still-open result proves the
    // spawn was never consulted when the fresh cache covers the query.
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      hours: 168,
      lines: [`${localScanTimestamp(new Date(Date.now() - 24 * 3_600_000))}|+15550001111|message to someone else`],
    });
    saveOpenLoops(home, [
      { id: "torie-deposit", topic: "Torie micro-deposit", person: "Torie", phone: "+15012695797", firstSeen: daysAgoYmd(10), lastUpdated: daysAgoYmd(3) },
    ]);

    const result = await reconcileAllLoops(home);
    assert.equal(result.stillOpen.length, 1);
    assert.equal(result.resolved.length, 0);
  });

  it("since bound older than the cache window falls back to spawn", async () => {
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      hours: 168,
      lines: [],
    });
    saveOpenLoops(home, [
      { id: "ancient", topic: "Ancient loop", person: "Old", phone: "+15012695797", firstSeen: "2020-01-01", lastUpdated: "2020-01-01" },
    ]);

    const result = await reconcileAllLoops(home);
    assert.equal(result.resolved.length, 1);
    assert.ok(result.resolved[0].evidence.includes("SPAWNED-EVIDENCE"), "out-of-window query must use the real scan");
  });

  it("stale cache falls back to spawn", async () => {
    writeCache({
      generated_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),  // 46 min old
      ok: true,
      hours: 168,
      lines: [`${localScanTimestamp(new Date(Date.now() - 24 * 3_600_000))}|+15012695797|would match if fresh`],
    });
    saveOpenLoops(home, [
      { id: "miguel-repay", topic: "Miguel repayment", person: "Miguel", phone: "+15012695797", firstSeen: daysAgoYmd(10), lastUpdated: daysAgoYmd(3) },
    ]);

    const result = await reconcileAllLoops(home);
    assert.equal(result.resolved.length, 1);
    assert.ok(result.resolved[0].evidence.includes("SPAWNED-EVIDENCE"), "stale cache must not be used");
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
