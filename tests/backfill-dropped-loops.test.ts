import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGoogleTaskDecisionLine,
  findClosureFiles,
  collectGoogleTaskDeletions,
  runBackfill,
} from "../src/backfill-dropped-loops.js";

describe("parseGoogleTaskDecisionLine", () => {
  it("extracts loop id and topic from a real DECISION line", () => {
    const line = `- [16:15] [DECISION] dropped (kr-wholesale-testimonials) — Google Task deleted (Mark removed it from "🤖 MaxOS Loops"), so Kingdom Roasters wholesale + testimonials + prayer cards was never real`;
    const r = parseGoogleTaskDecisionLine(line);
    assert.deepEqual(r, {
      loopId: "kr-wholesale-testimonials",
      topic: "Kingdom Roasters wholesale + testimonials + prayer cards",
    });
  });

  it("returns null for non-Google-Task DECISION lines", () => {
    const line = `- [10:00] [DECISION] dropped mike-salem-mnda-financials — Glenn Crockett is the right contact, Dave Creek paused`;
    assert.equal(parseGoogleTaskDecisionLine(line), null);
  });

  it("returns null for non-decision closure lines", () => {
    const line = `- [12:30] [CLOSURE] texted Lane Long — heads up about the surprise`;
    assert.equal(parseGoogleTaskDecisionLine(line), null);
  });

  it("returns null for malformed lines", () => {
    assert.equal(parseGoogleTaskDecisionLine(""), null);
    assert.equal(parseGoogleTaskDecisionLine("garbage"), null);
  });
});

describe("findClosureFiles", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "backfill-test-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns closure files sorted chronologically", () => {
    writeFileSync(join(home, "workspace", "memory", "closures-2026-04-30.md"), "x");
    writeFileSync(join(home, "workspace", "memory", "closures-2026-04-28.md"), "x");
    writeFileSync(join(home, "workspace", "memory", "closures-2026-04-29.md"), "x");
    // Non-closure files should be ignored
    writeFileSync(join(home, "workspace", "memory", "open-loops.json"), "[]");

    const files = findClosureFiles(home);
    assert.deepEqual(
      files.map((f) => f.date),
      ["2026-04-28", "2026-04-29", "2026-04-30"],
    );
  });

  it("returns empty when memory dir doesn't exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "empty-"));
    assert.deepEqual(findClosureFiles(empty), []);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("collectGoogleTaskDeletions + runBackfill", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "backfill-run-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("collects all 7 historical Google Task deletions and writes them to dropped-loops.md", () => {
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-28.md"),
      `- [09:00] [CLOSURE] texted Daniel — pricing locked
- [16:15] [DECISION] dropped (kr-wholesale-testimonials) — Google Task deleted (Mark removed it from "🤖 MaxOS Loops"), so Kingdom Roasters wholesale + testimonials + prayer cards was never real
- [16:15] [DECISION] dropped (austin-followups) — Google Task deleted (Mark removed it from "🤖 MaxOS Loops"), so Austin follow-ups: Braden punctuality + receptionist hire eval was never real
- [16:15] [DECISION] dropped (rachel-newlywed-basket) — Google Task deleted (Mark removed it from "🤖 MaxOS Loops"), so Rachel — $10 gift card contribution for newlyweds basket was never real`,
    );
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-29.md"),
      `- [22:15] [DECISION] dropped (chris-browns-claude-code-rec) — Google Task deleted (Mark removed it from "🤖 MaxOS Loops"), so Recommend Claude Code at $100/mo tier to Chris (Brown's VP Sales) was never real`,
    );
    writeFileSync(
      join(home, "workspace", "memory", "open-loops.json"),
      JSON.stringify([], null, 2),
    );

    const r = runBackfill(home);
    assert.equal(r.written, 4);

    const dropped = readFileSync(join(home, "workspace", "memory", "dropped-loops.md"), "utf-8");
    assert.match(dropped, /\(loop:kr-wholesale-testimonials\)/);
    assert.match(dropped, /\(loop:austin-followups\)/);
    assert.match(dropped, /\(loop:rachel-newlywed-basket\)/);
    assert.match(dropped, /\(loop:chris-browns-claude-code-rec\)/);
    // Bolded topic preserved
    assert.match(dropped, /\*\*Kingdom Roasters wholesale \+ testimonials \+ prayer cards\*\*/);
  });

  it("dedups across multiple closure files (loop deleted, then noticed again)", () => {
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-28.md"),
      `- [16:15] [DECISION] dropped (foo) — Google Task deleted (...), so Foo topic was never real`,
    );
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-29.md"),
      `- [09:00] [DECISION] dropped (foo) — Google Task deleted (...), so Foo topic was never real`,
    );
    writeFileSync(
      join(home, "workspace", "memory", "open-loops.json"),
      JSON.stringify([], null, 2),
    );

    const r = runBackfill(home);
    assert.equal(r.written, 1);
    const dropped = readFileSync(join(home, "workspace", "memory", "dropped-loops.md"), "utf-8");
    const occurrences = dropped.match(/\(loop:foo\)/g) ?? [];
    assert.equal(occurrences.length, 1);
  });

  it("is idempotent — running twice doesn't duplicate entries", () => {
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-28.md"),
      `- [16:15] [DECISION] dropped (already-deleted) — Google Task deleted (...), so Some topic was never real`,
    );
    writeFileSync(
      join(home, "workspace", "memory", "open-loops.json"),
      JSON.stringify([], null, 2),
    );

    runBackfill(home);
    runBackfill(home);  // second run

    const dropped = readFileSync(join(home, "workspace", "memory", "dropped-loops.md"), "utf-8");
    const occurrences = dropped.match(/\(loop:already-deleted\)/g) ?? [];
    assert.equal(occurrences.length, 1, "second run must not re-add the entry");
  });

  it("preserves person from current open-loops.json if loop id matches", () => {
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-28.md"),
      `- [16:15] [DECISION] dropped (kcr-wholesale-ordering-v1) — Google Task deleted (...), so KCR wholesale ordering system v1 was never real`,
    );
    // Imagine the loop is still in open-loops.json (race condition where the
    // closure-watcher hasn't yet swept it). The backfill should still grab
    // the person from there for richer dropped-loops.md output.
    writeFileSync(
      join(home, "workspace", "memory", "open-loops.json"),
      JSON.stringify(
        [
          {
            id: "kcr-wholesale-ordering-v1",
            topic: "KCR wholesale ordering system v1",
            person: "Mark",
            firstSeen: "2026-04-28",
            lastUpdated: "2026-04-28",
          },
        ],
        null,
        2,
      ),
    );

    runBackfill(home);
    const dropped = readFileSync(join(home, "workspace", "memory", "dropped-loops.md"), "utf-8");
    assert.match(dropped, /\(Mark\)/);
  });
});
