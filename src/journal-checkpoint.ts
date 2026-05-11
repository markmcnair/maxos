#!/usr/bin/env node
/**
 * Deterministic journal checkpoint — replaces the LLM-based 25,55 task.
 *
 * Reads today's closures file, finds entries added since the most recent
 * journal header timestamp, and either:
 *   - exits silently if 0 new closures (the common case — ~95% of fires)
 *   - appends a "### Checkpoint (H:MM AM/PM)" block grouping the new
 *     closures by tag, then exits
 *
 * Pre-fix this task spawned a full LLM session every 30 minutes — 48
 * fires per day, each loading ~20K tokens of workspace context — only to
 * produce no output ~95% of the time because the prompt was "if anything
 * substantive happened, write it; otherwise do nothing." The 5% of fires
 * with genuine activity write a closures list, which is exactly the
 * deterministic output below. No LLM judgment was actually being used.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface JournalHeader {
  /** Normalized 24-hour "HH:MM" */
  iso: string;
  /** Raw header text after "### " */
  title: string;
}

export interface Closure {
  /** "HH:MM" (24-hour, from the closure line itself) */
  iso: string;
  /** "CLOSURE" | "DECISION" | "FACT" | "FACT new-loop" | ... */
  tag: string;
  description: string;
}

/**
 * Parse "10:04 PM" / "6:02 AM" / "10:04 pm" → "22:04" / "06:02".
 * Returns null on parse failure.
 */
export function twelveTo24(time: string): string | null {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(min) || h < 1 || h > 12 || min < 0 || min > 59) return null;
  const isPm = m[3].toUpperCase() === "PM";
  if (h === 12) h = isPm ? 12 : 0;
  else if (isPm) h += 12;
  return `${h.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}`;
}

/** Inverse: "22:04" → "10:04 PM". */
export function twentyFourTo12(iso: string): string {
  const [hStr, mStr] = iso.split(":");
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const period = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m.toString().padStart(2, "0")} ${period}`;
}

/**
 * Extract every "### Title (H:MM AM/PM)" header from a daily journal.
 * Order matches file order. Bad headers are skipped silently.
 */
export function parseJournalHeaders(content: string): JournalHeader[] {
  const out: JournalHeader[] = [];
  const re = /^###\s+(.+?)\s+\((\d{1,2}:\d{2}\s*[APap][Mm])\)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const iso = twelveTo24(match[2]);
    if (!iso) continue;
    out.push({ iso, title: match[1].trim() });
  }
  return out;
}

/**
 * Extract every "- [HH:MM] [TAG] description" line from a closures file.
 * Tag captures everything inside the second pair of brackets so
 * "[FACT] new-loop" stays as a single logical tag the formatter can
 * group on. Description trims trailing whitespace.
 */
export function parseClosures(content: string): Closure[] {
  const out: Closure[] = [];
  const re = /^-\s+\[(\d{2}:\d{2})\]\s+\[([A-Z][A-Z_ -]*)\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    out.push({
      iso: match[1],
      tag: match[2].trim(),
      description: match[3].trim(),
    });
  }
  return out;
}

/**
 * Most recent journal header timestamp, or null if the file has no
 * parseable headers yet today. Null means "the day just started, every
 * closure so far is new."
 */
export function lastCheckpointTime(headers: JournalHeader[]): string | null {
  if (headers.length === 0) return null;
  let max = headers[0].iso;
  for (const h of headers) if (h.iso > max) max = h.iso;
  return max;
}

/** Strict greater-than. iso strings sort lexicographically when zero-padded. */
export function closuresSince(
  closures: Closure[],
  since: string | null,
): Closure[] {
  if (since === null) return [...closures];
  return closures.filter((c) => c.iso > since);
}

/**
 * Render a checkpoint block. Groups closures by tag (CLOSURE / DECISION /
 * FACT / others), preserves chronological order within each group, and
 * emits the same `- [HH:MM] [TAG] description` shape the closures file
 * uses — so the journal stays readable and grep-friendly. Empty
 * `closures` returns "" so the caller knows to skip the write.
 */
export function formatCheckpoint(closures: Closure[], now: Date): string {
  if (closures.length === 0) return "";
  const isoNow = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
  const headerTime = twentyFourTo12(isoNow);
  // Stable tag ordering: CLOSURE, DECISION, FACT first, then everything else alpha.
  const TAG_ORDER = ["CLOSURE", "DECISION", "FACT"];
  const grouped = new Map<string, Closure[]>();
  for (const c of closures) {
    if (!grouped.has(c.tag)) grouped.set(c.tag, []);
    grouped.get(c.tag)!.push(c);
  }
  const orderedTags: string[] = [];
  for (const t of TAG_ORDER) if (grouped.has(t)) orderedTags.push(t);
  for (const t of [...grouped.keys()].sort()) {
    if (!TAG_ORDER.includes(t)) orderedTags.push(t);
  }
  const lines: string[] = [`\n### Checkpoint (${headerTime})`, ""];
  for (const tag of orderedTags) {
    for (const c of grouped.get(tag)!) {
      lines.push(`- [${c.iso}] [${tag}] ${c.description}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

interface RunResult {
  wrote: boolean;
  closureCount: number;
  reason?: string;
}

/** Side-effecting entry: the script's main. Exported for testability. */
export function runJournalCheckpoint(
  workspaceDir: string,
  now: Date,
): RunResult {
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const journalPath = join(workspaceDir, "memory", `${ymd}.md`);
  const closuresPath = join(workspaceDir, "memory", `closures-${ymd}.md`);

  if (!existsSync(closuresPath)) {
    return { wrote: false, closureCount: 0, reason: "no closures file today" };
  }

  const closuresContent = readFileSync(closuresPath, "utf-8");
  const closures = parseClosures(closuresContent);
  if (closures.length === 0) {
    return { wrote: false, closureCount: 0, reason: "closures file empty" };
  }

  const journalContent = existsSync(journalPath)
    ? readFileSync(journalPath, "utf-8")
    : "";
  const headers = parseJournalHeaders(journalContent);
  const since = lastCheckpointTime(headers);
  const fresh = closuresSince(closures, since);

  if (fresh.length === 0) {
    return { wrote: false, closureCount: 0, reason: "no closures since last checkpoint" };
  }

  const block = formatCheckpoint(fresh, now);
  appendFileSync(journalPath, block);
  return { wrote: true, closureCount: fresh.length };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const workspace = process.env.MAXOS_WORKSPACE
    ?? join(process.env.MAXOS_HOME ?? `${process.env.HOME}/.maxos`, "workspace");
  const result = runJournalCheckpoint(workspace, new Date());
  if (result.wrote) {
    console.log(`journal-checkpoint: appended ${result.closureCount} closure(s)`);
  } else if (result.reason) {
    // Silent skip — the [script] [silent] task drops this to daemon.log.
    console.log(`journal-checkpoint: skip (${result.reason})`);
  }
}
