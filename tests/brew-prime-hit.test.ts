import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePrimeHit, readPrimeHit, type PrimeHit } from "../src/brew-prime-hit.js";

describe("prime-hit I/O", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "prime-hit-"));
    p = join(tmp, "prime-hit.json");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("round-trips a build:true hit with prototype", () => {
    const hit: PrimeHit = {
      date: "2026-04-22",
      candidate: { url: "https://x.com/a/b", title: "Tool X", source: "x", summary: "s", whatIfWeBuilt: "w" },
      scores: { createValue: 5, removeToil: 4, automate: 5, activeFit: 4 },
      confidence: 4.55,
      build: true,
      prototype: {
        url: "https://preview.vercel.app/xyz",
        summary: "One-liner",
        tech: ["Next.js", "Claude API"],
        repo: "/Users/Max/Projects/prototypes/2026-04-22-x/",
      },
    };
    writePrimeHit(p, hit);
    const read = readPrimeHit(p);
    assert.deepEqual(read, hit);
  });

  it("round-trips a build:false suggestion", () => {
    const hit: PrimeHit = {
      date: "2026-04-22",
      candidate: { url: "https://x", title: "T", source: "x", summary: "s", whatIfWeBuilt: "w" },
      scores: { createValue: 3, removeToil: 3, automate: 3, activeFit: 3 },
      confidence: 3.0,
      build: false,
      suggest: "Want me to prototype this tonight?",
    };
    writePrimeHit(p, hit);
    assert.deepEqual(readPrimeHit(p), hit);
  });

  it("readPrimeHit returns null when file missing", () => {
    assert.equal(readPrimeHit(p), null);
  });
});
