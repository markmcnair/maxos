import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 */
export function pruneOpenLoopsAgainstDropped(
  loops: OpenLoop[],
  droppedTopics: string[],
): { remaining: OpenLoop[]; pruned: OpenLoop[] } {
  if (droppedTopics.length === 0) return { remaining: loops, pruned: [] };
  const keywords = buildTopicKeywords(droppedTopics);
  const remaining: OpenLoop[] = [];
  const pruned: OpenLoop[] = [];
  for (const loop of loops) {
    const haystack = [loop.topic, loop.person ?? "", loop.notes ?? ""].join(" ");
    if (lineMatchesAnyKeyword(haystack, keywords)) {
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
