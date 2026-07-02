import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ───── Bucket label IDs (from email-triage.md, must stay in sync) ─────

/**
 * Label-ID → bucket-name mapping per Gmail account. Mirrors
 * tasks/email-triage.md. Centralized here so tests fail loudly when
 * either side drifts (a real failure mode for this kind of constant).
 */
const BUCKET_LABELS: Record<"emprise" | "personal", Record<string, BucketName>> = {
  emprise: {
    Label_3424936243113089315: "re-mail",
    Label_3614305421198210016: "see-mail",
    Label_3297570852003895454: "archive",
    Label_7959061764173529209: "delete",
  },
  personal: {
    Label_4477503976729007365: "re-mail",
    Label_6623329574940472323: "see-mail",
    Label_1899785834793579761: "archive",
    Label_1204994497706447516: "delete",
  },
};

export type BucketName = "re-mail" | "see-mail" | "archive" | "delete";
export type ClassifiedBucket = BucketName | "inbox" | "gone" | "unknown";
export type Account = "emprise" | "personal";

// ───── Types ─────

export interface DailyLogEntry {
  account: Account;
  message_id: string;
  from: string;
  subject: string;
  assigned_bucket: BucketName;
  assigned_label_id: string;
  secondary_labels?: string[];
  draft_created: boolean;
  notes: string;
  /** Optional rule_id (set when Component 4 lands; older entries lack this) */
  rule_id?: string | null;
}

export interface GmailMetadata {
  id: string;
  labelIds: string[];
  /** Optional Gmail internalDate as ms-since-epoch string */
  internalDate?: string;
  /** Gmail thread id — enables thread-reply detection */
  threadId?: string;
}

export type SignalType =
  | "bucket_changed"
  | "moved_to_inbox"
  | "read_after_archive_or_delete"
  | "untouched_seemail_30d"
  | "trashed_after_bucket"
  | "replied_in_thread";

export interface Signal {
  /** Emission timestamp (ISO 8601) */
  ts: string;
  type: SignalType;
  account: Account;
  messageId: string;
  /** Prior bucket (where Max put it). Present for bucket_changed and moved_to_inbox. */
  prior?: BucketName;
  /** Current bucket inferred from labels. Present for bucket_changed. */
  current?: ClassifiedBucket;
  /** Optional free-text context for forensics */
  details?: string;
}

// ───── Pure helpers ─────

/**
 * Classify the current state of a message based on its labels. Returns:
 *   - bucket name when a Max/* label is present
 *   - "inbox" when INBOX is set and no Max/* label is set (user fished back)
 *   - "gone" when message has no labels at all (permanently deleted / tombstone)
 *   - "unknown" otherwise (label drifted, classification not possible)
 */
export function classifyCurrentBucket(
  meta: GmailMetadata,
  account: Account,
): ClassifiedBucket {
  if (!meta.labelIds || meta.labelIds.length === 0) return "gone";
  const known = BUCKET_LABELS[account];
  for (const id of meta.labelIds) {
    if (id in known) return known[id];
  }
  if (meta.labelIds.includes("INBOX")) return "inbox";
  return "unknown";
}

/**
 * Compare a daily-log assignment against current Gmail state. Emits
 * 0..N signals depending on the diff. Pure — no I/O. Tested heavily
 * because this is the heart of the multi-signal evidence base.
 */
export function diffBucket(
  entry: DailyLogEntry,
  current: GmailMetadata,
  now: Date,
): Signal[] {
  const out: Signal[] = [];
  const ts = now.toISOString();
  const cur = classifyCurrentBucket(current, entry.account);

  // trashed_after_bucket: user trashed an email triage did NOT bucket as
  // delete → strong "this was junk" correction. Checked FIRST because a
  // trashed message often still carries its old bucket label, so a naive
  // classify would read it as "unchanged" and miss the correction.
  // Exclusion: an email triage assigned to "delete" legitimately lives in
  // TRASH (triage moves deletes there), so delete must NOT fire this.
  if (current.labelIds.includes("TRASH") && entry.assigned_bucket !== "delete") {
    out.push({
      ts,
      type: "trashed_after_bucket",
      account: entry.account,
      messageId: entry.message_id,
      prior: entry.assigned_bucket,
      current: "delete",
    });
    return out;
  }

  // gone: don't emit confusing signals
  if (cur === "gone") return out;

  // moved to inbox = strongest "you got this wrong" correction
  if (cur === "inbox") {
    out.push({
      ts,
      type: "moved_to_inbox",
      account: entry.account,
      messageId: entry.message_id,
      prior: entry.assigned_bucket,
      current: "inbox",
    });
    return out;
  }

  // bucket changed
  if (cur !== "unknown" && cur !== entry.assigned_bucket) {
    out.push({
      ts,
      type: "bucket_changed",
      account: entry.account,
      messageId: entry.message_id,
      prior: entry.assigned_bucket,
      current: cur,
    });
    return out;
  }

  // bucket unchanged, but for archive/delete: if UNREAD is gone, user opened it
  // (mild signal that this could've been see-mail).
  if (
    (entry.assigned_bucket === "archive" || entry.assigned_bucket === "delete") &&
    cur === entry.assigned_bucket &&
    !current.labelIds.includes("UNREAD")
  ) {
    out.push({
      ts,
      type: "read_after_archive_or_delete",
      account: entry.account,
      messageId: entry.message_id,
      prior: entry.assigned_bucket,
      current: cur,
    });
  }

  return out;
}

/**
 * Emit untouched_seemail_30d for see-mail emails that are >30 days old
 * AND still UNREAD (user never engaged) AND still in the see-mail bucket.
 * Retroactive "should've been archive" — used by the training task to
 * promote a see-mail rule into an archive rule for that pattern.
 */
export function detectStaleSeemail(
  entry: DailyLogEntry,
  current: GmailMetadata,
  now: Date,
): Signal[] {
  if (entry.assigned_bucket !== "see-mail") return [];
  const cur = classifyCurrentBucket(current, entry.account);
  if (cur !== "see-mail") return []; // already moved
  if (!current.labelIds.includes("UNREAD")) return []; // user opened it
  if (!current.internalDate) return [];
  const ageMs = now.getTime() - Number(current.internalDate);
  if (ageMs < 30 * 86400_000) return [];
  return [
    {
      ts: now.toISOString(),
      type: "untouched_seemail_30d",
      account: entry.account,
      messageId: entry.message_id,
      prior: "see-mail",
      details: `${Math.floor(ageMs / 86400_000)}d old, never opened`,
    },
  ];
}

/**
 * Detect a user-sent reply in the thread of an email triage filed as
 * see-mail / archive / delete. A reply means the email actually needed
 * action → the right bucket was re-mail. Pure — no I/O. The caller is
 * responsible for fetching the thread's SENT internalDates and the
 * triage time.
 *
 * Returns [] when assigned_bucket === "re-mail" (a reply there is
 * expected, not a correction). Otherwise emits one signal if ANY sent
 * reply landed after triage ran.
 */
export function detectThreadReply(
  entry: DailyLogEntry,
  sentReplyEpochMsList: number[],
  triageTimeMs: number,
): Signal[] {
  if (entry.assigned_bucket === "re-mail") return [];
  const repliedAfterTriage = sentReplyEpochMsList.some((ms) => ms > triageTimeMs);
  if (!repliedAfterTriage) return [];
  return [
    {
      // Pure detector: callers override `ts` with the emission time.
      ts: new Date(triageTimeMs).toISOString(),
      type: "replied_in_thread",
      account: entry.account,
      messageId: entry.message_id,
      prior: entry.assigned_bucket,
      current: "re-mail",
      details: "user replied after triage",
    },
  ];
}

// ───── Persistence ─────

/** Stable dedup key — same message + same signal type = same key. */
export function signalKey(s: Signal): string {
  return `${s.account}|${s.messageId}|${s.type}`;
}

function signalsPath(home: string): string {
  return join(home, ".config", "email-triage", "signals.jsonl");
}

/** Load all previously-emitted signal keys for dedup. Returns empty Set when file missing. */
export function loadEmittedSignalKeys(home: string): Set<string> {
  const path = signalsPath(home);
  if (!existsSync(path)) return new Set();
  const out = new Set<string>();
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const sig = JSON.parse(line) as Signal;
        if (sig && sig.account && sig.messageId && sig.type) {
          out.add(signalKey(sig));
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** Append signals to signals.jsonl. Creates the dir + file as needed. */
export function appendSignals(home: string, signals: Signal[]): void {
  if (signals.length === 0) return;
  const path = signalsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const data = signals.map((s) => JSON.stringify(s)).join("\n") + "\n";
  appendFileSync(path, data);
}

// ───── Orchestrator ─────

export interface SweepResult {
  scanned: number;
  emitted: Signal[];
  errors: { messageId: string; error: string }[];
}

/** Fetches the labels + internalDate + threadId for one message. */
export type MetadataFetcher = (account: Account, messageId: string) => Promise<GmailMetadata>;

/**
 * Fetches the SENT-message internalDates (epoch ms) for one thread.
 * Returns one number per SENT message in the thread. Injected so tests
 * can supply a fake.
 */
export type ThreadReplyFetcher = (account: Account, threadId: string) => Promise<number[]>;

const THREAD_REPLY_BUCKETS: ReadonlySet<BucketName> = new Set<BucketName>([
  "see-mail",
  "archive",
  "delete",
]);

/**
 * Run one sweep pass. Reads daily-log, fetches current state per email
 * via the injected `fetcher`, computes signals, dedups against previous
 * emissions, appends new signals atomically.
 *
 * Idempotent: running twice with the same Gmail state writes zero new
 * lines on the second run. The dedup key is `(account, messageId, type)`.
 *
 * Tolerant of per-email fetch errors — logs them in the result without
 * aborting the sweep.
 *
 * The optional `threadFetcher` enables replied_in_thread detection. It's
 * only invoked for entries bucketed see-mail/archive/delete that were NOT
 * already flagged by a trash or bucket-change correction, to limit API
 * calls.
 */
export async function sweepOnce(
  home: string,
  now: Date,
  fetcher: MetadataFetcher,
  threadFetcher?: ThreadReplyFetcher,
): Promise<SweepResult> {
  const dailyLogPath = join(home, ".config", "email-triage", "daily-log.json");
  if (!existsSync(dailyLogPath)) {
    return { scanned: 0, emitted: [], errors: [] };
  }
  let log: { emails?: DailyLogEntry[]; triaged_at?: string };
  try {
    log = JSON.parse(readFileSync(dailyLogPath, "utf-8"));
  } catch {
    return { scanned: 0, emitted: [], errors: [{ messageId: "(parse)", error: "daily-log.json malformed" }] };
  }
  const entries = log.emails ?? [];
  const triageTimeMs = log.triaged_at ? Date.parse(log.triaged_at) : NaN;
  const emittedKeys = loadEmittedSignalKeys(home);

  const newSignals: Signal[] = [];
  const errors: SweepResult["errors"] = [];

  for (const entry of entries) {
    let meta: GmailMetadata;
    try {
      meta = await fetcher(entry.account, entry.message_id);
    } catch (err) {
      errors.push({
        messageId: entry.message_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const candidates = [
      ...diffBucket(entry, meta, now),
      ...detectStaleSeemail(entry, meta, now),
    ];

    // replied_in_thread: gated behind a thread fetcher + the right bucket +
    // not-already-flagged, to avoid an extra API call per message.
    const alreadyFlagged = candidates.some(
      (c) =>
        c.type === "trashed_after_bucket" ||
        c.type === "bucket_changed" ||
        c.type === "moved_to_inbox",
    );
    if (
      threadFetcher &&
      !alreadyFlagged &&
      !Number.isNaN(triageTimeMs) &&
      meta.threadId &&
      THREAD_REPLY_BUCKETS.has(entry.assigned_bucket)
    ) {
      try {
        const sentTimes = await threadFetcher(entry.account, meta.threadId);
        const sig = detectThreadReply(entry, sentTimes, triageTimeMs);
        for (const s of sig) candidates.push({ ...s, ts: now.toISOString() });
      } catch (err) {
        errors.push({
          messageId: entry.message_id,
          error: `thread: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    for (const sig of candidates) {
      const k = signalKey(sig);
      if (emittedKeys.has(k)) continue;
      emittedKeys.add(k); // prevent dup-within-same-sweep
      newSignals.push(sig);
    }
  }

  appendSignals(home, newSignals);

  return { scanned: entries.length, emitted: newSignals, errors };
}

// ───── Default fetchers (real Gmail via gws CLI) ─────

function wrapperFor(account: Account): string {
  return account === "emprise" ? "gws-emprise" : "gws-personal";
}

/**
 * Fetcher implementation that calls the gws CLI for the given account.
 * Returns labelIds + internalDate + threadId. Used by the CLI entry
 * point; tests inject their own fetcher.
 */
export async function gwsFetcher(account: Account, messageId: string): Promise<GmailMetadata> {
  const wrapper = wrapperFor(account);
  const params = JSON.stringify({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject"],
  });
  const { stdout } = await execFileAsync(
    wrapper,
    ["gmail", "users", "messages", "get", "--params", params, "--format", "json"],
    { timeout: 8_000 },
  );
  // Strip non-JSON header noise
  const idx = stdout.indexOf("{");
  if (idx < 0) throw new Error("no JSON in gws output");
  const parsed = JSON.parse(stdout.slice(idx));
  return {
    id: parsed.id,
    labelIds: Array.isArray(parsed.labelIds) ? parsed.labelIds : [],
    internalDate: parsed.internalDate,
    threadId: parsed.threadId,
  };
}

/**
 * Thread fetcher implementation that calls the gws CLI. Returns the
 * internalDate (epoch ms) of every SENT message in the thread.
 */
export async function gwsThreadReplyFetcher(account: Account, threadId: string): Promise<number[]> {
  const wrapper = wrapperFor(account);
  const params = JSON.stringify({
    userId: "me",
    id: threadId,
    format: "metadata",
  });
  const { stdout } = await execFileAsync(
    wrapper,
    ["gmail", "users", "threads", "get", "--params", params, "--format", "json"],
    { timeout: 8_000 },
  );
  const idx = stdout.indexOf("{");
  if (idx < 0) throw new Error("no JSON in gws output");
  const parsed = JSON.parse(stdout.slice(idx));
  const messages: unknown = parsed.messages;
  if (!Array.isArray(messages)) return [];
  const out: number[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const labelIds = (m as Record<string, unknown>).labelIds;
    const internalDate = (m as Record<string, unknown>).internalDate;
    if (Array.isArray(labelIds) && labelIds.includes("SENT") && typeof internalDate === "string") {
      const ms = Number(internalDate);
      if (!Number.isNaN(ms)) out.push(ms);
    }
  }
  return out;
}

// ───── CLI entry ─────

const isCLI = process.argv[1]?.endsWith("email-signal-sweep.js");
if (isCLI) {
  const home = process.env.HOME ?? homedir();
  sweepOnce(home, new Date(), gwsFetcher, gwsThreadReplyFetcher).then((r) => {
    if (r.emitted.length > 0 || r.errors.length > 0 || process.env.MAXOS_SIGNAL_VERBOSE) {
      console.log(
        `email-signal-sweep: scanned=${r.scanned} emitted=${r.emitted.length} errors=${r.errors.length}`,
      );
      for (const s of r.emitted) console.log(`  + ${s.type} ${s.account}/${s.messageId}`);
      for (const e of r.errors) console.log(`  ! ${e.messageId}: ${e.error}`);
    }
  }).catch((err) => {
    console.error("email-signal-sweep failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
