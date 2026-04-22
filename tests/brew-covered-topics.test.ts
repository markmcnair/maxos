import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCoveredLog,
  isNearMatch,
  appendCovered,
  type CoveredEntry,
} from "../src/brew-covered-topics.js";

describe("parseCoveredLog", () => {
  it("parses one entry per line", () => {
    const md = `
2026-04-20 · github.com/a/b · [rag, vectors, llm]
2026-04-21 · https://example.com · [mcp, claude, tools]
`;
    const entries = parseCoveredLog(md);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0].keywords, ["rag", "vectors", "llm"]);
  });

  it("ignores blank lines and comments", () => {
    const md = `# comment\n\n2026-04-20 · url · [kw]\n`;
    assert.equal(parseCoveredLog(md).length, 1);
  });
});

describe("isNearMatch", () => {
  const entries: CoveredEntry[] = [
    { date: "2026-04-20", url: "https://github.com/a/b", keywords: ["rag", "vectors", "llm"] },
  ];

  it("matches if URL is identical", () => {
    assert.equal(isNearMatch("https://github.com/a/b", ["new", "keywords"], entries), true);
  });

  it("matches if 2+ keywords overlap", () => {
    assert.equal(isNearMatch("https://other.com", ["rag", "vectors", "fresh"], entries), true);
  });

  it("does NOT match on just one shared keyword", () => {
    assert.equal(isNearMatch("https://other.com", ["rag", "cats", "dogs"], entries), false);
  });
});

describe("appendCovered", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "covered-"));
    p = join(tmp, "covered-topics.md");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("appends a new line to the log", () => {
    appendCovered(p, { date: "2026-04-22", url: "https://g.com/x/y", keywords: ["a", "b", "c"] });
    const content = readFileSync(p, "utf-8");
    assert.ok(content.includes("2026-04-22 · https://g.com/x/y · [a, b, c]"));
  });
});
