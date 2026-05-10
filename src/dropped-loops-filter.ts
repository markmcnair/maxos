import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenLoop } from "./loop-reconciler.js";

/**
 * Parse dropped-loops.md to extract the topic/title of each dropped entry.
 * Format convention: `- **Topic Title** — dropped YYYY-MM-DD. Reason: ...`
 *
 * Returns an array of topic strings (bolded text before the first em-dash).
 * Used deterministically to strip references to dropped loops from LLM
 * output, so the agent cannot resurface items Mark has explicitly retired.
 */
export function parseDroppedTopics(markdown: string): string[] {
  if (!markdown) return [];
  const topics: string[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("-")) continue;
    const m = line.match(/\*\*([^*]+)\*\*/);
    if (m && m[1].trim()) topics.push(m[1].trim());
  }
  return topics;
}

/**
 * Section header names under which dropped-loop references must be
 * filtered. We DO allow dropped items in Wins (legitimate to say "closed
 * the Torie loop") and in Ghosted (separate signal). Just Open Loops +
 * Top 3 for Tomorrow (the carry-forward sections).
 */
const FILTERED_SECTIONS = [
  /🔄\s*Open\s*Loops/i,
  /^##[^\n]*Open\s*Loops/im,
  /🎯\s*Top\s*3/i,
  /^##[^\n]*Top\s*3/im,
];

function isFilteredHeader(line: string): boolean {
  if (!line.trim().startsWith("##")) return false;
  return FILTERED_SECTIONS.some((re) => re.test(line));
}

function isSectionHeader(line: string): boolean {
  return line.trim().startsWith("##");
}

function buildTopicKeywords(topics: string[]): string[] {
  // For matching purposes, use each topic's first two significant words
  // (captures variants like "Torie micro-deposit" in a line saying
  // "Torie — Day 12" without matching unrelated content).
  const keywords: string[] = [];
  for (const topic of topics) {
    const words = topic
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .map((w) => w.replace(/[^\w]/g, "").toLowerCase())
      .filter(Boolean);
    if (words.length > 0) keywords.push(words.slice(0, 2).join(" "));
    // Also add the first significant word alone — catches e.g. "Torie"
    if (words[0] && words[0].length >= 4) keywords.push(words[0]);
  }
  return [...new Set(keywords)];
}

function lineMatchesAnyKeyword(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase();
  return keywords.some((kw) => {
    if (kw.includes(" ")) {
      // Two-word match requires both words present
      return kw.split(" ").every((w) => lower.includes(w));
    }
    // Single word — match as whole word to avoid partial hits
    return new RegExp(`\\b${kw}\\b`, "i").test(lower);
  });
}

/**
 * Strip any bullet/line under filtered sections (Open Loops / Top 3)
 * that references a dropped-loop topic. Other sections are untouched.
 *
 * This is the deterministic enforcement layer — the LLM can violate
 * prompt instructions ("don't re-raise dropped loops") but the output
 * gets post-processed before it reaches the user. Belt + suspenders.
 */
export function stripDroppedFromOutput(output: string, droppedTopics: string[]): string {
  if (droppedTopics.length === 0) return output;
  const keywords = buildTopicKeywords(droppedTopics);
  if (keywords.length === 0) return output;

  const lines = output.split("\n");
  const result: string[] = [];
  let inFilteredSection = false;
  let currentItemStart = -1;  // index in `result` where current bullet started
  let currentItemIsDropped = false;

  const flushItem = () => {
    if (currentItemIsDropped && currentItemStart >= 0) {
      // Remove lines from currentItemStart to end of result
      result.length = currentItemStart;
    }
    currentItemStart = -1;
    currentItemIsDropped = false;
  };

  for (const line of lines) {
    if (isSectionHeader(line)) {
      flushItem();
      inFilteredSection = isFilteredHeader(line);
      result.push(line);
      continue;
    }

    if (!inFilteredSection) {
      result.push(line);
      continue;
    }

    // Inside a filtered section
    const trimmed = line.trim();
    const isBullet = /^(\d+\.|[-*])\s/.test(trimmed);

    if (isBullet) {
      // Start of a new item — flush the previous one's decision
      flushItem();
      currentItemStart = result.length;
      currentItemIsDropped = lineMatchesAnyKeyword(line, keywords);
      result.push(line);
    } else {
      // Continuation line (indented, or blank, or prose)
      // If the item is being dropped, also drop continuation lines
      if (currentItemIsDropped && trimmed && !isBullet) {
        // continuation of dropped item — skip (don't add to result)
        continue;
      }
      result.push(line);
    }
  }
  flushItem();

  return result.join("\n");
}

/**
 * Prune open-loops.json entries whose topic or person matches any
 * dropped-loops entry. Used on daemon startup / reconciliation so the
 * structured loop store and the dropped-list stay consistent.
 *
 * Two matching paths, applied in order:
 *  1. Exact id match against `droppedLoopIds` — bullet-proof against
 *     the LLM re-adding the same id (which is what
 *     `(loop:xxx)` markers in dropped-loops.md let us track).
 *  2. Keyword match against `droppedTopics` (multi-word against full
 *     haystack, single-word against id/person only — Joey-Cook regression
 *     guard).
 *
 * Either match prunes the loop. Tested in dropped-loops-filter.test.ts.
 */
export function pruneOpenLoopsAgainstDropped(
  loops: OpenLoop[],
  droppedTopics: string[],
  droppedLoopIds: string[] = [],
): { remaining: OpenLoop[]; pruned: OpenLoop[] } {
  if (droppedTopics.length === 0 && droppedLoopIds.length === 0) {
    return { remaining: loops, pruned: [] };
  }
  const idSet = new Set(droppedLoopIds);
  const keywords = buildTopicKeywords(droppedTopics);
  // Multi-word keywords (e.g. "torie microdeposit") match against the full
  // haystack — both words must be present, so false-positives are unlikely.
  // Single-word keywords (e.g. "project", "robert") are way too generic to
  // match against free-text topic/notes — Joey Cook's "Eden Project Mission
  // Partner" got pruned by "Project Zero" until we scoped these. So
  // single-word keywords now match ONLY against id + person, not topic.
  const multiWordKws = keywords.filter((k) => k.includes(" "));
  const singleWordKws = keywords.filter((k) => !k.includes(" "));
  const remaining: OpenLoop[] = [];
  const pruned: OpenLoop[] = [];
  for (const loop of loops) {
    if (idSet.has(loop.id)) {
      pruned.push(loop);
      continue;
    }
    const fullHaystack = [loop.topic, loop.person ?? "", loop.notes ?? ""].join(" ");
    const idPersonHaystack = `${loop.id} ${loop.person ?? ""}`;
    const multiHit = lineMatchesAnyKeyword(fullHaystack, multiWordKws);
    const singleHit = lineMatchesAnyKeyword(idPersonHaystack, singleWordKws);
    if (multiHit || singleHit) {
      pruned.push(loop);
    } else {
      remaining.push(loop);
    }
  }
  return { remaining, pruned };
}

/**
 * Read dropped-loops.md from the workspace and return the parsed topics.
 * Returns empty array if the file doesn't exist.
 */
export function loadDroppedTopics(maxosHome: string): string[] {
  const path = join(maxosHome, "workspace", "memory", "dropped-loops.md");
  if (!existsSync(path)) return [];
  try {
    return parseDroppedTopics(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

const LOOP_ID_MARKER_RE = /\(loop:([a-z0-9._\-]+)\)/gi;

/**
 * Extract every loop id stamped into dropped-loops.md via the
 * `(loop:xxx)` marker that appendDroppedLoop writes for every entry it
 * creates. Used as the deterministic exact-match path in
 * pruneOpenLoopsAgainstDroppedIds — keyword matching can miss re-adds
 * with different wording, but if the LLM re-uses the same id slug, this
 * catches it 100%.
 */
export function loadDroppedLoopIds(maxosHome: string): string[] {
  const path = join(maxosHome, "workspace", "memory", "dropped-loops.md");
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf-8");
    const ids = new Set<string>();
    for (const match of content.matchAll(LOOP_ID_MARKER_RE)) {
      ids.add(match[1]);
    }
    return [...ids];
  } catch {
    return [];
  }
}

export interface DropEntry {
  /** Loop topic — what goes in the bolded heading. */
  topic: string;
  /** Loop id — used for idempotency check and (loop:xxx) marker. */
  loopId: string;
  /** YYYY-MM-DD when the drop happened. */
  date: string;
  /** Free text appended after "Reason: ". */
  reason: string;
  /** Where the drop signal came from. */
  source: "google-task-deletion" | "verbal" | "manual";
  /** Optional person — appended in parens after the bolded topic. */
  person?: string;
}

const ACTIVE_DROPS_HEADER = "## Active Drops";
const DEFAULT_HEADER = `---
name: dropped-loops
description: Persistent list of open loops Mark has explicitly told Max to drop — debrief and morning brief tasks check this before resurfacing items
type: reference
---

# Dropped Loops

When Mark says "drop it", "I don't need to do that", "skip it", or otherwise explicitly closes a loop that the debrief would carry forward — add it here. Future debrief and morning brief sessions check this list before resurfacing items.

Format: \`- **[Topic/Name]** — dropped [date]. Reason: [what Mark said]\`

${ACTIVE_DROPS_HEADER}
`;

function formatDropLine(entry: DropEntry): string {
  const personSuffix = entry.person ? ` (${entry.person})` : "";
  const sourceText =
    entry.source === "google-task-deletion"
      ? "via Google Task deletion"
      : entry.source === "manual"
        ? "manually"
        : "verbally";
  return `- **${entry.topic}**${personSuffix} — dropped ${entry.date} ${sourceText}. Reason: ${entry.reason}. (loop:${entry.loopId})`;
}

/**
 * Append a tombstone to dropped-loops.md so the LLM-driven debrief can't
 * re-create a loop that Mark has retired. Idempotent — checks for an
 * existing `(loop:xxx)` marker before writing.
 *
 * Called by the Google Tasks reconciler when it detects that a tracked
 * task has disappeared. The dropped-loops.md file is the source of truth
 * for both Filter 1 (output stripping in gateway) and the periodic prune
 * that runs in closure-watcher.
 */
export function appendDroppedLoop(maxosHome: string, entry: DropEntry): void {
  const path = join(maxosHome, "workspace", "memory", "dropped-loops.md");
  mkdirSync(dirname(path), { recursive: true });

  let content: string;
  if (existsSync(path)) {
    content = readFileSync(path, "utf-8");
  } else {
    content = DEFAULT_HEADER;
  }

  // Idempotency: skip if the loop id is already recorded.
  const idMarker = `(loop:${entry.loopId})`;
  if (content.includes(idMarker)) {
    return;
  }

  // Ensure the Active Drops section exists. If the user-curated file
  // doesn't have it (legacy / hand-edited), add one at the end.
  if (!content.includes(ACTIVE_DROPS_HEADER)) {
    if (!content.endsWith("\n")) content += "\n";
    content += `\n${ACTIVE_DROPS_HEADER}\n`;
  }

  // Append the new entry to the end of the file. Order is chronological
  // (by write time), which matches how the existing file is curated.
  if (!content.endsWith("\n")) content += "\n";
  content += `${formatDropLine(entry)}\n`;

  writeFileSync(path, content);
}
