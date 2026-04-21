import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadDossiers, type Dossier } from "./calendar-brief.js";
import { normalizePhone } from "./closure-watcher.js";

const execFileAsync = promisify(execFile);

export type OverdueClassification = "current" | "overdue" | "needs-baseline" | "skip";

export interface RelationshipStatus {
  name: string;
  orbit: string;
  phone?: string;
  lastTouchpoint: string | undefined;
  lastTouchpointUpdated: boolean;
  classification: OverdueClassification;
  daysOverdue: number;
  path: string;
}

// ───── Pure helpers ──────────────────────────────────────────────────────

/**
 * Days between two YYYY-MM-DD date strings. Returns -1 if either is invalid.
 * Order-independent (absolute value).
 */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return -1;
  return Math.abs(Math.round((tb - ta) / (24 * 60 * 60 * 1000)));
}

/**
 * Deterministic overdue classification per orbit cadence:
 *   Inner Core: skip (daily life, built-in)
 *   The Chosen: overdue > 7 days
 *   The Circle: overdue > 30 days
 *   The Network: overdue > 90 days
 */
export function classifyOverdue(
  orbit: string,
  lastTouchpoint: string | undefined,
  today: string,
): OverdueClassification {
  if (orbit === "Inner Core") return "skip";
  if (!lastTouchpoint) return "needs-baseline";
  const days = daysBetween(lastTouchpoint, today);
  if (days < 0) return "needs-baseline";
  const threshold = orbit === "The Chosen" ? 7
    : orbit === "The Circle" ? 30
    : orbit === "The Network" ? 90
    : Number.POSITIVE_INFINITY;
  return days > threshold ? "overdue" : "current";
}

function daysOverdueFor(
  orbit: string,
  lastTouchpoint: string | undefined,
  today: string,
): number {
  if (!lastTouchpoint) return 0;
  const days = daysBetween(lastTouchpoint, today);
  const threshold = orbit === "The Chosen" ? 7
    : orbit === "The Circle" ? 30
    : orbit === "The Network" ? 90
    : 0;
  return Math.max(0, days - threshold);
}

export function formatRelationshipKit(statuses: RelationshipStatus[], todayISO: string): string {
  const lines: string[] = [];
  lines.push(`## Relationship Kit — ${todayISO} (deterministic — do NOT re-derive)`);
  lines.push("");
  lines.push("**Rules (NON-NEGOTIABLE):**");
  lines.push("- Overdue / current / needs-baseline classifications below are computed from the dossier's `last_touchpoint` and orbit cadence. DO NOT override.");
  lines.push("- `last_touchpoint` values that were just auto-refreshed from iMessage are flagged — those are FRESH, trust them.");
  lines.push("- DO NOT query iMessage again in the task — the refresh has already run.");
  lines.push("");

  if (statuses.length === 0) {
    lines.push("_No dossiers found in Relationships/._");
    return lines.join("\n");
  }

  const overdue = statuses.filter((s) => s.classification === "overdue");
  const needsBaseline = statuses.filter((s) => s.classification === "needs-baseline");
  const autoRefreshed = statuses.filter((s) => s.lastTouchpointUpdated);

  const byOrbit = (orbit: string) => overdue
    .filter((s) => s.orbit === orbit)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  for (const [orbit, cadence] of [
    ["The Chosen", "weekly"],
    ["The Circle", "monthly"],
    ["The Network", "quarterly"],
  ]) {
    const items = byOrbit(orbit);
    if (items.length === 0) continue;
    lines.push(`### ⚠️ Overdue — ${orbit} (${cadence} cadence)`);
    for (const s of items) {
      const tp = s.lastTouchpoint ? ` (last: ${s.lastTouchpoint})` : "";
      lines.push(`- **${s.name}** — ${s.daysOverdue} days overdue${tp}`);
    }
    lines.push("");
  }

  if (needsBaseline.length > 0) {
    lines.push(`### ❓ Needs Baseline (${needsBaseline.length})`);
    for (const s of needsBaseline) {
      lines.push(`- **${s.name}** (${s.orbit}) — no touchpoint recorded. Establish baseline.`);
    }
    lines.push("");
  }

  if (autoRefreshed.length > 0) {
    lines.push(`### 🔄 Auto-Refreshed (${autoRefreshed.length} touchpoints updated from iMessage this run)`);
    for (const s of autoRefreshed) {
      lines.push(`- ${s.name} (${s.orbit}) → ${s.lastTouchpoint}`);
    }
    lines.push("");
  }

  if (overdue.length === 0 && needsBaseline.length === 0) {
    lines.push("_All orbit cadences are current — nothing overdue._");
  }

  return lines.join("\n").trimEnd();
}

// ───── Subprocess + integration ──────────────────────────────────────────

async function fetchLastMessageDate(phone: string): Promise<string | null> {
  const digits = normalizePhone(phone);
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);

  // sqlite3 query gets the most recent message (either direction) with this contact.
  const sql = `SELECT datetime(MAX(m.date)/1000000000 + 978307200, 'unixepoch', 'localtime')
    FROM handle h
    JOIN message m ON h.ROWID = m.handle_id
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(h.id, '+', ''), '-', ''), '(', ''), ')', ''), ' ', '') LIKE '%${last10}%'`;

  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [join(homedir(), "Library", "Messages", "chat.db"), sql],
      { timeout: 10_000 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    // Output format: "2026-04-20 13:57:07" — take date portion
    return trimmed.slice(0, 10);
  } catch {
    return null;
  }
}

function parseFrontmatter(content: string): { fm: Record<string, string>; bodyStart: number } {
  const fm: Record<string, string> = {};
  if (!content.startsWith("---\n")) return { fm, bodyStart: 0 };
  const endIdx = content.indexOf("\n---", 4);
  if (endIdx < 0) return { fm, bodyStart: 0 };
  const block = content.slice(4, endIdx);
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, bodyStart: endIdx + 4 };
}

function updateTouchpointInFile(path: string, newDate: string): void {
  try {
    const content = readFileSync(path, "utf-8");
    const replaced = content.replace(
      /^(last_touchpoint:\s*).*$/m,
      `$1${newDate}`,
    );
    if (replaced !== content) {
      writeFileSync(path, replaced, "utf-8");
    }
  } catch {
    // Dossier may be missing last_touchpoint field entirely; skip silently.
  }
}

export async function buildRelationshipKit(options: {
  maxosHome?: string;
  vaultRoot?: string;
  now?: Date;
} = {}): Promise<string> {
  const maxosHome = options.maxosHome ?? process.env.MAXOS_HOME ?? join(homedir(), ".maxos");
  const vaultRoot = options.vaultRoot ?? join(maxosHome, "vault");
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const dossiers = loadDossiers(vaultRoot);

  // Re-read each file to get the full frontmatter (loadDossiers only pulls name/orbit/phone/excerpt).
  const statuses: RelationshipStatus[] = [];
  for (const d of dossiers) {
    let fm: Record<string, string> = {};
    try {
      const { fm: parsed } = parseFrontmatter(readFileSync(d.path, "utf-8"));
      fm = parsed;
    } catch {
      continue;
    }

    const existingTp = (fm.last_touchpoint || "").trim();
    let lastTp = existingTp || undefined;
    let updated = false;

    if (d.phone) {
      const msgDate = await fetchLastMessageDate(d.phone);
      if (msgDate) {
        if (!existingTp || msgDate > existingTp) {
          updateTouchpointInFile(d.path, msgDate);
          lastTp = msgDate;
          updated = true;
        }
      }
    }

    const classification = classifyOverdue(d.orbit, lastTp, today);
    if (classification === "skip") continue;

    const daysOverdue = daysOverdueFor(d.orbit, lastTp, today);
    statuses.push({
      name: d.name,
      orbit: d.orbit,
      phone: d.phone,
      lastTouchpoint: lastTp,
      lastTouchpointUpdated: updated,
      classification,
      daysOverdue,
      path: d.path,
    });
  }

  return formatRelationshipKit(statuses, today);
}
