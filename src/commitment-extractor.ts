import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Commitment + cancellation extraction from outgoing messages.
 *
 * Round U (2026-05-07) build. Bundles user requests #1 (auto-track
 * commitments Mark makes in sent emails / iMessages so they get surfaced
 * before the deadline) and #4 (cross-check outbound for cancellations
 * so the brief doesn't ask "did you handle Darnell?" when the answer
 * is already in your sent texts).
 *
 * Pure extractors — no I/O. Caller (sweep utility) handles message
 * fetch from gws + imessage-scan, dedup, and persistence.
 *
 * Storage: ~/.maxos/workspace/memory/commitments.jsonl + cancellations.jsonl
 * (both append-only, JSONL, deduped by recordKey).
 */

export type Channel = "email" | "imessage" | "chat";

export interface MessageInput {
  messageId: string;
  sender: string;          // who sent it (phone or email)
  recipient: string;       // who received it
  sentAt: string;          // ISO 8601
  channel: Channel;
  body: string;
  /**
   * True when Mark sent this. Default extractor returns [] for
   * isFromMark === false — only outbound from Mark counts as commitment
   * or cancellation evidence.
   */
  isFromMark?: boolean;
}

export interface CommitmentRecord {
  type: "commitment";
  ts: string;
  messageId: string;
  sender: string;
  recipient: string;
  channel: Channel;
  /** Short summary of what was committed (≤ 200 chars). */
  commitment: string;
  /** Free-text deadline hint as captured ("friday", "next week", "may 15"). */
  deadlineHint: string;
  /** Optional: id of an earlier commitment this one resolves. */
  resolves?: string;
}

export interface CancellationRecord {
  type: "cancellation";
  ts: string;
  messageId: string;
  sender: string;
  recipient: string;
  channel: Channel;
  /** What time/event was cancelled, as captured. */
  timeReference: string;
}

export type Record_ = CommitmentRecord | CancellationRecord;

// ───── Commitment extraction ─────

const VAGUE_BLOCKLIST: RegExp[] = [
  /\bthink about it\b/i,
  /\bsleep on it\b/i,
  /\bsee how (it|that) goes\b/i,
];

// Pattern entries explicitly tag WHICH capture group is the deadline so
// the extractor doesn't have to guess. Group 0 (full match) is always
// the commitment summary.
//
// Rule: only ONE pattern should match a given commitment span — patterns
// are tried in order and a span is consumed once it matches.
const COMMIT_PATTERNS: Array<{
  name: string;
  re: RegExp;
  deadlineGroup: number;
}> = [
  // "give me until Wednesday and I'll send" — group 1 = deadline
  {
    name: "give-me-until",
    re: /\bgive me until\s+(\w+(?:\s+\w+){0,2})\s+and I(?:'ll| will)\s+[^.,!?\n]{1,140}/gi,
    deadlineGroup: 1,
  },
  // "I'll send the keys by Friday" — group 2 = deadline
  {
    name: "ill-verb-by-deadline",
    re: /\bI(?:'ll| will)\s+(send|get|have|share|deliver|email|text|call|provide|draft|finish|finalize|wrap|bring|drop|pass|loop|ping|pull|push|put|set|sign|submit|update|write|return|reply|respond|review|run|ship|loop in|circle back)\b[^.,!?\n]{0,200}\b(?:by|on|before|until)\s+(\w+(?:\s+\w+){0,3}?)(?=[.,!?\n]|$)/gi,
    deadlineGroup: 2,
  },
  // "let me get back to you tomorrow" — group 1 = deadline
  {
    name: "let-me-X",
    re: /\b(?:let me\s+(?:get back|follow up|circle back|check back|reach out|update you|loop back))\b[^.,!?\n]{0,80}?\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|this weekend|by \w+)\b/gi,
    deadlineGroup: 1,
  },
  // "I'll follow up on the contract next week" — group 1 = deadline
  {
    name: "ill-followup",
    re: /\bI(?:'ll| will)\s+(?:follow up|circle back|loop back|check back|reach out)\b[^.,!?\n]{0,200}\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week)\b/gi,
    deadlineGroup: 1,
  },
  // "I'm drafting X tonight" — group 1 = deadline
  {
    name: "drafting",
    re: /\bI(?:'m| am)?\s+drafting\b[^.,!?\n]{0,200}\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|by \w+|this week|next week)\b/gi,
    deadlineGroup: 1,
  },
  // "going to send X tomorrow" — group 1 = deadline
  {
    name: "going-to",
    re: /\b(?:I(?:'m| am)?\s+)?going to\s+(?:send|get|have|share|deliver|email|text|call|finish|draft)\b[^.,!?\n]{0,200}\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week)\b/gi,
    deadlineGroup: 1,
  },
  // "I'll have it for you Friday" — group 1 = deadline (fallback when no by/on/before)
  {
    name: "ill-verb-day",
    re: /\bI(?:'ll| will)\s+(?:send|get|have|share|deliver|email|text|call|provide)\b[^.,!?\n]{0,200}\s+(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|this weekend)\b/gi,
    deadlineGroup: 1,
  },
];

function clipSummary(text: string, maxLen = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

export function extractCommitments(msg: MessageInput): CommitmentRecord[] {
  if (msg.isFromMark === false) return [];
  const body = msg.body;
  if (!body) return [];

  // Skip the whole message if it contains a vague-blocklist phrase that
  // makes the rest of the commitment language meaningless ("I'll think
  // about it" should NOT count even if it has an "I'll" prefix).
  for (const re of VAGUE_BLOCKLIST) {
    if (re.test(body)) return [];
  }

  const out: CommitmentRecord[] = [];
  // Track consumed character spans so subsequent patterns don't re-emit
  // the same commitment under a different label
  const consumed: Array<{ start: number; end: number }> = [];
  const overlapsConsumed = (start: number, end: number): boolean => {
    for (const c of consumed) {
      if (start < c.end && end > c.start) return true;
    }
    return false;
  };

  for (const { re, deadlineGroup } of COMMIT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsConsumed(start, end)) continue;

      const deadlineHint = (m[deadlineGroup] || "").toLowerCase().trim();
      if (!deadlineHint) continue;

      const summary = clipSummary(m[0]);
      consumed.push({ start, end });
      out.push({
        type: "commitment",
        ts: msg.sentAt,
        messageId: msg.messageId,
        sender: msg.sender,
        recipient: msg.recipient,
        channel: msg.channel,
        commitment: summary,
        deadlineHint,
      });
    }
  }
  return out;
}

// ───── Cancellation extraction ─────

// Two-tier cancellation patterns: time-ref-required first (extract specific
// time), then time-ref-optional fallback. Same pattern matches one tier or
// the other — never both.
const CANCEL_PATTERNS: Array<{
  name: string;
  re: RegExp;
  /** Capture group index for the time reference, or 0 to use whole match */
  timeRefGroup: number;
}> = [
  // Tier 1 — specific time ref
  {
    name: "cant-make-it-time",
    re: /\bcan'?t\s+make\s+it\s+(tonight|tomorrow(?:\s+(?:morning|afternoon|night))?|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)\b/i,
    timeRefGroup: 1,
  },
  {
    name: "have-to-cancel-time",
    re: /\bhave to cancel\b[^.,!?\n]{0,40}?\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|tonight|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)\b/i,
    timeRefGroup: 1,
  },
  {
    name: "have-to-cancel-our",
    re: /\bhave to cancel\b\s+(?:our|the)\s+([^.,!?\n]{1,40})/i,
    timeRefGroup: 1,
  },
  {
    name: "wont-be",
    re: /\bwon'?t be (?:there|able)\b[^.,!?\n]{0,40}?\b(today|tonight|tomorrow(?:\s+(?:morning|afternoon|night))?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)\b/i,
    timeRefGroup: 1,
  },
  {
    name: "need-reschedule",
    re: /\bneed to reschedule\b\s+([^.,!?\n]{1,80})/i,
    timeRefGroup: 1,
  },
  {
    name: "moved-X-to-Y",
    re: /\bmoved (?:the |our )?([^.,!?\n]{1,40})\s+to\s+(?:[^.,!?\n]{1,40})/i,
    timeRefGroup: 1,
  },
  {
    name: "rescheduling-X-to-Y",
    re: /\brescheduling\s+([^.,!?\n]{1,40})\s+to\s+(?:[^.,!?\n]{1,40})/i,
    timeRefGroup: 1,
  },
  // Tier 2 — fallback "cancellation occurred but no time ref captured"
  {
    name: "cant-make-it-bare",
    re: /\bcan'?t\s+make\s+it\b/i,
    timeRefGroup: 0,
  },
  {
    name: "have-to-cancel-bare",
    re: /\bhave to cancel\b/i,
    timeRefGroup: 0,
  },
];

const CANCEL_FALSE_POSITIVES: RegExp[] = [
  // "I made it" — affirmation, not cancellation
  /\bI\s+made\s+it\b/i,
  /\bmade it (in|on time|fine|okay)\b/i,
];

export function extractCancellations(msg: MessageInput): CancellationRecord[] {
  if (msg.isFromMark === false) return [];
  const body = msg.body;
  if (!body) return [];
  for (const fp of CANCEL_FALSE_POSITIVES) {
    if (fp.test(body)) return [];
  }
  const out: CancellationRecord[] = [];
  const consumed: Array<{ start: number; end: number }> = [];
  const overlapsConsumed = (start: number, end: number): boolean => {
    for (const c of consumed) {
      if (start < c.end && end > c.start) return true;
    }
    return false;
  };

  for (const { re, timeRefGroup } of CANCEL_PATTERNS) {
    const m = re.exec(body);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsConsumed(start, end)) continue;
    const timeRef = (timeRefGroup === 0 ? m[0] : m[timeRefGroup] || m[0]).trim();
    consumed.push({ start, end });
    out.push({
      type: "cancellation",
      ts: msg.sentAt,
      messageId: msg.messageId,
      sender: msg.sender,
      recipient: msg.recipient,
      channel: msg.channel,
      timeReference: timeRef.toLowerCase(),
    });
  }
  return out;
}

// ───── Storage ─────

export function recordKey(r: Record_): string {
  return `${r.type}|${r.messageId}|${r.recipient}`;
}

function commitmentsPath(home: string): string {
  return join(home, "workspace", "memory", "commitments.jsonl");
}

function cancellationsPath(home: string): string {
  return join(home, "workspace", "memory", "cancellations.jsonl");
}

function readJsonlSafely(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    const out: unknown[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* skip malformed line */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function loadEmittedKeys(home: string): Set<string> {
  const out = new Set<string>();
  for (const path of [commitmentsPath(home), cancellationsPath(home)]) {
    for (const item of readJsonlSafely(path)) {
      const r = item as Record_;
      if (r && r.type && r.messageId && r.recipient) {
        out.add(recordKey(r));
      }
    }
  }
  return out;
}

export function appendRecords(home: string, records: Record_[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(commitmentsPath(home)), { recursive: true });
  const commits: CommitmentRecord[] = [];
  const cancels: CancellationRecord[] = [];
  for (const r of records) {
    if (r.type === "commitment") commits.push(r);
    else cancels.push(r);
  }
  if (commits.length > 0) {
    appendFileSync(commitmentsPath(home), commits.map((c) => JSON.stringify(c)).join("\n") + "\n");
  }
  if (cancels.length > 0) {
    appendFileSync(cancellationsPath(home), cancels.map((c) => JSON.stringify(c)).join("\n") + "\n");
  }
}

/**
 * Load commitments not yet resolved. A commitment is "resolved" when:
 *   - A later record explicitly references it via `resolves: <messageId>`
 *   - (Future) a cancellation/fulfillment to the same recipient covers it
 *
 * Pure-ish — reads disk, no other side effects. The brief/debrief uses
 * this to surface approaching deadlines without re-asking about already-
 * fulfilled commitments.
 */
export function loadActiveCommitments(home: string): CommitmentRecord[] {
  const all: CommitmentRecord[] = [];
  for (const item of readJsonlSafely(commitmentsPath(home))) {
    const r = item as CommitmentRecord;
    if (r && r.type === "commitment") all.push(r);
  }
  const resolvedIds = new Set<string>();
  for (const c of all) {
    if (c.resolves) resolvedIds.add(c.resolves);
  }
  // Active = not resolved by any other record AND not itself a fulfillment
  return all.filter((c) => !resolvedIds.has(c.messageId) && !c.resolves);
}

