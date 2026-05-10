import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildChatContext, formatChatContext } from "../src/chat-context.js";

describe("formatChatContext (pure)", () => {
  it("returns empty string when both inputs are empty", () => {
    assert.equal(formatChatContext("", ""), "");
  });

  it("returns just the journal block when closures are empty", () => {
    const block = formatChatContext("morning brief content", "");
    assert.match(block, /CHAT CONTEXT/);
    assert.match(block, /Today's daily journal/);
    assert.match(block, /morning brief content/);
    assert.doesNotMatch(block, /Today's closures/);
  });

  it("returns just the closures block when journal is empty", () => {
    const block = formatChatContext("", "- [12:00] [CLOSURE] sent invoice");
    assert.match(block, /Today's closures/);
    assert.match(block, /sent invoice/);
    assert.doesNotMatch(block, /Today's daily journal/);
  });

  it("returns both sections when both are present", () => {
    const block = formatChatContext("brew output", "- [09:00] [CLOSURE] texted Alfonso");
    assert.match(block, /Today's closures/);
    assert.match(block, /Today's daily journal/);
    assert.match(block, /brew output/);
    assert.match(block, /texted Alfonso/);
  });

  it("ends with the END CHAT CONTEXT marker", () => {
    const block = formatChatContext("x", "y");
    assert.ok(block.trim().endsWith("[END CHAT CONTEXT]"));
  });
});

describe("buildChatContext (with file system)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "chat-ctx-"));
    mkdirSync(join(tmp, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns empty when neither journal nor closures exist", () => {
    assert.equal(buildChatContext(tmp, new Date("2026-04-27T12:00:00")), "");
  });

  it("includes today's journal if it exists", () => {
    writeFileSync(
      join(tmp, "workspace", "memory", "2026-04-27.md"),
      "## morning-brief 6:01am\nKR board prep at 2pm",
    );
    const block = buildChatContext(tmp, new Date("2026-04-27T12:00:00"));
    assert.match(block, /KR board prep/);
    assert.match(block, /Today's daily journal/);
  });

  it("includes today's closures if they exist", () => {
    writeFileSync(
      join(tmp, "workspace", "memory", "closures-2026-04-27.md"),
      "- [09:30] [CLOSURE] sent Alfonso the wholesale list",
    );
    const block = buildChatContext(tmp, new Date("2026-04-27T12:00:00"));
    assert.match(block, /sent Alfonso the wholesale list/);
    assert.match(block, /Today's closures/);
  });

  it("caps journal at half-budget and prepends ellipsis", () => {
    const big = "x".repeat(8000);
    writeFileSync(join(tmp, "workspace", "memory", "2026-04-27.md"), big);
    const block = buildChatContext(tmp, new Date("2026-04-27T12:00:00"), 4000);
    // half-budget = 2000 chars → ellipsis + 2000 x's
    assert.match(block, /…x{2000}/);
    assert.ok(block.length < 4000 + 1000, "block should be capped well under total budget");
  });

  it("caps closures at half-budget too — busy days don't blow the budget (regression for ISSUE-008)", () => {
    const fatClosures = "y".repeat(8000);
    writeFileSync(join(tmp, "workspace", "memory", "closures-2026-04-27.md"), fatClosures);
    const block = buildChatContext(tmp, new Date("2026-04-27T12:00:00"), 4000);
    assert.match(block, /…y{2000}/);
    assert.ok(block.length < 4000 + 1000, "closures must respect the budget");
  });

  it("respects the budget when BOTH journal and closures are oversized", () => {
    writeFileSync(join(tmp, "workspace", "memory", "2026-04-27.md"), "x".repeat(8000));
    writeFileSync(join(tmp, "workspace", "memory", "closures-2026-04-27.md"), "y".repeat(8000));
    const block = buildChatContext(tmp, new Date("2026-04-27T12:00:00"), 4000);
    // Generous slack for the wrapper labels, but should be well under 2x budget
    assert.ok(block.length < 4000 + 1500, `expected ≤ 5500, got ${block.length}`);
  });

  it("uses local-time YMD, not UTC", () => {
    // 2026-04-27T05:00:00 local time → file 2026-04-27.md regardless of UTC offset
    const localDate = new Date("2026-04-27T05:00:00");
    writeFileSync(join(tmp, "workspace", "memory", "2026-04-27.md"), "today");
    const block = buildChatContext(tmp, localDate);
    assert.match(block, /today/);
  });

  it("regression: chat session sees today's morning brief content even if session pre-dates it", () => {
    // Simulates the exact failure mode Mark hit: brief writes journal at 6am,
    // chat session asks Max about NWA at 10am. Without this wire, chat-Max had no clue.
    writeFileSync(
      join(tmp, "workspace", "memory", "2026-04-23.md"),
      "## morning-brief 6:00am\n\nNWA at 8:00am ❓ — still unclear what this is.",
    );
    const block = buildChatContext(tmp, new Date("2026-04-23T10:00:00"));
    assert.match(block, /NWA at 8:00am/);
  });
});
