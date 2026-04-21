import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadDossiers, type Dossier } from "./calendar-brief.js";
import { loadOpenLoops, saveOpenLoops } from "./loop-reconciler.js";

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
  } catch {
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
} = {}): Promise<{ written: number }> {
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

  return { written: lines.length };
}

// CLI entry point — `node dist/src/closure-watcher.js [--hours N]`
const isCLI = process.argv[1]?.endsWith("closure-watcher.js");
if (isCLI) {
  const hoursArg = process.argv.indexOf("--hours");
  const hours = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) : 0.25;
  runClosureWatcher({ hours }).then((r) => {
    if (process.env.MAXOS_CLOSURE_VERBOSE) {
      console.log(`closure-watcher: wrote ${r.written} entries`);
    }
  }).catch((err) => {
    console.error("closure-watcher failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
