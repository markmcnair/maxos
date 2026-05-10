import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeRewrite, type RewriteResult } from "../src/voice-rewrite.js";

// ───── em-dash rewrites ─────

describe("safeRewrite — em-dash", () => {
  it("replaces em-dash (U+2014) with hyphen surrounded by spaces", () => {
    const r = safeRewrite("This — that — works");
    assert.equal(r.text, "This - that - works");
    assert.equal(r.changesByCategory["em-dash"], 2);
  });

  it("replaces en-dash (U+2013) with hyphen", () => {
    const r = safeRewrite("Range 5–10 emails");
    assert.equal(r.text, "Range 5-10 emails");
    assert.equal(r.changesByCategory["en-dash"], 1);
  });

  it("preserves regular ASCII hyphens", () => {
    const r = safeRewrite("co-worker pre-built well-written");
    assert.equal(r.text, "co-worker pre-built well-written");
  });

  it("handles em-dashes adjacent to words (no surrounding spaces)", () => {
    const r = safeRewrite("word1—word2");
    assert.equal(r.text, "word1-word2");
  });
});

// ───── curly quotes ─────

describe("safeRewrite — curly quotes", () => {
  it("converts smart double quotes to straight", () => {
    const r = safeRewrite("“Hello” and “goodbye”");
    assert.equal(r.text, '"Hello" and "goodbye"');
    assert.ok((r.changesByCategory["curly-double-quote"] ?? 0) >= 4);
  });

  it("converts smart single quotes / apostrophes to straight", () => {
    const r = safeRewrite("Mark’s text and 'quoted'");
    assert.equal(r.text, "Mark's text and 'quoted'");
    assert.ok((r.changesByCategory["curly-single-quote"] ?? 0) >= 1);
  });
});

// ───── AI-tells ─────

describe("safeRewrite — AI-tell openings", () => {
  it("strips 'Sure!' / 'Of course!' / 'Certainly!' / 'Absolutely!' at the start of any line", () => {
    const r = safeRewrite("Sure! Here's the thing.");
    assert.equal(r.text, "Here's the thing.");
    assert.equal(r.changesByCategory["ai-tell"], 1);
  });

  it("strips 'Great question!' at start", () => {
    const r = safeRewrite("Great question! Let me think about that.");
    assert.equal(r.text, "Let me think about that.");
  });

  it("strips 'I'd be happy to' phrasing", () => {
    const r = safeRewrite("I'd be happy to help. Let me check the calendar.");
    assert.match(r.text, /^Let me check/);
  });

  it("does NOT strip the same phrase mid-sentence (only at line start)", () => {
    const r = safeRewrite("This is something I'd be happy to help with.");
    assert.equal(r.text, "This is something I'd be happy to help with.");
  });
});

// ───── multiple line handling ─────

describe("safeRewrite — multi-line", () => {
  it("processes each line independently", () => {
    const input = "Sure! Line 1.\nGreat question! Line 2.\nNormal line 3.";
    const r = safeRewrite(input);
    assert.equal(r.text, "Line 1.\nLine 2.\nNormal line 3.");
  });

  it("preserves blank lines and indentation", () => {
    const input = "Para 1\n\nPara 2\n  Indented";
    const r = safeRewrite(input);
    assert.equal(r.text, input);
  });

  it("aggregates changes across all categories", () => {
    const input = "Sure! Range 5–10 — “nice”";
    const r = safeRewrite(input);
    assert.match(r.text, /^Range 5-10 - "nice"$/);
    assert.equal(r.totalChanges, 5);  // ai-tell + en-dash + em-dash + 2 curly quotes
  });
});

// ───── safety: no false positives ─────

describe("safeRewrite — no false positives", () => {
  it("preserves regular text untouched", () => {
    const text = "The quick brown fox jumps over the lazy dog. 1 + 1 = 2.";
    const r = safeRewrite(text);
    assert.equal(r.text, text);
    assert.equal(r.totalChanges, 0);
  });

  it("preserves code blocks intact (em-dashes inside backtick blocks)", () => {
    // Code blocks use em-dashes legitimately (e.g. CLI args). We don't rewrite inside `code spans`.
    const text = "Use `cmd —flag` to run.";
    const r = safeRewrite(text);
    assert.equal(r.text, text, "em-dash inside backticks should NOT be rewritten");
  });

  it("preserves fenced code blocks", () => {
    const text = "```\necho “hello” —long-flag\n```";
    const r = safeRewrite(text);
    assert.equal(r.text, text, "fenced blocks should be untouched");
  });

  it("preserves URLs", () => {
    const text = "See https://example.com/path—with—dashes for details.";
    const r = safeRewrite(text);
    // URLs MIGHT contain em-dashes (rare but valid). Don't rewrite inside URLs.
    assert.match(r.text, /example\.com\/path[—-]with[—-]dashes/);
  });

  it("returns input unchanged for empty string", () => {
    const r = safeRewrite("");
    assert.equal(r.text, "");
    assert.equal(r.totalChanges, 0);
  });
});

// ───── shape ─────

describe("safeRewrite — return shape", () => {
  it("returns { text, totalChanges, changesByCategory }", () => {
    const r: RewriteResult = safeRewrite("a — b");
    assert.equal(typeof r.text, "string");
    assert.equal(typeof r.totalChanges, "number");
    assert.equal(typeof r.changesByCategory, "object");
  });
});
