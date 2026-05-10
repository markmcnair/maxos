import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const PREP_FILE_RE = /^(\d{4}-\d{2}-\d{2})-.+\.md$/;

function ymdToDate(ymd: string): Date | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Pure helper — return the basenames in `entries` that look like dated
 * meeting-prep files AND whose date is more than `ageDays` before `now`.
 * Tested directly without filesystem.
 */
export function selectPrepFilesToArchive(
  entries: string[],
  now: Date,
  ageDays: number,
): string[] {
  // Date-only cutoff so the threshold is calendar-aligned. A file dated
  // exactly `ageDays` ago is NOT archived (boundary is exclusive).
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - ageDays);
  const out: string[] = [];
  for (const name of entries) {
    const m = name.match(PREP_FILE_RE);
    if (!m) continue;
    const date = ymdToDate(m[1]);
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
 * Move dated meeting-prep files (`YYYY-MM-DD-*.md`) older than `ageDays`
 * from `vault/Work/Meeting Prep/` to `vault/Work/Meeting Prep/archive/`.
 *
 * Why this matters: stale prep files semantically associate ad-hoc people
 * with recurring meeting names (e.g., one Apr-17 meeting tagged "mark-
 * squared-mike-salem.md" leaks "Mike Salem" into every future "Mark
 * Squared" QMD lookup). Aging them out of the live search prefix removes
 * the contamination without losing the historical record.
 *
 * QMD's vault crawler should be configured to exclude `archive/` paths
 * (or we filter those hits in memory.ts) — but the move alone restores
 * Apr-29's brief to a clean attendee list.
 */
export function archiveOldMeetingPreps(
  vaultRoot: string,
  now: Date = new Date(),
  ageDays = 7,
): ArchiveResult {
  const prepDir = join(vaultRoot, "Work", "Meeting Prep");
  if (!existsSync(prepDir)) return { movedCount: 0, movedFiles: [] };
  const archiveDir = join(prepDir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const entries = readdirSync(prepDir).filter((name) => {
    const full = join(prepDir, name);
    try {
      return statSync(full).isFile();
    } catch {
      return false;
    }
  });
  const toMove = selectPrepFilesToArchive(entries, now, ageDays);
  const moved: string[] = [];
  for (const name of toMove) {
    const src = join(prepDir, name);
    const dest = join(archiveDir, name);
    try {
      renameSync(src, dest);
      moved.push(name);
    } catch {
      // best-effort
    }
  }
  return { movedCount: moved.length, movedFiles: moved };
}

const isCLI = process.argv[1]?.endsWith("meeting-prep-archiver.js");
if (isCLI) {
  const vaultRoot =
    process.env.VAULT_ROOT ||
    `${process.env.HOME}/.maxos/vault`;
  const ageArg = process.argv.indexOf("--age-days");
  const ageDays = ageArg >= 0 ? Number(process.argv[ageArg + 1]) : 7;
  const r = archiveOldMeetingPreps(vaultRoot, new Date(), ageDays);
  if (r.movedCount > 0) {
    console.log(
      `meeting-prep-archiver: moved ${r.movedCount} file${r.movedCount === 1 ? "" : "s"} to archive/: ` +
        r.movedFiles.slice(0, 5).join(", ") +
        (r.movedFiles.length > 5 ? `, +${r.movedFiles.length - 5} more` : ""),
    );
  }
}
