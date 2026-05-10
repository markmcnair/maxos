import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseClosureLine,
  isDropDecision,
  findMatchingLoop,
  applyDropDecisionsToLoops,
  parseNewLoopFact,
  applyNewLoopFactsFromClosures,
} from "../src/closures-to-loops.js";
import type { OpenLoop } from "../src/loop-reconciler.js";

describe("parseClosureLine", () => {
  it("parses a CLOSURE entry", () => {
    const e = parseClosureLine("- [09:30] [CLOSURE] sent Alfonso the wholesale list");
    assert.equal(e?.tag, "CLOSURE");
    assert.equal(e?.time, "09:30");
    assert.equal(e?.body, "sent Alfonso the wholesale list");
  });

  it("parses a DECISION entry", () => {
    const e = parseClosureLine("- [10:00] [DECISION] dropped the Robert Scott SIMPLE IRA loop");
    assert.equal(e?.tag, "DECISION");
    assert.equal(e?.body, "dropped the Robert Scott SIMPLE IRA loop");
  });

  it("parses a FACT entry", () => {
    const e = parseClosureLine("- [15:29] [FACT] Ruth admitted to ER");
    assert.equal(e?.tag, "FACT");
  });

  it("returns null for non-matching lines", () => {
    assert.equal(parseClosureLine("not a closure line"), null);
    assert.equal(parseClosureLine(""), null);
    assert.equal(parseClosureLine("# Header"), null);
  });

  it("tolerates trailing whitespace", () => {
    const e = parseClosureLine("- [09:30] [CLOSURE] body text   ");
    assert.equal(e?.body, "body text");
  });
});

describe("isDropDecision", () => {
  it("recognizes dropping language", () => {
    const cases = [
      "dropped the Mike Salem MNDA loop",
      "killing the Robert Scott thread",
      "Mike Salem stuff is over",
      "Dave Creek deal is dead",
      "no longer pursuing this",
      "was wrong, that was never real",
      "is fake, totally irrelevant",
      "abandoned the acquisition path",
      "paused indefinitely",
    ];
    for (const body of cases) {
      assert.equal(
        isDropDecision({ tag: "DECISION", time: "10:00", body }),
        true,
        `should recognize: ${body}`,
      );
    }
  });

  it("does not flag CLOSURE or FACT entries", () => {
    assert.equal(isDropDecision({ tag: "CLOSURE", time: "10:00", body: "dropped X" }), false);
    assert.equal(isDropDecision({ tag: "FACT", time: "10:00", body: "X is dead" }), false);
  });

  it("does not flag DECISION entries that aren't drops", () => {
    assert.equal(
      isDropDecision({ tag: "DECISION", time: "10:00", body: "going with option B" }),
      false,
    );
    assert.equal(
      isDropDecision({ tag: "DECISION", time: "10:00", body: "moving the Tuesday meeting to Thursday" }),
      false,
    );
  });
});

describe("findMatchingLoop", () => {
  const loops: OpenLoop[] = [
    { id: "mike-salem-mnda", topic: "Mike Salem MNDA + financials", person: "Mike Salem", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
    { id: "kr-wholesale", topic: "Kingdom Roasters wholesale list", person: "Alfonso", firstSeen: "2026-04-09", lastUpdated: "2026-04-24" },
    { id: "rachel-newlywed-basket", topic: "Rachel gift card basket", person: "Rachel Myers", firstSeen: "2026-04-21", lastUpdated: "2026-04-24" },
  ];

  it("matches by literal id", () => {
    const m = findMatchingLoop(loops, "dropped mike-salem-mnda — Glenn is the right contact");
    assert.equal(m?.id, "mike-salem-mnda");
  });

  it("matches by person name", () => {
    const m = findMatchingLoop(loops, "Rachel Myers basket loop is over, Mark closed it");
    assert.equal(m?.id, "rachel-newlywed-basket");
  });

  it("matches by topic phrase", () => {
    const m = findMatchingLoop(loops, "Kingdom Roasters wholesale was already shipped — drop");
    assert.equal(m?.id, "kr-wholesale");
  });

  it("returns null when no match", () => {
    assert.equal(findMatchingLoop(loops, "totally unrelated text about something else"), null);
  });
});

describe("applyDropDecisionsToLoops (with file system)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "drop-loops-"));
    mkdirSync(join(tmp, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function writeOpenLoops(loops: OpenLoop[]) {
    writeFileSync(
      join(tmp, "workspace", "memory", "open-loops.json"),
      JSON.stringify(loops, null, 2),
    );
  }
  function readOpenLoops(): OpenLoop[] {
    return JSON.parse(readFileSync(join(tmp, "workspace", "memory", "open-loops.json"), "utf-8"));
  }

  it("does nothing when no closures file", () => {
    writeOpenLoops([
      { id: "mike-salem", topic: "Mike Salem MNDA", person: "Mike Salem", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
    ]);
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    assert.deepEqual(r.removed, []);
    assert.equal(readOpenLoops().length, 1);
  });

  it("removes a loop when a [DECISION] drop is found in today's closures", () => {
    writeOpenLoops([
      { id: "mike-salem", topic: "Mike Salem MNDA + financials", person: "Mike Salem", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
      { id: "kr-wholesale", topic: "Kingdom Roasters wholesale", person: "Alfonso", firstSeen: "2026-04-09", lastUpdated: "2026-04-24" },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [10:30] [DECISION] dropped Mike Salem MNDA loop — irrelevant, Dave Creek paused indefinitely\n",
    );
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    assert.deepEqual(r.removed, ["mike-salem"]);
    const remaining = readOpenLoops();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "kr-wholesale");
  });

  it("regression: the literal Mike Salem / Glenn correction case from 2026-04-27", () => {
    writeOpenLoops([
      {
        id: "mike-salem-mnda-financials",
        topic: "Mike Salem acquisition — MNDA + seller financials",
        person: "Mike Salem",
        firstSeen: "2026-04-22",
        lastUpdated: "2026-04-24",
      },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [09:55] [DECISION] dropped mike-salem-mnda-financials — Glenn is correct contact, Dave Creek deal paused indefinitely or dead\n",
    );
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    assert.deepEqual(r.removed, ["mike-salem-mnda-financials"]);
    assert.equal(readOpenLoops().length, 0);
  });

  it("processes both today's and yesterday's closures", () => {
    writeOpenLoops([
      { id: "old-loop", topic: "Old loop topic words here", person: "Someone", firstSeen: "2026-04-20", lastUpdated: "2026-04-24" },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-26.md"),
      "- [16:00] [DECISION] killing the old-loop — done\n",
    );
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    assert.deepEqual(r.removed, ["old-loop"]);
  });

  it("ignores [CLOSURE] entries even if they contain drop words", () => {
    writeOpenLoops([
      { id: "x", topic: "X loop body words", person: "Sender", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [10:00] [CLOSURE] texted Sender — said the dropped package was on the porch\n",
    );
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    assert.deepEqual(r.removed, []);
  });

  it("appends a permanent tombstone to dropped-loops.md when a verbal drop matches (audit P1-3)", () => {
    // Audit P1-3: verbal drops were 2-day-window only (closures file is
    // scanned for today + yesterday). After 2 days they stop being
    // enforced unless the LLM re-issues the drop. Now they get a permanent
    // tombstone — same path as Google-Task-deletion drops.
    writeOpenLoops([
      {
        id: "robert-scott-ira",
        topic: "Robert Scott Edward Jones SIMPLE IRA",
        person: "Robert Scott",
        firstSeen: "2026-04-22",
        lastUpdated: "2026-04-24",
      },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [11:00] [DECISION] dropped robert-scott-ira — Mark said this is OVER\n",
    );

    applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));

    const droppedPath = join(tmp, "workspace", "memory", "dropped-loops.md");
    assert.ok(
      readFileSync(droppedPath, "utf-8").includes("(loop:robert-scott-ira)"),
      "verbal drop must write a permanent tombstone",
    );
  });

  it("preserves loops that aren't matched by any drop decision", () => {
    writeOpenLoops([
      { id: "alice-onboarding", topic: "Alice onboarding paperwork", person: "Alice Smith", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
      { id: "bob-invoice-followup", topic: "Bob invoice follow-up call", person: "Bob Jones", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [10:00] [DECISION] dropped bob-invoice-followup — Bob handled it himself\n",
    );
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    assert.deepEqual(r.removed, ["bob-invoice-followup"]);
    assert.equal(readOpenLoops().length, 1);
    assert.equal(readOpenLoops()[0].id, "alice-onboarding");
  });

  it("does NOT drop a loop on benign chat that mentions a single first name (regression for ISSUE-002)", () => {
    writeOpenLoops([
      {
        id: "kr-wholesale-testimonials",
        topic: "Kingdom Roasters wholesale + testimonials",
        person: "Alfonso",
        firstSeen: "2026-04-09",
        lastUpdated: "2026-04-24",
      },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [10:00] [DECISION] Going to start over with the Alfonso plan tomorrow morning\n",
    );
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    // "start over" no longer matches (bare \bover\b removed)
    // Single-name "Alfonso" no longer matches (multi-token requirement)
    assert.deepEqual(r.removed, []);
    assert.equal(readOpenLoops().length, 1);
  });

  it("does NOT drop on prefix-only id collision (regression for ISSUE-005)", () => {
    writeOpenLoops([
      { id: "kr", topic: "KR thread placeholder", person: "K R", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
      { id: "kr-wholesale-testimonials", topic: "Kingdom Roasters wholesale plus testimonials", person: "Alfonso", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [10:00] [DECISION] dropped kr-wholesale-testimonials — board meeting moved\n",
    );
    const r = applyDropDecisionsToLoops(tmp, new Date("2026-04-27T12:00:00"));
    // Longer-id-first prevents "kr" from matching inside "kr-wholesale-testimonials"
    assert.deepEqual(r.removed, ["kr-wholesale-testimonials"]);
    assert.equal(readOpenLoops().length, 1);
    assert.equal(readOpenLoops()[0].id, "kr");
  });
});

describe("parseNewLoopFact", () => {
  it("parses a valid FACT new-loop line with required fields", () => {
    const line = `- [16:42] [FACT] new-loop {"id":"alfonso-restock","topic":"Send Alfonso the wholesale price sheet","person":"Alfonso","phone":"+15555555555"}`;
    const r = parseNewLoopFact(line);
    assert.deepEqual(r, {
      id: "alfonso-restock",
      topic: "Send Alfonso the wholesale price sheet",
      person: "Alfonso",
      phone: "+15555555555",
    });
  });

  it("parses with only required id+topic (other fields omitted)", () => {
    const line = `- [16:42] [FACT] new-loop {"id":"x","topic":"Y"}`;
    const r = parseNewLoopFact(line);
    assert.deepEqual(r, { id: "x", topic: "Y" });
  });

  it("returns null for non-FACT lines", () => {
    assert.equal(
      parseNewLoopFact(`- [16:42] [DECISION] dropped (x) — Google Task deleted`),
      null,
    );
    assert.equal(
      parseNewLoopFact(`- [16:42] [CLOSURE] texted Alfonso`),
      null,
    );
  });

  it("returns null for FACT lines that aren't new-loop", () => {
    assert.equal(
      parseNewLoopFact(`- [16:42] [FACT] Mike Salem is not a recurring attendee`),
      null,
    );
  });

  it("returns null for malformed JSON", () => {
    assert.equal(
      parseNewLoopFact(`- [16:42] [FACT] new-loop {garbage}`),
      null,
    );
    assert.equal(
      parseNewLoopFact(`- [16:42] [FACT] new-loop`),
      null,
    );
  });

  it("returns null when required fields are missing", () => {
    // missing id
    assert.equal(
      parseNewLoopFact(`- [16:42] [FACT] new-loop {"topic":"Y"}`),
      null,
    );
    // missing topic
    assert.equal(
      parseNewLoopFact(`- [16:42] [FACT] new-loop {"id":"x"}`),
      null,
    );
    // empty id/topic — vacuously bad
    assert.equal(
      parseNewLoopFact(`- [16:42] [FACT] new-loop {"id":"","topic":"Y"}`),
      null,
    );
  });
});

describe("applyNewLoopFactsFromClosures (with file system)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fact-loops-"));
    mkdirSync(join(tmp, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function writeOpenLoops(loops: any[]) {
    writeFileSync(
      join(tmp, "workspace", "memory", "open-loops.json"),
      JSON.stringify(loops, null, 2),
    );
  }
  function readOpenLoops(): any[] {
    return JSON.parse(readFileSync(join(tmp, "workspace", "memory", "open-loops.json"), "utf-8"));
  }

  it("appends new loops from today's [FACT] new-loop lines (P0-1 fix)", () => {
    // P0-1 was: shutdown-debrief LLM Edit-writing open-loops.json with no
    // atomic seam, racing against closure-watcher and reconciler. The fix
    // is to have the LLM emit FACT lines that a deterministic processor
    // (this function) picks up and adds atomically.
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-02.md"),
      `- [16:42] [FACT] new-loop {"id":"alfonso-restock","topic":"Send Alfonso the wholesale list","person":"Alfonso","phone":"+15555555555"}\n`,
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-02T17:00:00"));
    assert.deepEqual(r.added, ["alfonso-restock"]);
    const loops = readOpenLoops();
    assert.equal(loops.length, 1);
    assert.equal(loops[0].id, "alfonso-restock");
    assert.equal(loops[0].topic, "Send Alfonso the wholesale list");
    assert.equal(loops[0].person, "Alfonso");
    assert.equal(loops[0].phone, "+15555555555");
    assert.equal(loops[0].firstSeen, "2026-05-02");
    assert.equal(loops[0].lastUpdated, "2026-05-02");
  });

  it("is idempotent — running twice doesn't duplicate", () => {
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-02.md"),
      `- [16:42] [FACT] new-loop {"id":"x","topic":"Y"}\n`,
    );
    applyNewLoopFactsFromClosures(tmp, new Date("2026-05-02T17:00:00"));
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-02T17:00:00"));
    assert.deepEqual(r.added, []);  // already present
    assert.equal(readOpenLoops().length, 1);
  });

  it("blocks new loops whose id is on the dropped-loops.md tombstone list", () => {
    // If the LLM tries to re-add a previously-deleted loop (because it
    // surfaced again in a meeting transcript), the tombstone wins.
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "dropped-loops.md"),
      `## Active Drops\n- **Some old topic** — dropped 2026-04-30 via Google Task deletion. Reason: x. (loop:already-killed)\n`,
    );
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-02.md"),
      `- [16:42] [FACT] new-loop {"id":"already-killed","topic":"LLM is trying to re-add this"}\n`,
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-02T17:00:00"));
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.blockedByTombstone, ["already-killed"]);
    assert.equal(readOpenLoops().length, 0);
  });

  it("processes both today's and yesterday's closures", () => {
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-01.md"),
      `- [22:00] [FACT] new-loop {"id":"yesterday-loop","topic":"From yesterday"}\n`,
    );
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-02.md"),
      `- [09:00] [FACT] new-loop {"id":"today-loop","topic":"From today"}\n`,
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-02T17:00:00"));
    assert.deepEqual(r.added.sort(), ["today-loop", "yesterday-loop"]);
    assert.equal(readOpenLoops().length, 2);
  });

  it("ignores malformed lines without crashing", () => {
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-02.md"),
      `- [09:00] [FACT] new-loop {garbage\n` +
        `- [10:00] [FACT] new-loop {"id":"valid","topic":"Valid loop"}\n` +
        `- [11:00] [FACT] new-loop {"id":""}\n`,  // empty id
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-02T17:00:00"));
    assert.deepEqual(r.added, ["valid"]);
    assert.equal(readOpenLoops().length, 1);
  });

  it("preserves existing open-loops untouched (no clobbering)", () => {
    writeOpenLoops([
      {
        id: "existing",
        topic: "Already there",
        person: "Existing",
        firstSeen: "2026-04-28",
        lastUpdated: "2026-04-30",
      },
    ]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-02.md"),
      `- [09:00] [FACT] new-loop {"id":"new","topic":"Fresh"}\n`,
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-02T17:00:00"));
    assert.deepEqual(r.added, ["new"]);
    const loops = readOpenLoops();
    assert.equal(loops.length, 2);
    // Existing loop preserved exactly
    const existing = loops.find((l) => l.id === "existing");
    assert.equal(existing.firstSeen, "2026-04-28");
    assert.equal(existing.lastUpdated, "2026-04-30");
    assert.equal(existing.person, "Existing");
  });

  it("does NOT re-add a loop whose FACT was already resolved by a CLOSURE in the same window (Round V — Toyota dup-fire fix)", () => {
    // Round V root cause: debrief LLM emits [FACT] new-loop at 16:35.
    // Closure-watcher adds it. Reconciler closes it (CLOSURE line + remove
    // from open-loops). Next closure-watcher cycle re-reads the SAME FACT
    // line (file is append-only) and re-adds the loop. Reconciler closes
    // it again. Cycle repeats every 30 min for 48h until the FACT line
    // ages out of the 2-day scan window.
    //
    // Fix: before re-adding from a FACT line, scan the same closures files
    // for any [CLOSURE] or [DECISION] referencing the same loop id with a
    // timestamp AFTER the FACT. If found, the FACT was already consumed —
    // skip silently.
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-03.md"),
      [
        `- [16:35] [FACT] new-loop {"id":"miguel-toyota-pickup","topic":"Confirm Toyota pickup","person":"Miguel"}`,
        `- [17:30] [CLOSURE] Google Task completed — Confirm Toyota pickup (loop miguel-toyota-pickup)`,
      ].join("\n") + "\n",
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-03T18:15:00"));
    assert.deepEqual(r.added, [], "FACT already resolved by a CLOSURE on the same loop id — should not re-add");
    assert.equal(readOpenLoops().length, 0);
  });

  it("does NOT re-add a loop whose FACT was resolved by a DECISION drop (same closures-window)", () => {
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-03.md"),
      [
        `- [16:35] [FACT] new-loop {"id":"some-loop-id","topic":"Some topic"}`,
        `- [17:00] [DECISION] dropped (some-loop-id) — Mark explicitly killed`,
      ].join("\n") + "\n",
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-03T18:15:00"));
    assert.deepEqual(r.added, [], "FACT already resolved by a DECISION drop — should not re-add");
    assert.equal(readOpenLoops().length, 0);
  });

  it("DOES add a loop when the FACT precedes any resolution (the normal first-time path)", () => {
    // Sanity: FACT alone, no CLOSURE/DECISION yet → loop should be added.
    // Confirms we didn't break the happy path.
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-03.md"),
      `- [16:35] [FACT] new-loop {"id":"fresh-loop","topic":"Fresh topic"}\n`,
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-03T16:45:00"));
    assert.deepEqual(r.added, ["fresh-loop"]);
    assert.equal(readOpenLoops().length, 1);
  });

  it("treats CLOSURE that PRECEDES the FACT as not-resolving (FACT may be a re-creation)", () => {
    // If timestamp ordering is FACT-after-CLOSURE, the FACT is fresh —
    // the user/LLM intentionally re-introduced the loop after a prior
    // closure. Allow it (caller's tombstone check would have blocked
    // it if Mark really wanted it dead permanently).
    writeOpenLoops([]);
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-05-03.md"),
      [
        `- [09:00] [CLOSURE] Google Task completed — old Toyota loop (loop miguel-toyota-pickup)`,
        `- [16:35] [FACT] new-loop {"id":"miguel-toyota-pickup","topic":"Re-raised after closure"}`,
      ].join("\n") + "\n",
    );
    const r = applyNewLoopFactsFromClosures(tmp, new Date("2026-05-03T17:00:00"));
    assert.deepEqual(r.added, ["miguel-toyota-pickup"]);
  });
});
