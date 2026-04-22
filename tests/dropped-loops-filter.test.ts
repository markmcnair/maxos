import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDroppedTopics,
  stripDroppedFromOutput,
  pruneOpenLoopsAgainstDropped,
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
});
