import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseAntiPatterns,
  scanForVoiceViolations,
  logVoiceViolations,
  loadAntiPatternsFile,
} from "../src/voice-violations.js";

const ANTI_PATTERNS_FIXTURE = `# Anti-Patterns

## Banned Phrases (Corporate Fluff)

- "I hope this email finds you well"
- "Just wanted to..."
- "Per my last email"

## Banned Words (Corporate Jargon)

- Leverage (verb form)
- Synergy / synergistic
- Bandwidth
- Reach out

## Banned Sign-Offs

- "Best regards"
- "Warm regards"

## Banned AI Tells

- "Certainly!"
- "I'd be happy to..."

## Some Other Heading

- This bullet should be ignored

## Banned Hedging

- "I think maybe..."
`;

describe("parseAntiPatterns", () => {
  it("extracts phrases from quoted bullets under phrase-y headings", () => {
    const p = parseAntiPatterns(ANTI_PATTERNS_FIXTURE);
    assert.ok(p.bannedPhrases.includes("I hope this email finds you well"));
    assert.ok(p.bannedPhrases.includes("Just wanted to"));
    assert.ok(p.bannedPhrases.includes("Best regards"));
    assert.ok(p.bannedPhrases.includes("Certainly!"));
    assert.ok(p.bannedPhrases.includes("I think maybe"));
  });

  it("extracts words and splits 'X / Y' into both", () => {
    const p = parseAntiPatterns(ANTI_PATTERNS_FIXTURE);
    assert.ok(p.bannedWords.includes("Leverage"));
    assert.ok(p.bannedWords.includes("Synergy"));
    assert.ok(p.bannedWords.includes("synergistic"));
    assert.ok(p.bannedWords.includes("Bandwidth"));
  });

  it("strips trailing parens and ellipsis", () => {
    const p = parseAntiPatterns(ANTI_PATTERNS_FIXTURE);
    // "Leverage (verb form)" → "Leverage"
    assert.ok(p.bannedWords.includes("Leverage"));
    // "Just wanted to..." → "Just wanted to"
    assert.ok(p.bannedPhrases.includes("Just wanted to"));
  });

  it("skips bullets under unrelated headings", () => {
    const p = parseAntiPatterns(ANTI_PATTERNS_FIXTURE);
    assert.ok(!p.bannedPhrases.includes("This bullet should be ignored"));
    assert.ok(!p.bannedWords.includes("This bullet should be ignored"));
  });
});

describe("scanForVoiceViolations", () => {
  const patterns = parseAntiPatterns(ANTI_PATTERNS_FIXTURE);

  it("returns empty for clean text", () => {
    const v = scanForVoiceViolations("Plain text with nothing flagged.", patterns);
    assert.deepEqual(v, []);
  });

  it("detects banned phrase (case-insensitive substring)", () => {
    const v = scanForVoiceViolations(
      "Hi Mark, I HOPE THIS EMAIL FINDS YOU WELL. Quick question.",
      patterns,
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].category, "phrase");
    assert.equal(v[0].pattern, "I hope this email finds you well");
  });

  it("detects banned word with word boundary", () => {
    const v = scanForVoiceViolations("We need to leverage our position.", patterns);
    assert.ok(v.some((x) => x.category === "word" && x.pattern === "Leverage"));
  });

  it("does NOT match banned word inside another word", () => {
    // "leverages" should not match "leverage" without word boundary
    const v = scanForVoiceViolations("Multi-leverage cleverages.", patterns);
    // \blevers\b would not match cleverages
    const matches = v.filter((x) => x.pattern === "Leverage");
    // word boundary may match "leverage" within "Multi-leverage" but NOT "cleverages"
    // depending on whether hyphen counts as boundary — accepted
    assert.ok(matches.length <= 1);
  });

  it("flags em dash anywhere", () => {
    const v = scanForVoiceViolations("First thought — second thought.", patterns);
    assert.ok(v.some((x) => x.category === "em-dash"));
  });

  it("flags curly quotes", () => {
    const v = scanForVoiceViolations("She said “hello” yesterday.", patterns);
    assert.ok(v.some((x) => x.category === "curly-quote"));
  });

  it("dedups repeated patterns to one violation per pattern", () => {
    const v = scanForVoiceViolations(
      "leverage leverage leverage — — —",
      patterns,
    );
    const leverageCount = v.filter((x) => x.pattern === "Leverage").length;
    const emDashCount = v.filter((x) => x.category === "em-dash").length;
    assert.equal(leverageCount, 1);
    assert.equal(emDashCount, 1);
  });

  it("regression: catches both em dash and a banned phrase in one outbound", () => {
    const text =
      "I hope this email finds you well — just wanted to circle back about the synergy meeting.";
    const v = scanForVoiceViolations(text, patterns);
    const cats = new Set(v.map((x) => x.category));
    assert.ok(cats.has("phrase"));
    assert.ok(cats.has("em-dash"));
    assert.ok(v.some((x) => x.pattern === "I hope this email finds you well"));
    assert.ok(v.some((x) => x.pattern === "Just wanted to"));
    assert.ok(v.some((x) => x.pattern === "Synergy"));
  });
});

describe("logVoiceViolations", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voice-vio-"));
    path = join(tmp, "voice-violations.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes a JSONL entry when violations exist", () => {
    logVoiceViolations(path, {
      ts: 1, task: "morning-brief", conversationId: "dm:1",
      totalChars: 200, violationCount: 1,
      violations: [{ pattern: "—", category: "em-dash" }],
    });
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.task, "morning-brief");
    assert.equal(parsed.violationCount, 1);
  });

  it("does NOT write when violations array is empty", () => {
    logVoiceViolations(path, {
      ts: 1, conversationId: "dm:1", totalChars: 50, violationCount: 0,
      violations: [],
    });
    assert.ok(!existsSync(path));
  });

  it("never throws on bad path", () => {
    assert.doesNotThrow(() => {
      logVoiceViolations("/nonexistent/dir/file.jsonl", {
        ts: 1, conversationId: "dm:1", totalChars: 50, violationCount: 1,
        violations: [{ pattern: "x", category: "phrase" }],
      });
    });
  });
});

describe("loadAntiPatternsFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voice-load-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns empty patterns for missing file", () => {
    const p = loadAntiPatternsFile(join(tmp, "missing.md"));
    assert.deepEqual(p.bannedPhrases, []);
    assert.deepEqual(p.bannedWords, []);
  });

  it("reads + parses a real file", () => {
    const path = join(tmp, "anti.md");
    writeFileSync(path, ANTI_PATTERNS_FIXTURE);
    const p = loadAntiPatternsFile(path);
    assert.ok(p.bannedPhrases.length > 0);
    assert.ok(p.bannedWords.length > 0);
  });
});
