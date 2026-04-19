import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMemoryContext,
  extractSearchQuery,
  formatQmdHits,
  readClosuresFile,
  type QmdHit,
} from "../src/memory.js";

describe("extractSearchQuery", () => {
  it("returns the first lines up to ~200 chars", () => {
    const prompt = "Run the morning brief: read tasks/morning-brief.md and execute every step";
    const q = extractSearchQuery(prompt);
    assert.ok(q.includes("morning brief"));
    assert.ok(q.length <= 200);
  });

  it("strips punctuation and normalizes whitespace", () => {
    const q = extractSearchQuery("Do   the thing!  And  also: another thing?");
    assert.equal(q, "Do the thing And also another thing");
  });

  it("returns empty string for empty / whitespace-only input", () => {
    assert.equal(extractSearchQuery(""), "");
    assert.equal(extractSearchQuery("   \n  \n  "), "");
  });

  it("takes only the first 5 lines", () => {
    const prompt = [
      "Line 1 about Alfonso",
      "Line 2",
      "Line 3",
      "Line 4",
      "Line 5",
      "Line 6 should NOT appear",
      "Line 7 also should NOT appear",
    ].join("\n");
    const q = extractSearchQuery(prompt);
    assert.ok(q.includes("Alfonso"));
    assert.ok(!q.includes("Line 6"));
    assert.ok(!q.includes("Line 7"));
  });
});

describe("formatQmdHits", () => {
  it("returns empty string when there are no hits", () => {
    assert.equal(formatQmdHits([]), "");
  });

  it("formats hits with title, file, score, snippet", () => {
    const hits: QmdHit[] = [{
      docid: "#abc",
      score: 0.92,
      file: "qmd://memory/2026-04-19.md",
      title: "Today's log",
      snippet: "### Quote\nAlthough all men are lost...",
      context: "",
    }];
    const out = formatQmdHits(hits);
    assert.ok(out.includes("Today's log"));
    assert.ok(out.includes("qmd://memory/2026-04-19.md"));
    assert.ok(out.includes("92%"));
    assert.ok(out.includes("Although all men are lost"));
  });

  it("respects the maxChars cap when hits would exceed it", () => {
    const bigSnippet = "x".repeat(5000);
    const hits: QmdHit[] = Array.from({ length: 10 }, (_, i) => ({
      docid: `#${i}`,
      score: 0.9,
      file: `qmd://memory/f${i}.md`,
      title: `Hit ${i}`,
      snippet: bigSnippet,
      context: "",
    }));
    const out = formatQmdHits(hits, 2000);
    assert.ok(out.length <= 2200, `expected <=2200, got ${out.length}`);
  });
});

describe("readClosuresFile", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "maxos-memory-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when no closures file exists for the date", () => {
    const result = readClosuresFile(home, new Date("2026-04-19"));
    assert.equal(result, null);
  });

  it("returns the file content when it exists for that date", () => {
    const path = join(home, "workspace", "memory", "closures-2026-04-19.md");
    writeFileSync(path, "- [16:20] texted Jessica — taco bowls for dinner\n- [17:05] sent Alfonso the list");
    // Use explicit noon local time so the date is unambiguous regardless of TZ
    const result = readClosuresFile(home, new Date(2026, 3, 19, 12, 0));
    assert.ok(result);
    assert.ok(result.includes("Jessica"));
    assert.ok(result.includes("Alfonso"));
  });

  it("correctly formats dates in YYYY-MM-DD regardless of timezone", () => {
    const path = join(home, "workspace", "memory", "closures-2026-01-05.md");
    writeFileSync(path, "entry");
    const result = readClosuresFile(home, new Date("2026-01-05T14:00:00-05:00"));
    assert.ok(result);
  });
});

describe("buildMemoryContext", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "maxos-memctx-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty string when there's no memory content available", async () => {
    const ctx = await buildMemoryContext("morning brief task", {
      maxosHome: home,
      now: new Date("2026-04-19T06:00:00"),
      skipQmd: true,
    });
    assert.equal(ctx, "");
  });

  it("includes today's closures file when present", async () => {
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-19.md"),
      "- [16:20] texted Jessica",
    );
    const ctx = await buildMemoryContext("any prompt", {
      maxosHome: home,
      now: new Date("2026-04-19T18:00:00"),
      skipQmd: true,
    });
    assert.ok(ctx.includes("## Recent Memory Context"));
    assert.ok(ctx.includes("Jessica"));
  });

  it("includes yesterday's closures file when present", async () => {
    writeFileSync(
      join(home, "workspace", "memory", "closures-2026-04-18.md"),
      "- [22:00] responded to Alfonso",
    );
    const ctx = await buildMemoryContext("morning brief", {
      maxosHome: home,
      now: new Date("2026-04-19T06:00:00"),
      skipQmd: true,
    });
    assert.ok(ctx.includes("Alfonso"));
  });

  it("includes dropped-loops when the file exists", async () => {
    writeFileSync(
      join(home, "workspace", "memory", "dropped-loops.md"),
      "# Dropped\n- Robert Scott SIMPLE IRA — Mark said 'OVER'",
    );
    const ctx = await buildMemoryContext("any prompt", {
      maxosHome: home,
      now: new Date("2026-04-19T06:00:00"),
      skipQmd: true,
    });
    assert.ok(ctx.includes("Robert Scott"));
    assert.ok(ctx.toLowerCase().includes("do not resurface"));
  });

  it("gracefully handles missing MAXOS_HOME — returns empty string", async () => {
    const ctx = await buildMemoryContext("x", {
      maxosHome: "/nonexistent/path",
      now: new Date(),
      skipQmd: true,
    });
    assert.equal(ctx, "");
  });
});
