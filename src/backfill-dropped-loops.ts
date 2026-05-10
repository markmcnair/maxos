import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendDroppedLoop } from "./dropped-loops-filter.js";
import { loadOpenLoops } from "./loop-reconciler.js";

/**
 * One-time backfill: scan all closures-*.md files in workspace/memory for
 * `[DECISION] dropped (loop-id) — Google Task deleted ...` lines, then
 * write a permanent tombstone for each into dropped-loops.md.
 *
 * Round O context: the reconciler historically wrote the DECISION line
 * to closures-{date}.md but never to dropped-loops.md. closures files
 * are only scanned for 2 days, so loops Mark deleted earlier than that
 * could be re-extracted by the LLM-driven debrief from a fresh meeting
 * transcript. This backfill walks the historical closures files and
 * writes the missing tombstones so the prune layer can see them.
 *
 * Idempotent: appendDroppedLoop skips entries whose (loop:xxx) marker
 * is already in dropped-loops.md, so re-running this is harmless.
 */

interface BackfillEntry {
  loopId: string;
  topic: string;
  date: string;        // YYYY-MM-DD
}

const DECISION_GOOGLE_TASK_RE =
  /^-\s+\[\d{1,2}:\d{2}\]\s+\[DECISION\]\s+dropped\s+\(([a-z0-9._\-]+)\)\s+—\s+Google Task deleted.*so\s+(.+?)\s+was never real\s*$/i;

export function parseGoogleTaskDecisionLine(
  line: string,
): { loopId: string; topic: string } | null {
  const m = line.match(DECISION_GOOGLE_TASK_RE);
  if (!m) return null;
  return { loopId: m[1], topic: m[2].trim() };
}

export function findClosureFiles(maxosHome: string): { path: string; date: string }[] {
  const dir = join(maxosHome, "workspace", "memory");
  if (!existsSync(dir)) return [];
  const files: { path: string; date: string }[] = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^closures-(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    files.push({ path: join(dir, name), date: m[1] });
  }
  // Sort chronologically — earlier deletions get written first, matching
  // the natural curation order of dropped-loops.md.
  files.sort((a, b) => a.date.localeCompare(b.date));
  return files;
}

export function collectGoogleTaskDeletions(
  maxosHome: string,
): BackfillEntry[] {
  const out: BackfillEntry[] = [];
  const seen = new Set<string>();  // dedup by loopId across all closure files
  for (const file of findClosureFiles(maxosHome)) {
    const content = readFileSync(file.path, "utf-8");
    for (const line of content.split("\n")) {
      const parsed = parseGoogleTaskDecisionLine(line);
      if (!parsed) continue;
      if (seen.has(parsed.loopId)) continue;
      seen.add(parsed.loopId);
      out.push({ loopId: parsed.loopId, topic: parsed.topic, date: file.date });
    }
  }
  return out;
}

export function runBackfill(maxosHome: string): { written: number; entries: BackfillEntry[] } {
  const entries = collectGoogleTaskDeletions(maxosHome);
  // Try to recover person names from the historical loops if they're still
  // floating around — otherwise leave undefined. open-loops.json only has
  // CURRENT loops, so most historical deletions won't have a person here.
  // That's fine — the bolded topic is enough for keyword matching.
  const liveLoops = loadOpenLoops(maxosHome);
  const personById = new Map<string, string | undefined>();
  for (const l of liveLoops) personById.set(l.id, l.person);

  for (const entry of entries) {
    appendDroppedLoop(maxosHome, {
      topic: entry.topic,
      loopId: entry.loopId,
      date: entry.date,
      reason: 'Mark deleted Google Task from "🤖 MaxOS Loops" (backfilled from closure log)',
      source: "google-task-deletion",
      person: personById.get(entry.loopId),
    });
  }
  return { written: entries.length, entries };
}

// CLI entry — `node dist/src/backfill-dropped-loops.js`
const isCLI = process.argv[1]?.endsWith("backfill-dropped-loops.js");
if (isCLI) {
  const maxosHome = process.env.MAXOS_HOME ?? join(homedir(), ".maxos");
  const r = runBackfill(maxosHome);
  if (r.written > 0) {
    console.log(`backfill-dropped-loops: wrote ${r.written} tombstones to dropped-loops.md`);
    for (const e of r.entries) console.log(`  - ${e.loopId} (deleted ${e.date}): ${e.topic.slice(0, 80)}`);
  } else {
    console.log("backfill-dropped-loops: nothing to backfill");
  }
}
