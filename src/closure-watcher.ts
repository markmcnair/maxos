import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadDossiers, type Dossier } from "./calendar-brief.js";
import { loadOpenLoops, saveOpenLoops } from "./loop-reconciler.js";
import {
  applyDropDecisionsToLoops,
  applyNewLoopFactsFromClosures,
} from "./closures-to-loops.js";
import {
  loadDroppedTopics,
  loadDroppedLoopIds,
  pruneOpenLoopsAgainstDropped,
} from "./dropped-loops-filter.js";

const execFileAsync = promisify(execFile);

export interface OutgoingMessage {
  timestamp: string;  // "YYYY-MM-DD HH:MM:SS"
  recipient: string;  // phone or email from chat.db handle
  text: string;
}

export interface ClosureMatch {
  message: OutgoingMessage;
  dossier: Dossier;
}

// ───── Pure helpers (testable without subprocess) ────────────────────────

/**
 * Reduce a phone to digits only. For matching purposes we use the last 10
 * digits as the canonical key (handles "+1" prefix variations, spaces,
 * dashes, parens, dots).
 */
export function normalizePhone(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.includes("@")) return "";  // email, not a phone
  return raw.replace(/\D/g, "");
}

function canonicalKey(phone: string): string {
  const digits = normalizePhone(phone);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Build a map from canonical phone (last 10 digits) → dossier, so lookups
 * are O(1) regardless of input formatting.
 */
export function buildDossierPhoneIndex(dossiers: Dossier[]): Map<string, Dossier> {
  const idx = new Map<string, Dossier>();
  for (const d of dossiers) {
    const key = canonicalKey(d.phone || "");
    if (key.length === 10) idx.set(key, d);
  }
  return idx;
}

export function matchDossierByPhone(phone: string, index: Map<string, Dossier>): Dossier | null {
  if (!phone) return null;
  const key = canonicalKey(phone);
  if (key.length !== 10) return null;
  return index.get(key) ?? null;
}

/**
 * Parse a single line emitted by `imessage-scan --outgoing-dms`.
 * Format: `timestamp|recipient|text` where text may contain pipes.
 */
export function parseOutgoingDmLine(line: string): OutgoingMessage | null {
  if (!line) return null;
  const firstPipe = line.indexOf("|");
  if (firstPipe < 0) return null;
  const secondPipe = line.indexOf("|", firstPipe + 1);
  if (secondPipe < 0) return null;
  const timestamp = line.slice(0, firstPipe);
  const recipient = line.slice(firstPipe + 1, secondPipe);
  const text = line.slice(secondPipe + 1);
  if (!timestamp || !recipient) return null;
  return { timestamp, recipient, text };
}

const REACTION_PREFIXES = [
  "Liked ", "Disliked ", "Loved ", "Laughed at ",
  "Emphasized ", "Questioned ", "Removed a ",
];

/**
 * Tapback reactions ("Liked X", "Loved Y", etc.) aren't meaningful
 * closures — they're status signals, not substantive replies.
 * Filter them out.
 */
export function isReactionText(text: string): boolean {
  if (!text) return false;
  return REACTION_PREFIXES.some((p) => text.startsWith(p));
}

/** Format a match into the append-only closures log line. */
export function formatClosureLine(match: ClosureMatch): string {
  const hhmm = match.message.timestamp.slice(11, 16);  // "13:03" from "2026-04-21 13:03:22"
  const raw = match.message.text.replace(/\s+/g, " ").trim();
  const truncated = raw.length > 100 ? raw.slice(0, 99) + "…" : raw;
  return `- [${hhmm}] [CLOSURE] texted ${match.dossier.name} — ${truncated}`;
}

/** Filter out lines that already exist (trimmed) in the existing log content. */
export function filterNewEntries(entries: string[], existingLog: string): string[] {
  const existing = new Set(
    existingLog.split("\n").map((l) => l.trim()).filter(Boolean),
  );
  return entries.filter((e) => !existing.has(e.trim()));
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function closuresPath(maxosHome: string, date: Date): string {
  return join(maxosHome, "workspace", "memory", `closures-${ymdLocal(date)}.md`);
}

/**
 * Append closure entries to today's file, deduplicated against anything
 * already present. Creates the file (and parent dir) if missing.
 */
export function appendClosures(maxosHome: string, date: Date, entries: string[]): void {
  if (entries.length === 0) return;
  const path = closuresPath(maxosHome, date);
  mkdirSync(join(maxosHome, "workspace", "memory"), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const fresh = filterNewEntries(entries, existing);
  if (fresh.length === 0) return;
  const prefix = existing.endsWith("\n") || existing === "" ? "" : "\n";
  appendFileSync(path, prefix + fresh.join("\n") + "\n");
}

// ───── Subprocess + orchestration ────────────────────────────────────────

async function fetchOutgoingDms(
  hours: number,
  imessageScan: string,
): Promise<OutgoingMessage[]> {
  try {
    const { stdout } = await execFileAsync(
      imessageScan,
      ["--outgoing-dms", "--hours", String(hours), "--limit", "500"],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const messages: OutgoingMessage[] = [];
    for (const line of stdout.split("\n")) {
      const msg = parseOutgoingDmLine(line);
      if (msg) messages.push(msg);
    }
    return messages;
  } catch (err) {
    // Audit P1-2: differentiate "no closures because nothing texted" from
    // "no closures because the scanner crashed" — the latter is a health
    // signal worth surfacing in stderr → daemon.stderr.log → digest.
    process.stderr.write(
      `closure-watcher: imessage-scan failed (${imessageScan}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

function touchOpenLoops(maxosHome: string, closedPhones: Set<string>): void {
  if (closedPhones.size === 0) return;
  const loops = loadOpenLoops(maxosHome);
  let changed = false;
  const today = ymdLocal(new Date());
  for (const loop of loops) {
    const loopKey = canonicalKey(loop.phone || "");
    if (loopKey && closedPhones.has(loopKey) && loop.lastUpdated !== today) {
      loop.lastUpdated = today;
      changed = true;
    }
  }
  if (changed) saveOpenLoops(maxosHome, loops);
}

export async function runClosureWatcher(options: {
  maxosHome?: string;
  vaultRoot?: string;
  hours?: number;
  imessageScan?: string;
  now?: Date;
} = {}): Promise<{
  written: number;
  dropped: string[];
  addedFromFacts: string[];
  blockedFromFacts: string[];
}> {
  const maxosHome = options.maxosHome ?? process.env.MAXOS_HOME ?? join(homedir(), ".maxos");
  const vaultRoot = options.vaultRoot ?? join(maxosHome, "vault");
  const hours = options.hours ?? 0.25;
  const imessageScan = options.imessageScan
    ?? join(maxosHome, "workspace", "tools", "imessage-scan");
  const now = options.now ?? new Date();

  const dossiers = loadDossiers(vaultRoot);
  const phoneIndex = buildDossierPhoneIndex(dossiers);

  const messages = await fetchOutgoingDms(hours, imessageScan);
  const matches: ClosureMatch[] = [];
  const closedPhones = new Set<string>();
  for (const msg of messages) {
    if (isReactionText(msg.text)) continue;
    const dossier = matchDossierByPhone(msg.recipient, phoneIndex);
    if (!dossier) continue;
    matches.push({ message: msg, dossier });
    const key = canonicalKey(msg.recipient);
    if (key.length === 10) closedPhones.add(key);
  }

  const lines = matches.map(formatClosureLine);
  appendClosures(maxosHome, now, lines);
  touchOpenLoops(maxosHome, closedPhones);

  // Process [DECISION] entries that drop loops permanently. The chat session
  // writes these per SOUL.md when Mark says "drop X" / "kill that thread" /
  // "X is over". This step removes matching open-loops.json entries so the
  // next brief never re-raises them. Runs every 15 minutes via the watcher.
  const dropped = applyDropDecisionsToLoops(maxosHome, now);

  // P0-1 (Round O+): pick up [FACT] new-loop lines emitted by the LLM-
  // driven shutdown-debrief. The LLM no longer edits open-loops.json
  // directly (race with the watchers/reconciler — see audit P0-1); it
  // writes FACT lines and this deterministic pass adds them atomically.
  const factResult = applyNewLoopFactsFromClosures(maxosHome, now);

  // Round O: prune open-loops.json against the persistent dropped-loops.md.
  // The reconciler appends a tombstone there whenever a Google Task is
  // deleted; this pass catches LLM-driven re-adds within 15 minutes — much
  // shorter than the daemon-startup-only prune that used to be the only
  // safety net. closure-watcher already runs every 15 min, so this rides
  // the same cadence rather than adding a new cron.
  const prunedAgainstDropped = pruneAgainstPersistentTombstones(maxosHome);

  return {
    written: lines.length,
    dropped: [...dropped.removed, ...prunedAgainstDropped],
    addedFromFacts: factResult.added,
    blockedFromFacts: factResult.blockedByTombstone,
  };
}

function pruneAgainstPersistentTombstones(maxosHome: string): string[] {
  const droppedTopics = loadDroppedTopics(maxosHome);
  // Audit P0-2: also pull exact loop ids from `(loop:xxx)` markers in
  // dropped-loops.md. Keyword matching alone misses re-adds where the
  // LLM kept the same id but reworded the topic; exact-id match is
  // bullet-proof for those cases.
  const droppedIds = loadDroppedLoopIds(maxosHome);
  if (droppedTopics.length === 0 && droppedIds.length === 0) return [];
  const loops = loadOpenLoops(maxosHome);
  if (loops.length === 0) return [];
  const { remaining, pruned } = pruneOpenLoopsAgainstDropped(
    loops,
    droppedTopics,
    droppedIds,
  );
  if (pruned.length === 0) return [];
  saveOpenLoops(maxosHome, remaining);
  return pruned.map((p) => p.id);
}

// CLI entry point — `node dist/src/closure-watcher.js [--hours N]`
const isCLI = process.argv[1]?.endsWith("closure-watcher.js");
if (isCLI) {
  const hoursArg = process.argv.indexOf("--hours");
  const hours = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) : 0.25;
  runClosureWatcher({ hours }).then((r) => {
    if (process.env.MAXOS_CLOSURE_VERBOSE) {
      console.log(
        `closure-watcher: wrote ${r.written} entries, dropped ${r.dropped.length} loops, added-from-FACT ${r.addedFromFacts.length}, blocked-by-tombstone ${r.blockedFromFacts.length}`,
      );
    }
    if (r.dropped.length > 0) {
      console.log(`closure-watcher: dropped loops via [DECISION]: ${r.dropped.join(", ")}`);
    }
    if (r.addedFromFacts.length > 0) {
      console.log(`closure-watcher: added loops via [FACT] new-loop: ${r.addedFromFacts.join(", ")}`);
    }
    if (r.blockedFromFacts.length > 0) {
      console.log(`closure-watcher: BLOCKED loops via tombstone: ${r.blockedFromFacts.join(", ")}`);
    }
  }).catch((err) => {
    console.error("closure-watcher failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
