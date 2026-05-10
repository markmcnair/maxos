import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface VoicePatterns {
  bannedPhrases: string[];
  bannedWords: string[];
}

export type ViolationCategory = "phrase" | "word" | "em-dash" | "curly-quote";

export interface VoiceViolation {
  pattern: string;
  category: ViolationCategory;
  /** First match position in the original text (chars). */
  position?: number;
}

const PHRASE_HEADINGS = [
  "banned phrases",
  "banned sign-offs",
  "banned hedging",
  "banned ai tells",
];
const WORD_HEADINGS = ["banned words"];

function stripQuotes(s: string): string {
  return s
    .replace(/^["'“‘]/, "")
    .replace(/["'”’]\s*\.{0,3}\s*$/, "")
    .trim();
}

/**
 * Parse `voice/anti-patterns.md`. H2 headings determine the category:
 *   - "Banned Phrases" / "Banned Sign-Offs" / "Banned Hedging" / "Banned AI Tells"
 *     → bullet items become banned PHRASES (substring match)
 *   - "Banned Words" → bullet items become banned WORDS (word-boundary match)
 *
 * Items wrapped in straight or curly quotes are unwrapped. Trailing
 * parenthesized notes (e.g., "Pivot (in non-startup contexts)") are dropped
 * so only the pattern itself remains.
 */
export function parseAntiPatterns(content: string): VoicePatterns {
  const phrases: string[] = [];
  const words: string[] = [];
  let mode: "phrase" | "word" | "skip" = "skip";

  for (const line of content.split("\n")) {
    const trim = line.trim();
    if (trim.startsWith("## ")) {
      const heading = trim.slice(3).toLowerCase();
      if (PHRASE_HEADINGS.some((h) => heading.startsWith(h))) mode = "phrase";
      else if (WORD_HEADINGS.some((h) => heading.startsWith(h))) mode = "word";
      else mode = "skip";
      continue;
    }
    if (mode === "skip") continue;
    if (!trim.startsWith("- ")) continue;

    let item = trim.slice(2).trim();
    item = stripQuotes(item);
    item = item.replace(/\s*\([^)]*\)\s*$/, "").trim();
    item = item.replace(/\s*\.\.\.$/, "").trim();
    // For "X / Y" or "X (verb form)" entries, take the first token group
    const slashSplit = item.split(/\s*\/\s*/);
    if (mode === "word" && slashSplit.length > 1) {
      for (const w of slashSplit) {
        const cleaned = stripQuotes(w).trim();
        if (cleaned) words.push(cleaned);
      }
      continue;
    }
    if (!item) continue;
    if (mode === "phrase") phrases.push(item);
    else if (mode === "word") words.push(item);
  }
  return { bannedPhrases: phrases, bannedWords: words };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan `text` for voice violations. Pure — no FS access. Doesn't modify
 * the text. Returns one entry per detected pattern (de-duplicated by
 * pattern + category, so a phrase that appears 5 times is logged once).
 */
export function scanForVoiceViolations(
  text: string,
  patterns: VoicePatterns,
): VoiceViolation[] {
  const violations: VoiceViolation[] = [];
  if (!text) return violations;
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const push = (v: VoiceViolation) => {
    const key = `${v.category}:${v.pattern.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(v);
  };

  for (const phrase of patterns.bannedPhrases) {
    const lp = phrase.toLowerCase();
    if (!lp) continue;
    const idx = lower.indexOf(lp);
    if (idx >= 0) push({ pattern: phrase, category: "phrase", position: idx });
  }

  for (const word of patterns.bannedWords) {
    const lw = word.toLowerCase();
    if (!lw) continue;
    if (lw.includes(" ")) {
      // Multi-token "word" — substring match (matches "circle back", "deep dive")
      if (lower.includes(lw)) push({ pattern: word, category: "word" });
      continue;
    }
    const re = new RegExp(`\\b${escapeRegex(lw)}\\b`, "i");
    if (re.test(text)) push({ pattern: word, category: "word" });
  }

  // Em dashes — banned everywhere
  const emDashIdx = text.indexOf("—");
  if (emDashIdx >= 0) push({ pattern: "—", category: "em-dash", position: emDashIdx });

  // Curly quotes — banned in technical contexts; we flag them everywhere and
  // let the consumer decide if it matters
  if (/[“”‘’]/.test(text)) {
    push({ pattern: "curly quotes", category: "curly-quote" });
  }

  return violations;
}

export interface VoiceViolationLogEntry {
  ts: number;
  task?: string;
  conversationId: string;
  totalChars: number;
  violationCount: number;
  violations: VoiceViolation[];
}

/**
 * Best-effort append. Empty violations array → no log line (silence on
 * clean output). Never throws.
 */
export function logVoiceViolations(
  path: string,
  entry: VoiceViolationLogEntry,
): void {
  if (entry.violations.length === 0) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // never block the send
  }
}

/**
 * Read + parse the anti-patterns file. Returns empty patterns when the
 * file is missing — daemon should still send messages without it.
 */
export function loadAntiPatternsFile(path: string): VoicePatterns {
  if (!existsSync(path)) return { bannedPhrases: [], bannedWords: [] };
  try {
    return parseAntiPatterns(readFileSync(path, "utf-8"));
  } catch {
    return { bannedPhrases: [], bannedWords: [] };
  }
}
