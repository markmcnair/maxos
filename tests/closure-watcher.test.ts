import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizePhone,
  buildDossierPhoneIndex,
  matchDossierByPhone,
  parseOutgoingDmLine,
  isReactionText,
  formatClosureLine,
  filterNewEntries,
  appendClosures,
  type OutgoingMessage,
  type ClosureMatch,
} from "../src/closure-watcher.js";
import type { Dossier } from "../src/calendar-brief.js";

describe("normalizePhone", () => {
  it("strips all non-digits", () => {
    assert.equal(normalizePhone("(501) 269-5797"), "5012695797");
    assert.equal(normalizePhone("+1-501-269-5797"), "15012695797");
    assert.equal(normalizePhone("501.269.5797"), "5012695797");
  });

  it("strips leading US country code for comparison consistency", () => {
    // Both should normalize to comparable forms
    const a = normalizePhone("+15012695797");
    const b = normalizePhone("5012695797");
    assert.equal(a.slice(-10), b.slice(-10), "last 10 digits must match");
  });

  it("returns empty string for empty input", () => {
    assert.equal(normalizePhone(""), "");
    assert.equal(normalizePhone(undefined as any), "");
  });

  it("handles email addresses gracefully (returns empty)", () => {
    assert.equal(normalizePhone("user@example.com"), "");
  });
});

describe("buildDossierPhoneIndex / matchDossierByPhone", () => {
  const dossiers: Dossier[] = [
    { name: "Miguel Thorpe", firstName: "Miguel", orbit: "The Chosen", phone: "501-269-5797", path: "x.md", excerpt: "" },
    { name: "Daniel McNair", firstName: "Daniel", orbit: "The Chosen", phone: "+1-501-764-6415", path: "y.md", excerpt: "" },
    { name: "No Phone Person", firstName: "NoPhone", orbit: "Network", phone: undefined, path: "z.md", excerpt: "" },
  ];

  it("indexes only dossiers with phone numbers", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(idx.size, 2);
  });

  it("matches by various formats — canonical last-10-digits lookup", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(matchDossierByPhone("+15012695797", idx)?.name, "Miguel Thorpe");
    assert.equal(matchDossierByPhone("501-269-5797", idx)?.name, "Miguel Thorpe");
    assert.equal(matchDossierByPhone("5012695797", idx)?.name, "Miguel Thorpe");
    assert.equal(matchDossierByPhone("(501) 269-5797", idx)?.name, "Miguel Thorpe");
  });

  it("returns null when phone is not in the index", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(matchDossierByPhone("+15551234567", idx), null);
  });

  it("ignores empty / undefined phone inputs", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(matchDossierByPhone("", idx), null);
  });
});

describe("parseOutgoingDmLine", () => {
  it("parses timestamp|recipient|text format", () => {
    const msg = parseOutgoingDmLine("2026-04-21 13:03:22|+19014973230|You close?");
    assert.ok(msg);
    assert.equal(msg.timestamp, "2026-04-21 13:03:22");
    assert.equal(msg.recipient, "+19014973230");
    assert.equal(msg.text, "You close?");
  });

  it("preserves pipes inside the message text", () => {
    const msg = parseOutgoingDmLine("2026-04-21 13:03:22|+19014973230|a | b | c");
    assert.ok(msg);
    assert.equal(msg.text, "a | b | c");
  });

  it("returns null for malformed lines", () => {
    assert.equal(parseOutgoingDmLine(""), null);
    assert.equal(parseOutgoingDmLine("no pipes here"), null);
    assert.equal(parseOutgoingDmLine("one|only"), null);
  });
});

describe("isReactionText", () => {
  it("detects iMessage tapback reactions", () => {
    assert.ok(isReactionText('Liked "photo"'));
    assert.ok(isReactionText("Loved an image"));
    assert.ok(isReactionText("Laughed at an image"));
    assert.ok(isReactionText("Emphasized \u201csomething\u201d"));
  });

  it("does not flag regular messages", () => {
    assert.ok(!isReactionText("You close?"));
    assert.ok(!isReactionText("Thanks for the update!"));
    assert.ok(!isReactionText("I liked that a lot"));
  });
});

describe("formatClosureLine", () => {
  it("produces `- [HH:MM] [CLOSURE] texted PersonName — text`", () => {
    const match: ClosureMatch = {
      message: { timestamp: "2026-04-21 13:03:22", recipient: "+19014973230", text: "You close?" },
      dossier: { name: "Josh Croom", firstName: "Josh", orbit: "The Network", phone: "+19014973230", path: "", excerpt: "" },
    };
    const line = formatClosureLine(match);
    assert.equal(line, "- [13:03] [CLOSURE] texted Josh Croom — You close?");
  });

  it("truncates long message text to ~100 chars", () => {
    const longText = "x".repeat(500);
    const match: ClosureMatch = {
      message: { timestamp: "2026-04-21 13:03:22", recipient: "+19014973230", text: longText },
      dossier: { name: "Josh", firstName: "Josh", orbit: "Network", phone: "+19014973230", path: "", excerpt: "" },
    };
    const line = formatClosureLine(match);
    assert.ok(line.length < 200);
    assert.ok(line.endsWith("…"));
  });

  it("replaces newlines with spaces so the line stays single-line", () => {
    const match: ClosureMatch = {
      message: { timestamp: "2026-04-21 13:03:22", recipient: "+19014973230", text: "line 1\nline 2\nline 3" },
      dossier: { name: "Josh", firstName: "Josh", orbit: "Network", phone: "+19014973230", path: "", excerpt: "" },
    };
    const line = formatClosureLine(match);
    assert.ok(!line.includes("\n"));
  });
});

describe("filterNewEntries", () => {
  it("returns all entries when the existing log is empty", () => {
    const entries = ["- [13:03] [CLOSURE] texted Josh Croom — hi"];
    assert.deepEqual(filterNewEntries(entries, ""), entries);
  });

  it("skips entries whose exact line already exists", () => {
    const existing = "- [13:03] [CLOSURE] texted Josh Croom — hi\n";
    const entries = [
      "- [13:03] [CLOSURE] texted Josh Croom — hi",
      "- [14:00] [CLOSURE] texted Daniel — ok",
    ];
    assert.deepEqual(filterNewEntries(entries, existing), [entries[1]]);
  });

  it("compares on trimmed content", () => {
    const existing = "- [13:03] [CLOSURE] texted Josh Croom — hi\n";
    const entries = ["  - [13:03] [CLOSURE] texted Josh Croom — hi  "];
    assert.deepEqual(filterNewEntries(entries, existing), []);
  });
});

describe("appendClosures", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "closure-watcher-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates today's closures file when it doesn't exist", () => {
    const date = new Date(2026, 3, 21);
    appendClosures(home, date, ["- [13:03] [CLOSURE] texted Josh Croom — hi"]);
    const path = join(home, "workspace", "memory", "closures-2026-04-21.md");
    assert.ok(existsSync(path));
    const content = readFileSync(path, "utf-8");
    assert.ok(content.includes("Josh Croom"));
  });

  it("appends to existing file without dup", () => {
    const date = new Date(2026, 3, 21);
    const path = join(home, "workspace", "memory", "closures-2026-04-21.md");
    writeFileSync(path, "- [10:00] [CLOSURE] earlier entry\n");
    appendClosures(home, date, [
      "- [10:00] [CLOSURE] earlier entry",  // dup — should skip
      "- [13:03] [CLOSURE] texted Josh — hi",
    ]);
    const content = readFileSync(path, "utf-8");
    assert.equal(content.match(/earlier entry/g)?.length, 1, "should not duplicate");
    assert.ok(content.includes("Josh"));
  });

  it("no-ops when given empty entry list", () => {
    const date = new Date(2026, 3, 21);
    appendClosures(home, date, []);
    const path = join(home, "workspace", "memory", "closures-2026-04-21.md");
    assert.equal(existsSync(path), false);
  });
});
