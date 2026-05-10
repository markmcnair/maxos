import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const JOURNAL_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const CLOSURES_RE = /^closures-(\d{4}-\d{2}-\d{2})\.md$/;

function ymdToDate(ymd: string): Date | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Pure helper — return file basenames from `entries` that are journal-shaped
 * (`YYYY-MM-DD.md` or `closures-YYYY-MM-DD.md`) AND whose date is more than
 * `ageDays` before `now`. Tested directly without filesystem.
 */
export function selectFilesToArchive(
  entries: string[],
  now: Date,
  ageDays: number,
): string[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - ageDays);
  const out: string[] = [];
  for (const name of entries) {
    let dateStr: string | null = null;
    const m1 = name.match(JOURNAL_RE);
    if (m1) dateStr = m1[1];
    const m2 = name.match(CLOSURES_RE);
    if (m2) dateStr = m2[1];
    if (!dateStr) continue;
    const date = ymdToDate(dateStr);
    if (!date) continue;
    if (date < cutoff) out.push(name);
  }
  return out;
}

export interface ArchiveResult {
  movedCount: number;
  movedFiles: string[];
}

/**
 * Move daily journal and closures files older than `ageDays` from
 * `memory/` to `memory/archive/`. QMD continues to index the archive
 * (per workspace-wide qmd embed runs) so semantic search isn't affected.
 *
 * Default `ageDays` is 30 — keeps a month of fresh files in the live
 * memory dir for chat context + brief reads, archives everything older.
 */
export function archiveOldJournals(
  maxosHome: string,
  now: Date = new Date(),
  ageDays = 30,
): ArchiveResult {
  const memoryDir = join(maxosHome, "workspace", "memory");
  if (!existsSync(memoryDir)) return { movedCount: 0, movedFiles: [] };
  const archiveDir = join(memoryDir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const entries = readdirSync(memoryDir);
  const toMove = selectFilesToArchive(entries, now, ageDays);
  const moved: string[] = [];
  for (const name of toMove) {
    const src = join(memoryDir, name);
    const dest = join(archiveDir, name);
    try {
      renameSync(src, dest);
      moved.push(name);
    } catch {
      // Best-effort: if rename fails (race condition, permission), skip
      // and continue. Losing one archival cycle isn't catastrophic.
    }
  }
  return { movedCount: moved.length, movedFiles: moved };
}

// CLI entry — `node dist/src/journal-archiver.js`
const isCLI = process.argv[1]?.endsWith("journal-archiver.js");
if (isCLI) {
  const maxosHome = process.env.MAXOS_HOME || `${process.env.HOME}/.maxos`;
  const ageArg = process.argv.indexOf("--age-days");
  const ageDays = ageArg >= 0 ? Number(process.argv[ageArg + 1]) : 30;
  const r = archiveOldJournals(maxosHome, new Date(), ageDays);
  if (r.movedCount > 0) {
    console.log(`journal-archiver: moved ${r.movedCount} files to archive/: ${r.movedFiles.join(", ")}`);
  }
}
