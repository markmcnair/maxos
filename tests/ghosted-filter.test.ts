import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAuthoritativeGhosted,
  stripInvalidGhosted,
  type GhostedEntry,
} from "../src/ghosted-filter.js";

describe("parseAuthoritativeGhosted", () => {
  it("parses the pipe-delimited output of `imessage-scan --ghosted --resolve-names`", () => {
    const raw = [
      "2026-04-22 06:28:03|+14793883842|Please accept our apologies",
      "2026-04-21 13:43:54|+15014708008|No pickleball tn?",
      "2026-04-21 17:13:28|+15017338844|👍",
    ].join("\n");
    const entries = parseAuthoritativeGhosted(raw);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].phone, "+14793883842");
    assert.equal(entries[1].phone, "+15014708008");
  });

  it("extracts the PersonName prefix when --resolve-names injected one", () => {
    const raw = "2026-04-21 22:15:54|+15012695797|Miguel Thorpe — Might need to cop one";
    const entries = parseAuthoritativeGhosted(raw);
    assert.equal(entries[0].name, "Miguel Thorpe");
    assert.equal(entries[0].phone, "+15012695797");
  });

  it("handles lines without name prefix gracefully", () => {
    const raw = "2026-04-21 13:43:54|+15014708008|No pickleball tn?";
    const entries = parseAuthoritativeGhosted(raw);
    assert.equal(entries[0].name, undefined);
    assert.equal(entries[0].phone, "+15014708008");
  });

  it("returns empty array for empty / malformed input", () => {
    assert.deepEqual(parseAuthoritativeGhosted(""), []);
    assert.deepEqual(parseAuthoritativeGhosted("garbage"), []);
    assert.deepEqual(parseAuthoritativeGhosted("one|only"), []);
  });
});

describe("stripInvalidGhosted", () => {
  const output = `# Morning Brief

## 🪨 Top priority: Fix X

## 👻 Ghosted:
• Miguel — last text 10pm was casual but 4:08pm Matt Carpenter ask unanswered
• +15014708008 — pickleball confirm
• Mike Salem — acquisition MNDA, new loop
• Nathaniel Watts — reel link shared

## 📍 First presence: Alex at 8am

## 🚨 Overnight: Lane Long forwarded request`;

  it("strips bullets whose name/phone doesn't appear in the authoritative list", () => {
    const authoritative: GhostedEntry[] = [
      { timestamp: "2026-04-21", phone: "+15014708008", name: undefined, text: "pickleball" },
    ];
    const filtered = stripInvalidGhosted(output, authoritative);
    const ghostedSection = filtered.split("## 👻")[1]?.split("##")[0] ?? "";
    assert.ok(ghostedSection.includes("15014708008"), "authoritative phone must survive");
    assert.ok(!ghostedSection.toLowerCase().includes("miguel"), "Miguel not in authoritative — strip");
    assert.ok(!ghostedSection.toLowerCase().includes("nathaniel"), "Nathaniel not authoritative — strip");
    assert.ok(!ghostedSection.toLowerCase().includes("mike salem"), "Mike Salem not authoritative — strip");
  });

  it("keeps bullets that match by name OR by phone", () => {
    const authoritative: GhostedEntry[] = [
      { timestamp: "2026-04-21", phone: "+15012695797", name: "Miguel Thorpe", text: "..." },
    ];
    const filtered = stripInvalidGhosted(output, authoritative);
    const ghostedSection = filtered.split("## 👻")[1]?.split("##")[0] ?? "";
    assert.ok(ghostedSection.toLowerCase().includes("miguel"), "name match — keep");
  });

  it("strips ALL bullets when authoritative list is empty", () => {
    const filtered = stripInvalidGhosted(output, []);
    const ghostedSection = filtered.split("## 👻")[1]?.split("##")[0] ?? "";
    // Section header + separator survive, but every bullet is gone
    assert.ok(!ghostedSection.includes("Miguel"));
    assert.ok(!ghostedSection.includes("+15014708008"));
    assert.ok(!ghostedSection.includes("Nathaniel"));
  });

  it("leaves non-Ghosted sections alone", () => {
    const authoritative: GhostedEntry[] = [];
    const filtered = stripInvalidGhosted(output, authoritative);
    assert.ok(filtered.includes("Top priority"));
    assert.ok(filtered.includes("First presence"));
    assert.ok(filtered.includes("Lane Long"));
  });

  it("preserves the Ghosted section header even when every bullet is stripped", () => {
    const filtered = stripInvalidGhosted(output, []);
    assert.ok(filtered.includes("## 👻 Ghosted"));
  });

  it("handles nested continuation lines (prose under a bullet)", () => {
    const nested = `## 👻 Ghosted:
• Miguel — first line
  additional context on second line
  more context on third
• +15014708008 — pickleball

## Next Section`;
    const authoritative: GhostedEntry[] = [
      { timestamp: "x", phone: "+15014708008", text: "" },
    ];
    const filtered = stripInvalidGhosted(nested, authoritative);
    assert.ok(!filtered.includes("additional context on second line"));
    assert.ok(filtered.includes("15014708008"));
  });
});
