import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractTitleSearchWords,
  selectImessageMatches,
} from "../src/calendar-brief.js";

describe("extractTitleSearchWords", () => {
  it("returns alphanumeric words ≥4 chars, lowercased, plus uppercase acronyms", () => {
    assert.deepEqual(extractTitleSearchWords("NWA family day"), ["nwa", "family"]);
    assert.deepEqual(extractTitleSearchWords("Trading talk w/ Shannon"), ["trading", "talk", "shannon"]);
  });

  it("preserves acronyms like KCR, SPX, MIJI even when ≤4 chars", () => {
    assert.deepEqual(
      extractTitleSearchWords("Daniel + Mark | KCR board meeting"),
      ["daniel", "mark", "kcr", "board", "meeting"],
    );
    assert.deepEqual(extractTitleSearchWords("SPX trading review"), ["spx", "trading", "review"]);
  });

  it("strips punctuation and lowercase short words", () => {
    assert.deepEqual(
      extractTitleSearchWords("To be or not to be at the table"),
      ["table"],
    );
  });

  it("filters common filler words even if they pass the length test", () => {
    // "with" "from" "that" "have" all ≥4 chars but useless for matching
    assert.deepEqual(
      extractTitleSearchWords("Coffee with that person from the office"),
      ["coffee", "person", "office"],
    );
  });

  it("returns empty for fully non-matching input", () => {
    assert.deepEqual(extractTitleSearchWords(""), []);
    assert.deepEqual(extractTitleSearchWords("?!?"), []);
    assert.deepEqual(extractTitleSearchWords("a b c"), []);
  });
});

describe("selectImessageMatches", () => {
  const sampleLines = [
    "2026-04-22 14:30|Family|We're heading to NWA Saturday for the Bella Vista citywide garage sale!",
    "2026-04-22 14:32|Mark|Liked an audio message",
    "2026-04-22 15:00|Family|Liked \"We're heading to NWA Saturday\"",
    "2026-04-22 16:00|Family|What time should we leave Friday for NWA?",
    "2026-04-23 09:00|+15001112222|Some unrelated chatter about lunch",
    "2026-04-23 10:00|Family|Loved the garage sale plan!",
  ];

  it("returns lines whose text contains any keyword", () => {
    const out = selectImessageMatches(sampleLines, ["nwa"], 5);
    assert.equal(out.length, 2);
    assert.match(out[0], /heading to NWA Saturday for the Bella Vista/);
    assert.match(out[1], /What time should we leave Friday for NWA/);
  });

  it("filters out tapback reactions even if they contain keywords", () => {
    // "Liked \"We're heading to NWA Saturday\"" must NOT count
    const out = selectImessageMatches(sampleLines, ["nwa"], 5);
    for (const line of out) {
      assert.doesNotMatch(line, /^\d+-\d+-\d+ \d+:\d+\|\w+\|Liked /);
    }
  });

  it("respects the limit", () => {
    const out = selectImessageMatches(sampleLines, ["nwa"], 1);
    assert.equal(out.length, 1);
  });

  it("returns empty when no keywords match", () => {
    const out = selectImessageMatches(sampleLines, ["zebra"], 3);
    assert.deepEqual(out, []);
  });

  it("returns empty when words list is empty", () => {
    const out = selectImessageMatches(sampleLines, [], 3);
    assert.deepEqual(out, []);
  });

  it("regression: NWA family event resolves via family group chat (the original failure)", () => {
    // Apr 23 calendar event "NWA" → bare title, no dossier match.
    // Family iMessage thread had been planning the Bella Vista garage sale.
    // The brief should now surface that context instead of just "❓ Unknown".
    const words = extractTitleSearchWords("NWA");
    const out = selectImessageMatches(sampleLines, words, 3);
    assert.ok(out.length > 0, "should find at least one NWA-matching line");
    assert.match(out.join("\n"), /Bella Vista|garage sale/);
  });

  it("regression: Alfonso 'meeting with Daniel' isn't auto-classified as a board meeting", () => {
    // The failure was the brief calling Alfonso meetings "board meetings"
    // based on title pattern. With iMessage context, the brief sees
    // strategic-partner / coffee chatter and classifies accordingly.
    const lines = [
      "2026-04-25 09:00|Daniel|Excited to meet with Alfonso Monday — coffee partnership angle",
      "2026-04-25 09:05|Mark|Yeah this is a strategic partner conversation, not a formal board thing",
    ];
    const words = extractTitleSearchWords("Alfonso + Daniel | KCR meeting");
    const out = selectImessageMatches(lines, words, 3);
    assert.ok(out.length > 0);
    assert.match(out.join("\n"), /strategic partner|coffee partnership/);
  });
});
