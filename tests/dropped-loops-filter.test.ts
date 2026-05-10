import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import {
  parseDroppedTopics,
  stripDroppedFromOutput,
  pruneOpenLoopsAgainstDropped,
  appendDroppedLoop,
  loadDroppedLoopIds,
} from "../src/dropped-loops-filter.js";
import type { OpenLoop } from "../src/loop-reconciler.js";

describe("parseDroppedTopics", () => {
  it("extracts bolded topic titles from dropped-loops.md", () => {
    const md = `## Active Drops

- **Torie micro-deposit verification** — dropped 2026-04-21. Reason: Mark said it's DONE.
- **Robert Scott SIMPLE IRA** — dropped 2026-04-15. Reason: OVER.
- **William Crockett RSVP** — dropped 2026-04-13.`;
    const topics = parseDroppedTopics(md);
    assert.equal(topics.length, 3);
    assert.ok(topics.includes("Torie micro-deposit verification"));
    assert.ok(topics.includes("Robert Scott SIMPLE IRA"));
  });

  it("returns empty array for empty / missing content", () => {
    assert.deepEqual(parseDroppedTopics(""), []);
    assert.deepEqual(parseDroppedTopics("# Only a heading"), []);
  });

  it("ignores entries that aren't bolded", () => {
    const md = `- plain item\n- **Real item** — dropped`;
    const topics = parseDroppedTopics(md);
    assert.deepEqual(topics, ["Real item"]);
  });
});

describe("stripDroppedFromOutput", () => {
  const output = `# Shutdown Debrief

## ✅ Wins
- Torie micro-deposit — officially closed today (Mark confirmed)
- Glenn meeting went great

## 👻 Ghosted
- Miguel — 4:08pm needs reply

## 🔄 Open Loops
- Torie micro-deposit — Day 12+ stale. Will rot.
- Kingdom Roasters — carries to Monday
- AP Intego workers' comp — verify status

## 🎯 Top 3 for Tomorrow
1. Resolve 9:30am double-book
2. Torie — do it or drop it (Day 12)
3. Alex prep

## 📅 Tomorrow
- 8am Alex`;

  it("removes lines under Open Loops containing a dropped topic keyword", () => {
    const filtered = stripDroppedFromOutput(output, ["Torie micro-deposit verification"]);
    const openLoops = filtered.split("## 🔄 Open Loops")[1]?.split("##")[0] ?? "";
    assert.ok(!openLoops.toLowerCase().includes("torie"), "Torie should be stripped from Open Loops");
    assert.ok(openLoops.includes("Kingdom Roasters"), "other loops must remain");
    assert.ok(openLoops.includes("AP Intego"), "other loops must remain");
  });

  it("removes lines under Top 3 containing a dropped topic keyword", () => {
    const filtered = stripDroppedFromOutput(output, ["Torie micro-deposit verification"]);
    const top3 = filtered.split("## 🎯 Top 3")[1]?.split("##")[0] ?? "";
    assert.ok(!top3.toLowerCase().includes("torie"), "Torie should not appear in Top 3");
  });

  it("leaves Wins section untouched — dropped items CAN appear in Wins", () => {
    const filtered = stripDroppedFromOutput(output, ["Torie micro-deposit verification"]);
    const wins = filtered.split("## ✅ Wins")[1]?.split("##")[0] ?? "";
    assert.ok(wins.toLowerCase().includes("torie"), "Wins may legitimately reference dropped items");
  });

  it("leaves Ghosted untouched (Ghosted is a separate flow)", () => {
    const filtered = stripDroppedFromOutput(output, ["Torie micro-deposit verification"]);
    const ghosted = filtered.split("## 👻 Ghosted")[1]?.split("##")[0] ?? "";
    assert.ok(ghosted.includes("Miguel"));
  });

  it("handles multiple dropped topics", () => {
    const filtered = stripDroppedFromOutput(output, [
      "Torie micro-deposit verification",
      "Kingdom Roasters email",
    ]);
    const openLoops = filtered.split("## 🔄 Open Loops")[1]?.split("##")[0] ?? "";
    assert.ok(!openLoops.toLowerCase().includes("torie"));
    assert.ok(!openLoops.toLowerCase().includes("kingdom roasters"));
    assert.ok(openLoops.includes("AP Intego"));
  });

  it("no-ops when there are no dropped topics", () => {
    const filtered = stripDroppedFromOutput(output, []);
    assert.equal(filtered, output);
  });

  it("preserves section headers even when every item under a section is stripped", () => {
    const allDropped = `## 🔄 Open Loops\n- Torie thing\n- Torie other\n\n## 📅 Tomorrow\n- 8am event`;
    const filtered = stripDroppedFromOutput(allDropped, ["Torie"]);
    assert.ok(filtered.includes("## 🔄 Open Loops"));
    assert.ok(filtered.includes("## 📅 Tomorrow"));
  });
});

describe("pruneOpenLoopsAgainstDropped", () => {
  it("removes loops whose topic matches a dropped entry", () => {
    const loops: OpenLoop[] = [
      { id: "torie", topic: "Torie micro-deposit verification", person: "Torie", firstSeen: "2026-04-10", lastUpdated: "2026-04-20" },
      { id: "kr-email", topic: "Kingdom Roasters email system", firstSeen: "2026-04-09", lastUpdated: "2026-04-20" },
    ];
    const { remaining, pruned } = pruneOpenLoopsAgainstDropped(loops, ["Torie micro-deposit"]);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "kr-email");
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0].id, "torie");
  });

  it("matches by person name or topic substring", () => {
    const loops: OpenLoop[] = [
      { id: "torie", topic: "micro-deposit verification", person: "Torie", firstSeen: "2026-04-10", lastUpdated: "2026-04-20" },
    ];
    const { remaining, pruned } = pruneOpenLoopsAgainstDropped(loops, ["Torie micro-deposit"]);
    assert.equal(remaining.length, 0);
    assert.equal(pruned.length, 1);
  });

  it("returns everything when no dropped topics", () => {
    const loops: OpenLoop[] = [
      { id: "a", topic: "Thing A", firstSeen: "2026-04-10", lastUpdated: "2026-04-20" },
    ];
    const { remaining, pruned } = pruneOpenLoopsAgainstDropped(loops, []);
    assert.equal(remaining.length, 1);
    assert.equal(pruned.length, 0);
  });

  it("does NOT prune loops whose topic incidentally contains a single-word dropped keyword (Joey Cook regression)", () => {
    // The pre-existing "Project Zero Spring Spectacular" dropped entry
    // produces single-word keyword "project". Joey Cook's loop topic
    // mentions "Eden Project Mission Partner" — totally unrelated. The
    // old impl pruned Joey because "project" matched in topic free-text.
    // Single-word keywords must now only match id/person, not topic.
    const loops: OpenLoop[] = [
      {
        id: "joey-cook-chris-kear",
        topic: "Joey Cook — Chris Kear / Eden Project Mission Partner recommendation",
        person: "Joey Cook",
        firstSeen: "2026-04-23",
        lastUpdated: "2026-04-24",
      },
    ];
    const { remaining, pruned } = pruneOpenLoopsAgainstDropped(loops, [
      "Project Zero Spring Spectacular",
    ]);
    assert.equal(pruned.length, 0, "Joey Cook should NOT be pruned");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "joey-cook-chris-kear");
  });

  it("does prune loops whose id or person matches a single-word dropped keyword", () => {
    // Single-word fallback still works against id/person — Torie's loop
    // gets pruned by "torie" matching her person field.
    const loops: OpenLoop[] = [
      { id: "torie-microdeposit", topic: "Some completely unrelated topic", person: "Torie", firstSeen: "2026-04-10", lastUpdated: "2026-04-20" },
    ];
    const { remaining, pruned } = pruneOpenLoopsAgainstDropped(loops, ["Torie micro-deposit verification"]);
    assert.equal(pruned.length, 1);
    assert.equal(remaining.length, 0);
  });

  it("prunes by exact loop id match when ids are provided (Round O+ exact-match path)", () => {
    // Audit P0-2: the (loop:xxx) markers in dropped-loops.md let us
    // bullet-proof against the LLM re-adding a previously-deleted loop with
    // the same id. Keyword matching can miss cases where the new loop's
    // topic was reworded; exact id match catches them all.
    const loops: OpenLoop[] = [
      {
        id: "kcr-wholesale-ordering-v1",
        topic: "Totally different wording that wouldn't keyword-match",
        firstSeen: "2026-05-01",
        lastUpdated: "2026-05-01",
      },
      {
        id: "untouched-loop",
        topic: "Other thing",
        firstSeen: "2026-05-01",
        lastUpdated: "2026-05-01",
      },
    ];
    const { remaining, pruned } = pruneOpenLoopsAgainstDropped(
      loops,
      [],  // no topic keywords
      ["kcr-wholesale-ordering-v1"],  // but exact id match
    );
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0].id, "kcr-wholesale-ordering-v1");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "untouched-loop");
  });
});

describe("appendDroppedLoop", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "maxos-dropped-loops-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates dropped-loops.md with header when file doesn't exist", () => {
    appendDroppedLoop(tmpHome, {
      topic: "KCR wholesale ordering system v1",
      loopId: "kcr-wholesale-ordering-v1",
      date: "2026-04-30",
      reason: 'Mark deleted Google Task from "🤖 MaxOS Loops"',
      source: "google-task-deletion",
    });

    const path = join(tmpHome, "workspace", "memory", "dropped-loops.md");
    assert.ok(existsSync(path), "file should be created");
    const content = readFileSync(path, "utf-8");
    assert.ok(content.includes("# Dropped Loops"), "should have header");
    assert.ok(content.includes("## Active Drops"), "should have Active Drops section");
    assert.ok(content.includes("**KCR wholesale ordering system v1**"), "should bold the topic");
    assert.ok(content.includes("2026-04-30"), "should include date");
    assert.ok(content.includes("(loop:kcr-wholesale-ordering-v1)"), "should include loop id marker");
    assert.ok(content.includes("Google Task deletion"), "should mention source");
  });

  it("appends to existing file under Active Drops section", () => {
    const existing = `---
name: dropped-loops
description: Persistent list
type: reference
---

# Dropped Loops

When Mark says "drop it"...

Format: \`- **[Topic]** — dropped [date]. Reason: [reason]\`

## Active Drops

- **First existing drop** — dropped 2026-04-01. Reason: Mark said skip.
`;
    mkdirSync(join(tmpHome, "workspace", "memory"), { recursive: true });
    writeFileSync(join(tmpHome, "workspace", "memory", "dropped-loops.md"), existing);

    appendDroppedLoop(tmpHome, {
      topic: "New drop",
      loopId: "new-drop-id",
      date: "2026-04-30",
      reason: "Mark deleted task",
      source: "google-task-deletion",
    });

    const content = readFileSync(join(tmpHome, "workspace", "memory", "dropped-loops.md"), "utf-8");
    assert.ok(content.includes("First existing drop"), "preserves existing entries");
    assert.ok(content.includes("New drop"), "appends new entry");
    // New entry comes after existing one
    const firstIdx = content.indexOf("First existing drop");
    const newIdx = content.indexOf("New drop");
    assert.ok(firstIdx < newIdx, "new entry comes after existing");
  });

  it("is idempotent — same loop id twice writes only one entry", () => {
    appendDroppedLoop(tmpHome, {
      topic: "Topic A",
      loopId: "loop-x",
      date: "2026-04-30",
      reason: "test",
      source: "google-task-deletion",
    });
    appendDroppedLoop(tmpHome, {
      topic: "Topic A different wording",
      loopId: "loop-x",  // same id
      date: "2026-04-30",
      reason: "test",
      source: "google-task-deletion",
    });

    const content = readFileSync(join(tmpHome, "workspace", "memory", "dropped-loops.md"), "utf-8");
    const occurrences = content.match(/\(loop:loop-x\)/g) ?? [];
    assert.equal(occurrences.length, 1, "should only write loop id once");
  });

  it("includes person in bolded heading when provided", () => {
    appendDroppedLoop(tmpHome, {
      topic: "Some task",
      loopId: "p-loop",
      date: "2026-04-30",
      reason: "deleted",
      source: "google-task-deletion",
      person: "Daniel",
    });

    const content = readFileSync(join(tmpHome, "workspace", "memory", "dropped-loops.md"), "utf-8");
    assert.ok(content.includes("**Some task** (Daniel)"), "should include person in parens after bolded topic");
  });

  it("creates Active Drops section if missing", () => {
    // Edge case: file exists but has no Active Drops header
    const existing = `# Dropped Loops\n\nSome intro text.\n`;
    mkdirSync(join(tmpHome, "workspace", "memory"), { recursive: true });
    writeFileSync(join(tmpHome, "workspace", "memory", "dropped-loops.md"), existing);

    appendDroppedLoop(tmpHome, {
      topic: "New drop",
      loopId: "n-id",
      date: "2026-04-30",
      reason: "test",
      source: "google-task-deletion",
    });

    const content = readFileSync(join(tmpHome, "workspace", "memory", "dropped-loops.md"), "utf-8");
    assert.ok(content.includes("## Active Drops"), "should add the Active Drops section");
    assert.ok(content.includes("**New drop**"));
  });
});

describe("loadDroppedLoopIds", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "maxos-dropped-ids-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns empty array when file is missing", () => {
    assert.deepEqual(loadDroppedLoopIds(tmpHome), []);
  });

  it("extracts loop ids from (loop:xxx) markers", () => {
    const content = `## Active Drops

- **Topic A** — dropped 2026-04-30 via Google Task deletion. Reason: x. (loop:loop-a)
- **Topic B** — dropped 2026-04-29. Reason: verbal.
- **Topic C** — dropped 2026-04-28 via Google Task deletion. Reason: x. (loop:loop-c)
`;
    mkdirSync(join(tmpHome, "workspace", "memory"), { recursive: true });
    writeFileSync(join(tmpHome, "workspace", "memory", "dropped-loops.md"), content);

    const ids = loadDroppedLoopIds(tmpHome);
    assert.deepEqual(ids.sort(), ["loop-a", "loop-c"]);
  });
});
