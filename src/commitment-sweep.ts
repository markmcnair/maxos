import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  appendRecords,
  extractCancellations,
  extractCommitments,
  loadEmittedKeys,
  recordKey,
  type Channel,
  type MessageInput,
  type Record_,
} from "./commitment-extractor.js";

const execFileAsync = promisify(execFile);

/**
 * Sweep utility — pulls Mark's outbound messages from the last N hours
 * (sent emails + outgoing iMessages), runs them through the commitment +
 * cancellation extractors, dedups against existing records, appends new
 * findings.
 *
 * Round U (2026-05-07). Runs as a cron every hour during waking hours.
 * The brief/debrief reads commitments.jsonl + cancellations.jsonl to
 * surface approaching deadlines and silently drop calendar conflicts
 * Mark already resolved via outbound message.
 */

const DEFAULT_LOOKBACK_HOURS = 6;

interface SentEmail {
  messageId: string;
  recipient: string;
  sentAt: string;       // ISO 8601
  body: string;
  account: "personal" | "emprise";
}

interface OutgoingIMessage {
  messageId: string;     // synthetic from timestamp+recipient
  recipient: string;     // phone (last 10 digits)
  sentAt: string;
  body: string;
}

// ───── Outbound fetchers (mockable via dependency injection in tests) ─────

async function fetchSentEmails(
  account: "personal" | "emprise",
  hoursBack: number,
): Promise<SentEmail[]> {
  const wrapper = account === "personal" ? "gws-personal" : "gws-emprise";
  const params = JSON.stringify({
    userId: "me",
    q: `in:sent newer_than:${Math.max(1, Math.ceil(hoursBack / 24))}d`,
    maxResults: 50,
  });
  let listOut: string;
  try {
    const r = await execFileAsync(
      wrapper,
      ["gmail", "users", "messages", "list", "--params", params, "--format", "json"],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    listOut = r.stdout;
  } catch {
    return [];
  }
  const idx = listOut.indexOf("{");
  if (idx < 0) return [];
  let parsedList: { messages?: Array<{ id: string }> };
  try {
    parsedList = JSON.parse(listOut.slice(idx));
  } catch {
    return [];
  }
  if (!parsedList.messages) return [];
  const cutoff = Date.now() - hoursBack * 3600_000;
  const out: SentEmail[] = [];
  for (const { id } of parsedList.messages.slice(0, 50)) {
    try {
      const msgParams = JSON.stringify({ userId: "me", id, format: "metadata", metadataHeaders: ["To", "Date", "Subject"] });
      const m = await execFileAsync(
        wrapper,
        ["gmail", "users", "messages", "get", "--params", msgParams, "--format", "json"],
        { timeout: 8_000 },
      );
      const msgIdx = m.stdout.indexOf("{");
      if (msgIdx < 0) continue;
      const parsed = JSON.parse(m.stdout.slice(msgIdx));
      const headers = (parsed.payload?.headers ?? []) as Array<{ name: string; value: string }>;
      const toHeader = headers.find((h) => h.name.toLowerCase() === "to")?.value ?? "";
      const dateHeader = headers.find((h) => h.name.toLowerCase() === "date")?.value;
      const sentAt = dateHeader ? new Date(dateHeader).toISOString() : new Date(parseInt(parsed.internalDate ?? "0")).toISOString();
      if (Date.parse(sentAt) < cutoff) continue;
      // Pull a snippet (Gmail returns first ~200 chars even on metadata format)
      const body = (parsed.snippet || "") as string;
      // Only add if there's a body to scan
      if (body.length < 5) continue;
      out.push({
        messageId: id,
        recipient: toHeader.replace(/.*<([^>]+)>.*/, "$1"),
        sentAt,
        body,
        account,
      });
    } catch {
      // skip
    }
  }
  return out;
}

async function fetchOutgoingIMessages(
  hoursBack: number,
  imessageScan: string,
): Promise<OutgoingIMessage[]> {
  try {
    const { stdout } = await execFileAsync(
      imessageScan,
      ["--outgoing-dms", "--hours", String(hoursBack), "--limit", "200"],
      { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const out: OutgoingIMessage[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const firstPipe = line.indexOf("|");
      if (firstPipe < 0) continue;
      const secondPipe = line.indexOf("|", firstPipe + 1);
      if (secondPipe < 0) continue;
      const ts = line.slice(0, firstPipe);
      const recipient = line.slice(firstPipe + 1, secondPipe);
      const body = line.slice(secondPipe + 1);
      // Convert "YYYY-MM-DD HH:MM:SS" to ISO
      const isoTs = new Date(ts.replace(" ", "T") + "Z").toISOString();
      const messageId = `imsg-${ts}-${recipient.replace(/\D/g, "").slice(-10)}`;
      out.push({ messageId, recipient, sentAt: isoTs, body });
    }
    return out;
  } catch {
    return [];
  }
}

// ───── Sweep orchestrator ─────

export interface SweepResult {
  scanned: number;
  newCommitments: number;
  newCancellations: number;
  errors: string[];
}

export interface SweepDeps {
  fetchSent?: (account: "personal" | "emprise", hours: number) => Promise<SentEmail[]>;
  fetchIMessages?: (hours: number, scanPath: string) => Promise<OutgoingIMessage[]>;
}

export async function sweepOutbound(
  home: string,
  options: {
    hoursBack?: number;
    imessageScan?: string;
    deps?: SweepDeps;
    markEmail?: string;     // for is-from-Mark detection in emails
  } = {},
): Promise<SweepResult> {
  const hoursBack = options.hoursBack ?? DEFAULT_LOOKBACK_HOURS;
  const imessageScan = options.imessageScan
    ?? `${home}/workspace/tools/imessage-scan`;
  const fetchSent = options.deps?.fetchSent ?? fetchSentEmails;
  const fetchIMessages = options.deps?.fetchIMessages ?? fetchOutgoingIMessages;
  const markEmail = options.markEmail ?? "markmcnair2@gmail.com";

  const errors: string[] = [];
  const messages: MessageInput[] = [];

  // Sent emails (both accounts)
  for (const account of ["personal", "emprise"] as const) {
    try {
      const emails = await fetchSent(account, hoursBack);
      for (const e of emails) {
        messages.push({
          messageId: e.messageId,
          sender: markEmail,
          recipient: e.recipient,
          sentAt: e.sentAt,
          channel: "email",
          body: e.body,
          isFromMark: true, // sent folder = from Mark
        });
      }
    } catch (err) {
      errors.push(`fetchSent ${account}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Outgoing iMessages
  try {
    const imsgs = await fetchIMessages(hoursBack, imessageScan);
    for (const m of imsgs) {
      messages.push({
        messageId: m.messageId,
        sender: "Mark",
        recipient: m.recipient,
        sentAt: m.sentAt,
        channel: "imessage",
        body: m.body,
        isFromMark: true, // outgoing-dms = from Mark
      });
    }
  } catch (err) {
    errors.push(`fetchIMessages: ${err instanceof Error ? err.message : String(err)}`);
  }

  const emittedKeys = loadEmittedKeys(home);
  const newRecords: Record_[] = [];
  for (const msg of messages) {
    const commits = extractCommitments(msg);
    const cancels = extractCancellations(msg);
    for (const r of [...commits, ...cancels]) {
      const key = recordKey(r);
      if (emittedKeys.has(key)) continue;
      emittedKeys.add(key);
      newRecords.push(r);
    }
  }
  appendRecords(home, newRecords);

  return {
    scanned: messages.length,
    newCommitments: newRecords.filter((r) => r.type === "commitment").length,
    newCancellations: newRecords.filter((r) => r.type === "cancellation").length,
    errors,
  };
}

// ───── CLI ─────

const isCLI = process.argv[1]?.endsWith("commitment-sweep.js");
if (isCLI) {
  const home = process.env.MAXOS_HOME ?? `${homedir()}/.maxos`;
  sweepOutbound(home, { hoursBack: 6 }).then((r) => {
    if (r.newCommitments + r.newCancellations > 0 || process.env.MAXOS_COMMIT_VERBOSE) {
      console.log(
        `commitment-sweep: scanned=${r.scanned} commits=${r.newCommitments} cancels=${r.newCancellations} errors=${r.errors.length}`,
      );
      for (const e of r.errors) console.log(`  ! ${e}`);
    }
  }).catch((err) => {
    console.error("commitment-sweep failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
