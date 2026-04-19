import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeForJournal } from "../src/gateway.js";

describe("summarizeForJournal", () => {
  it("returns the result unchanged when under the limit", () => {
    const input = "Short task output.\nAll good.";
    assert.equal(summarizeForJournal(input, 2000), input);
  });

  it("returns the result unchanged when exactly at the limit", () => {
    const input = "a".repeat(2000);
    assert.equal(summarizeForJournal(input, 2000), input);
  });

  it("truncates at the next newline after the limit", () => {
    // filler brings us just under 2000 chars with a newline at 1990
    const filler = "x".repeat(1990) + "\n";
    // a long line that starts before 2000 and ends after — the whole line should be kept
    const lineAtCutoff = "line at cutoff goes here and crosses 2000\n";
    const rest = "rest of the output after cut\nmore after that\n";
    const input = filler + lineAtCutoff + rest;
    const out = summarizeForJournal(input, 2000);
    assert.ok(out.includes("line at cutoff"), "cut should include the line that straddles 2000");
    assert.ok(!out.includes("rest of the output after cut"), "content after the cut should be dropped");
    assert.ok(out.endsWith("…(truncated, full output sent to Telegram)"));
  });

  it("falls back to the raw cut when no newline exists after the limit", () => {
    const input = "x".repeat(3000);
    const out = summarizeForJournal(input, 2000);
    // 2000 x's plus the truncation notice
    assert.ok(out.startsWith("x".repeat(2000)));
    assert.ok(out.endsWith("…(truncated, full output sent to Telegram)"));
    assert.ok(!out.includes("x".repeat(2001)), "should not include the 2001st x");
  });

  it("never breaks a markdown table row mid-row", () => {
    // Build a result that crosses 2000 chars in the middle of a pipe-delimited row.
    const filler = "prefix line\n".repeat(160); // ~1920 chars
    const tableStart = "| col1 | col2 | col3 |\n| --- | --- | --- |\n";
    const row = "| aaaaaaaaaaaa | bbbbbbbbbbbb | cccccccccccc |\n";
    const input = filler + tableStart + row.repeat(5);
    assert.ok(input.length > 2000);

    const out = summarizeForJournal(input, 2000);
    // Every pipe-bearing line in `out` must end with a pipe — i.e. no half-cut row.
    const lines = out.split("\n");
    for (const line of lines) {
      if (line.includes("|") && line.trim() !== "…(truncated, full output sent to Telegram)") {
        assert.ok(
          line.trimEnd().endsWith("|"),
          `table row ${JSON.stringify(line)} was cut mid-cell`,
        );
      }
    }
  });
});
