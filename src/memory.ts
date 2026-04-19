import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface QmdHit {
  docid: string;
  score: number;
  file: string;
  title: string;
  snippet: string;
  context?: string;
}

export interface BuildMemoryOptions {
  maxosHome?: string;
  now?: Date;
  /** Skip QMD search (tests / offline / degraded mode). */
  skipQmd?: boolean;
  /** QMD binary path — override for tests. */
  qmdPath?: string;
  /** QMD search timeout. */
  qmdTimeoutMs?: number;
  /** Max chars for QMD-injected snippets section. */
  qmdMaxChars?: number;
}

/**
 * Format a date as YYYY-MM-DD in local time. We intentionally use local
 * time (not UTC) because closure files are named for the user's calendar day.
 */
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Read the closures file for a given date. Returns the raw file content,
 * or null if it doesn't exist. Closures live under workspace/memory/ so
 * they're automatically indexed by the QMD memory collection.
 */
export function readClosuresFile(maxosHome: string, date: Date): string | null {
  const ymd = ymdLocal(date);
  const path = join(maxosHome, "workspace", "memory", `closures-${ymd}.md`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function readDroppedLoops(maxosHome: string): string | null {
  const path = join(maxosHome, "workspace", "memory", "dropped-loops.md");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pull a short search query out of a task prompt. Task prompts are
 * typically 1-3 lines ("Run the morning brief: read X and execute"),
 * so taking the first 5 lines and stripping punctuation is enough to
 * get a reasonable BM25 keyword search.
 */
export function extractSearchQuery(prompt: string): string {
  if (!prompt) return "";
  const firstLines = prompt.split("\n").slice(0, 5).join(" ").trim();
  if (!firstLines) return "";
  return firstLines
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Format QMD search hits into a markdown block capped at `maxChars`.
 * Empty input returns an empty string (caller can skip the section).
 */
export function formatQmdHits(hits: QmdHit[], maxChars = 3000): string {
  if (!hits || hits.length === 0) return "";
  const header = "### Semantic memory hits";
  const parts: string[] = [header];
  let total = header.length + 1;
  for (const h of hits) {
    const scorePct = Math.round((h.score ?? 0) * 100);
    const block = `**${h.title}** — \`${h.file}\` (score ${scorePct}%)\n${h.snippet.trim()}`;
    if (total + block.length + 2 > maxChars) break;
    parts.push(block);
    total += block.length + 2;
  }
  return parts.length > 1 ? parts.join("\n\n") : "";
}

async function runQmdSearch(
  query: string,
  limit: number,
  qmdPath: string,
  timeoutMs: number,
): Promise<QmdHit[]> {
  try {
    const { stdout } = await execFileAsync(
      qmdPath,
      ["search", query, "-n", String(limit), "--json"],
      { timeout: timeoutMs },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as QmdHit[]) : [];
  } catch {
    return [];
  }
}

/**
 * Build the memory-context block that gets prepended to a scheduled task's
 * prompt before the Claude one-shot runs. Returns empty string if there's
 * no useful context — caller should skip the prefix entirely in that case.
 *
 * Content layers (in order):
 *   1. Today's closures — facts the interactive session captured today
 *   2. Yesterday's closures — relevant for morning briefs / handoffs
 *   3. Dropped-loops — items Mark has told Max to stop tracking
 *   4. QMD semantic hits — top-N BM25 matches on the prompt keywords
 *
 * Each layer is optional; if nothing is available, the function returns "".
 */
export async function buildMemoryContext(
  prompt: string,
  options: BuildMemoryOptions = {},
): Promise<string> {
  const {
    maxosHome = process.env.MAXOS_HOME || join(homedir(), ".maxos"),
    now = new Date(),
    skipQmd = false,
    qmdPath = "qmd",
    qmdTimeoutMs = 2000,
    qmdMaxChars = 3000,
  } = options;

  if (!existsSync(maxosHome)) return "";

  const sections: string[] = [];

  const today = readClosuresFile(maxosHome, now);
  if (today) sections.push(`### Today's closures (facts Mark confirmed today)\n${today}`);

  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = readClosuresFile(maxosHome, yesterdayDate);
  if (yesterday) sections.push(`### Yesterday's closures\n${yesterday}`);

  const dropped = readDroppedLoops(maxosHome);
  if (dropped) sections.push(`### Previously dropped loops (do NOT resurface)\n${dropped}`);

  if (!skipQmd) {
    const query = extractSearchQuery(prompt);
    if (query) {
      const hits = await runQmdSearch(query, 5, qmdPath, qmdTimeoutMs);
      const qmdBlock = formatQmdHits(hits, qmdMaxChars);
      if (qmdBlock) sections.push(qmdBlock);
    }
  }

  if (sections.length === 0) return "";

  return `## Recent Memory Context\n\n${sections.join("\n\n")}`;
}
