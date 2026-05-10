import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OpenLoop {
  id: string;
  topic: string;
  /** Optional person name (for display). */
  person?: string;
  /** Phone number for iMessage scan (E.164 preferred). */
  phone?: string;
  /** Email address for gws sent-message scan. */
  email?: string;
  /** ISO date when the loop was first raised. */
  firstSeen: string;
  /** ISO date of the most recent update — scans look for messages newer than this. */
  lastUpdated: string;
  /** Optional free-text notes. */
  notes?: string;
}

export type EvidenceClassification =
  | { kind: "resolved" }
  | { kind: "still-open" }
  | { kind: "cannot-verify" };

export interface LoopWithEvidence {
  loop: OpenLoop;
  evidence: string;
}

export interface LoopUnresolved {
  loop: OpenLoop;
  reason: string;
}

export interface ReconciliationResult {
  resolved: LoopWithEvidence[];
  stillOpen: LoopUnresolved[];
  cannotVerify: LoopUnresolved[];
}

function isValidLoop(x: unknown): x is OpenLoop {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === "string"
    && typeof o.topic === "string"
    && typeof o.firstSeen === "string"
    && typeof o.lastUpdated === "string";
}

/**
 * Read the open-loops JSON file. Returns an empty array if missing or
 * malformed — never throws. Filters out malformed entries silently.
 */
export function loadOpenLoops(maxosHome: string): OpenLoop[] {
  const path = join(maxosHome, "workspace", "memory", "open-loops.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidLoop);
  } catch {
    return [];
  }
}

/**
 * Persist open loops to JSON. Atomic via temp-file-then-rename so concurrent
 * readers never see a half-written file and concurrent writers' last-write
 * wins atomically (still racy on the load-modify-save sequence — callers
 * that need true serialization should add a lock around the whole sequence).
 *
 * Multiple writers exist: closure-watcher (every 15 min), google-tasks-
 * reconciler (every 15 min, offset 7), gateway startup, and the LLM via
 * debrief tasks (any time). Atomic rename eliminates the "half-written
 * file" failure mode at minimum.
 */
export function saveOpenLoops(maxosHome: string, loops: OpenLoop[]): void {
  const dir = join(maxosHome, "workspace", "memory");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "open-loops.json");
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(loops, null, 2));
    renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup of the temp file if rename failed mid-flight
    try { unlinkSync(tmp); } catch { /* file may not exist */ }
    throw err;
  }
}

/**
 * Deterministic mapping from evidence signals to reconciliation classification.
 * Extracted as a pure function so the core logic is testable without
 * subprocess calls.
 */
export function classifyLoopEvidence(signals: {
  hasIMessageEvidence: boolean;
  hasEmailEvidence: boolean;
  noContactInfo?: boolean;
}): EvidenceClassification {
  if (signals.hasIMessageEvidence || signals.hasEmailEvidence) {
    return { kind: "resolved" };
  }
  if (signals.noContactInfo) {
    return { kind: "cannot-verify" };
  }
  return { kind: "still-open" };
}

async function imessageHasOutgoing(
  phone: string,
  sinceDate: string,
  imessageScan = join(process.env.MAXOS_HOME ?? `${process.env.HOME}/.maxos`, "workspace/tools/imessage-scan"),
): Promise<{ found: boolean; snippet?: string }> {
  try {
    const { stdout } = await execFileAsync(
      imessageScan,
      ["--since", sinceDate, "--contact", phone, "--from-me", "--limit", "1"],
      { timeout: 10_000 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return { found: false };
    return { found: true, snippet: trimmed.split("\n")[0].slice(0, 120) };
  } catch {
    return { found: false };
  }
}

async function gwsHasOutgoing(
  email: string,
  sinceDate: string,
  wrappers: string[] = ["gws-personal", "gws-emprise"],
): Promise<{ found: boolean; snippet?: string }> {
  for (const wrapper of wrappers) {
    try {
      const sinceISO = sinceDate.replace(/-/g, "/");
      const query = `in:sent to:${email} after:${sinceISO}`;
      const params = JSON.stringify({ userId: "me", q: query, maxResults: 1 });
      const { stdout } = await execFileAsync(
        wrapper,
        ["gmail", "users", "messages", "list", "--params", params, "--format", "json"],
        { timeout: 10_000 },
      );
      const parsed = JSON.parse(stdout || "{}");
      if (parsed && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
        return { found: true, snippet: `Sent email to ${email} via ${wrapper}` };
      }
    } catch {
      // try next wrapper
    }
  }
  return { found: false };
}

/**
 * Run deterministic reconciliation on every loop. Returns a structured
 * result — LLM downstream just formats, never re-derives.
 */
export async function reconcileAllLoops(
  maxosHome: string,
): Promise<ReconciliationResult> {
  const loops = loadOpenLoops(maxosHome);
  const resolved: LoopWithEvidence[] = [];
  const stillOpen: LoopUnresolved[] = [];
  const cannotVerify: LoopUnresolved[] = [];

  for (const loop of loops) {
    let imEvidence: { found: boolean; snippet?: string } = { found: false };
    let emailEvidence: { found: boolean; snippet?: string } = { found: false };

    if (loop.phone) {
      imEvidence = await imessageHasOutgoing(loop.phone, `${loop.lastUpdated} 00:00:00`);
    }
    if (!imEvidence.found && loop.email) {
      emailEvidence = await gwsHasOutgoing(loop.email, loop.lastUpdated);
    }

    const classification = classifyLoopEvidence({
      hasIMessageEvidence: imEvidence.found,
      hasEmailEvidence: emailEvidence.found,
      noContactInfo: !loop.phone && !loop.email,
    });

    if (classification.kind === "resolved") {
      resolved.push({
        loop,
        evidence: imEvidence.snippet ?? emailEvidence.snippet ?? "Found outgoing message",
      });
    } else if (classification.kind === "cannot-verify") {
      cannotVerify.push({ loop, reason: "No contact info to scan" });
    } else {
      stillOpen.push({ loop, reason: "No outgoing messages found" });
    }
  }

  return { resolved, stillOpen, cannotVerify };
}

/**
 * Format reconciliation result for LLM injection. Output is structured —
 * resolved loops get an explicit "do not re-raise" flag, cannot-verify
 * loops get an explicit "ASK user, do not assume" flag.
 */
export function formatLoopReconciliation(result: ReconciliationResult): string {
  const { resolved, stillOpen, cannotVerify } = result;
  const total = resolved.length + stillOpen.length + cannotVerify.length;

  const lines: string[] = [];
  lines.push("## Loop Reconciliation (deterministic — do NOT re-derive)");
  lines.push("");
  lines.push("**Rules (NON-NEGOTIABLE):**");
  lines.push("- Resolved loops below were closed via evidence in messaging history. DO NOT re-raise resolved loops.");
  lines.push("- Cannot-verify loops have no contact info to scan. ASK the user — do not assume they're still open.");
  lines.push("- Still-open loops had no outgoing-message evidence; carry them forward.");
  lines.push("");

  if (total === 0) {
    lines.push("_No open loops tracked in open-loops.json._");
    return lines.join("\n");
  }

  if (resolved.length > 0) {
    lines.push(`### ✅ Resolved (${resolved.length}) — DO NOT re-raise`);
    for (const r of resolved) {
      const label = r.loop.person ? `${r.loop.person} — ${r.loop.topic}` : r.loop.topic;
      lines.push(`- **${label}** → ${r.evidence}`);
    }
    lines.push("");
  }

  if (stillOpen.length > 0) {
    lines.push(`### 🔄 Still Open (${stillOpen.length})`);
    for (const r of stillOpen) {
      const label = r.loop.person ? `${r.loop.person} — ${r.loop.topic}` : r.loop.topic;
      const age = daysBetween(r.loop.firstSeen);
      lines.push(`- **${label}** (${age}d old) — ${r.reason}`);
    }
    lines.push("");
  }

  if (cannotVerify.length > 0) {
    lines.push(`### ❓ Cannot Verify (${cannotVerify.length}) — ASK the user`);
    for (const r of cannotVerify) {
      lines.push(`- **${r.loop.topic}** — ${r.reason}. Ask: "Did you close this?" rather than assuming.`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function daysBetween(iso: string): number {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    return Math.max(0, Math.floor((now - then) / (24 * 60 * 60 * 1000)));
  } catch {
    return 0;
  }
}
