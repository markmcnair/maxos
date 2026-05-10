/**
 * Deterministic safe-rewrite of voice violations on outbound text. Built
 * Round U (2026-05-07) after observing 99 em-dash violations in 14 days
 * sneak through to Telegram because the existing `voice-violations.ts`
 * only DETECTS, never STRIPS.
 *
 * Scope: SAFE rewrites only — substitutions where the meaning is
 * preserved with high confidence.
 *   - em-dash / en-dash → hyphen
 *   - curly quotes → straight
 *   - line-leading AI tells ("Sure!", "Great question!", "Of course!",
 *     "I'd be happy to") → stripped
 *
 * Out of scope (still flagged by voice-violations.ts but NOT rewritten):
 *   - banned phrases ("going forward", "leverage", "pivot")
 *   - voice rephrasing (changes meaning, not safe to automate)
 *
 * Crucially: code blocks (` and ```) and URLs are protected — em-dashes
 * inside CLI examples or URL paths must survive.
 */

export type RewriteCategory =
  | "em-dash"
  | "en-dash"
  | "curly-double-quote"
  | "curly-single-quote"
  | "ai-tell";

export interface RewriteResult {
  text: string;
  totalChanges: number;
  changesByCategory: Partial<Record<RewriteCategory, number>>;
}

// ───── Protect code blocks + URLs from rewriting ─────

interface ProtectedSpan {
  start: number;
  end: number;
  marker: string;
}

const FENCED_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /https?:\/\/[^\s)]+/g;

/**
 * Replace protected spans (code, URLs) with placeholder markers so the
 * rewrite passes don't touch their content. Caller restores them after.
 */
function protectSpans(text: string): { protectedText: string; spans: Array<{ marker: string; original: string }> } {
  const spans: Array<{ marker: string; original: string }> = [];
  let counter = 0;
  let out = text;

  // Order matters: fenced first, then inline, then URLs (URLs may overlap
  // with inline code visually but inline-code regex won't span newlines)
  for (const re of [FENCED_RE, INLINE_CODE_RE, URL_RE]) {
    out = out.replace(re, (match) => {
      const marker = `\x00PROTECTED_${counter++}\x00`;
      spans.push({ marker, original: match });
      return marker;
    });
  }
  return { protectedText: out, spans };
}

function restoreSpans(text: string, spans: Array<{ marker: string; original: string }>): string {
  let out = text;
  for (const { marker, original } of spans) {
    out = out.replace(marker, original);
  }
  return out;
}

// ───── Individual rewriters ─────

function rewriteEmDashes(text: string): { text: string; count: number } {
  // U+2014 EM DASH → "-". Strip surrounding spaces if double-spaced.
  let count = 0;
  const out = text.replace(/—/g, () => { count++; return "-"; });
  return { text: out, count };
}

function rewriteEnDashes(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/–/g, () => { count++; return "-"; });
  return { text: out, count };
}

function rewriteCurlyDoubleQuotes(text: string): { text: string; count: number } {
  let count = 0;
  // U+201C, U+201D, U+201E, U+201F
  const out = text.replace(/[“”„‟]/g, () => { count++; return '"'; });
  return { text: out, count };
}

function rewriteCurlySingleQuotes(text: string): { text: string; count: number } {
  let count = 0;
  // U+2018, U+2019, U+201A, U+201B
  const out = text.replace(/[‘’‚‛]/g, () => { count++; return "'"; });
  return { text: out, count };
}

// AI tells at line start. Anchored to BEGINNING of a line. Whole phrase + trailing punct + any space.
const AI_TELL_PATTERNS: RegExp[] = [
  /^(Sure!?\s+)/i,
  /^(Of course!?\s+)/i,
  /^(Certainly!?\s+)/i,
  /^(Absolutely!?\s+)/i,
  /^(Great question!?\s+)/i,
  /^(I'?d be happy to (help|assist|do)( with)?[.!,]?\s*)/i,
  /^(Happy to help[.!,]?\s+)/i,
  /^(Glad to (help|assist)[.!,]?\s+)/i,
];

function rewriteAiTells(text: string): { text: string; count: number } {
  // Process line by line to anchor at line start
  const lines = text.split("\n");
  let count = 0;
  const out = lines.map((line) => {
    let trimmed = line;
    for (const re of AI_TELL_PATTERNS) {
      const before = trimmed;
      trimmed = trimmed.replace(re, "");
      if (trimmed !== before) {
        count++;
        break;
      }
    }
    return trimmed;
  });
  return { text: out.join("\n"), count };
}

// ───── Orchestrator ─────

/**
 * Rewrite safe voice violations. Order matters: protect spans first so
 * rewriters don't touch code/URLs. Apply rewrites. Restore spans.
 */
export function safeRewrite(text: string): RewriteResult {
  if (!text) return { text: "", totalChanges: 0, changesByCategory: {} };

  const { protectedText, spans } = protectSpans(text);

  let working = protectedText;
  const changes: Partial<Record<RewriteCategory, number>> = {};

  const em = rewriteEmDashes(working);
  working = em.text;
  if (em.count > 0) changes["em-dash"] = em.count;

  const en = rewriteEnDashes(working);
  working = en.text;
  if (en.count > 0) changes["en-dash"] = en.count;

  const dq = rewriteCurlyDoubleQuotes(working);
  working = dq.text;
  if (dq.count > 0) changes["curly-double-quote"] = dq.count;

  const sq = rewriteCurlySingleQuotes(working);
  working = sq.text;
  if (sq.count > 0) changes["curly-single-quote"] = sq.count;

  const tells = rewriteAiTells(working);
  working = tells.text;
  if (tells.count > 0) changes["ai-tell"] = tells.count;

  const restored = restoreSpans(working, spans);
  const totalChanges = Object.values(changes).reduce((a, b) => a + b, 0);
  return { text: restored, totalChanges, changesByCategory: changes };
}
