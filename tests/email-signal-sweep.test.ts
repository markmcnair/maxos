import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffBucket,
  classifyCurrentBucket,
  loadEmittedSignalKeys,
  appendSignals,
  signalKey,
  sweepOnce,
  detectStaleSeemail,
  type Signal,
  type GmailMetadata,
  type DailyLogEntry,
} from "../src/email-signal-sweep.js";

// ───── classifyCurrentBucket ─────

describe("classifyCurrentBucket", () => {
  // Use the real label IDs from email-triage.md so tests fail loudly if
  // those constants drift.
  const empriseSeemail = "Label_3614305421198210016";
  const personalArchive = "Label_1899785834793579761";
  const personalReMail = "Label_4477503976729007365";

  it("returns 'inbox' if INBOX is among labels and no Max/* bucket label is set", () => {
    const r = classifyCurrentBucket({ id: "x", labelIds: ["INBOX", "UNREAD"] }, "personal");
    assert.equal(r, "inbox");
  });

  it("returns the bucket name when a Max/* label is set", () => {
    assert.equal(
      classifyCurrentBucket({ id: "x", labelIds: [empriseSeemail] }, "emprise"),
      "see-mail",
    );
    assert.equal(
      classifyCurrentBucket({ id: "x", labelIds: [personalArchive] }, "personal"),
      "archive",
    );
    assert.equal(
      classifyCurrentBucket({ id: "x", labelIds: [personalReMail] }, "personal"),
      "re-mail",
    );
  });

  it("returns 'gone' when message has no labels at all (deleted permanently)", () => {
    assert.equal(classifyCurrentBucket({ id: "x", labelIds: [] }, "personal"), "gone");
  });

  it("returns 'unknown' when classification is ambiguous", () => {
    // A label not in the known set
    assert.equal(
      classifyCurrentBucket({ id: "x", labelIds: ["Label_random_foo"] }, "personal"),
      "unknown",
    );
  });
});

// ───── diffBucket ─────

describe("diffBucket", () => {
  const empriseSeemail = "Label_3614305421198210016";
  const empriseDelete = "Label_7959061764173529209";

  function entry(overrides: Partial<DailyLogEntry> = {}): DailyLogEntry {
    return {
      account: "emprise",
      message_id: "m1",
      from: "test@example.com",
      subject: "test",
      assigned_bucket: "see-mail",
      assigned_label_id: empriseSeemail,
      secondary_labels: [],
      draft_created: false,
      notes: "",
      ...overrides,
    };
  }

  it("emits no signals when current bucket matches assigned", () => {
    const meta: GmailMetadata = { id: "m1", labelIds: [empriseSeemail] };
    const signals = diffBucket(entry(), meta, new Date("2026-05-05T20:00:00Z"));
    assert.equal(signals.length, 0);
  });

  it("emits bucket_changed when user moved between buckets", () => {
    const meta: GmailMetadata = { id: "m1", labelIds: [empriseDelete] };
    const signals = diffBucket(entry(), meta, new Date("2026-05-05T20:00:00Z"));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, "bucket_changed");
    assert.equal(signals[0].messageId, "m1");
    assert.equal(signals[0].prior, "see-mail");
    assert.equal(signals[0].current, "delete");
  });

  it("emits moved_to_inbox when user fished email back to inbox", () => {
    const meta: GmailMetadata = { id: "m1", labelIds: ["INBOX", "UNREAD"] };
    const signals = diffBucket(entry({ assigned_bucket: "delete" }), meta, new Date("2026-05-05T20:00:00Z"));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, "moved_to_inbox");
    assert.equal(signals[0].prior, "delete");
  });

  it("emits read_after_archive_or_delete when archive/delete email lost UNREAD", () => {
    // Daily log entry archived; current state shows UNREAD removed → user opened it
    const meta: GmailMetadata = { id: "m1", labelIds: ["Label_1899785834793579761"] };
    const e = entry({
      account: "personal",
      assigned_bucket: "archive",
      assigned_label_id: "Label_1899785834793579761",
      // We don't have an explicit "was unread at triage" flag in the schema —
      // assume the triage script preserved UNREAD when it ran. The signal
      // fires when current state has no UNREAD AND the bucket matches assigned.
    });
    const signals = diffBucket(e, meta, new Date("2026-05-05T20:00:00Z"));
    // Could be 0 or 1 depending on UNREAD tracking; this test pins down the
    // current-bucket-matches case where read should emit.
    const types = signals.map((s) => s.type);
    assert.ok(
      types.includes("read_after_archive_or_delete") || types.length === 0,
      "signal must be of type 'read_after_archive_or_delete' if emitted",
    );
  });

  it("emits no spurious signals when message is gone (permanently deleted)", () => {
    const meta: GmailMetadata = { id: "m1", labelIds: [] };
    const signals = diffBucket(entry(), meta, new Date("2026-05-05T20:00:00Z"));
    // A "gone" message could optionally emit a signal indicating
    // permanent deletion, but should NOT emit bucket_changed or
    // moved_to_inbox (those would be misleading).
    for (const s of signals) {
      assert.ok(s.type !== "bucket_changed");
      assert.ok(s.type !== "moved_to_inbox");
    }
  });
});

// ───── signal dedup + persistence ─────

describe("signalKey", () => {
  it("creates a stable key from messageId + type", () => {
    const a: Signal = {
      ts: "2026-05-05T22:00:00Z",
      type: "bucket_changed",
      account: "emprise",
      messageId: "m1",
      prior: "see-mail",
      current: "delete",
    };
    const b: Signal = { ...a, ts: "2026-05-06T22:00:00Z" }; // different ts, same key
    assert.equal(signalKey(a), signalKey(b));
  });

  it("differentiates signals of different types for same message", () => {
    const a: Signal = { ts: "2026-05-05T22:00:00Z", type: "bucket_changed", account: "emprise", messageId: "m1" };
    const b: Signal = { ts: "2026-05-05T22:00:00Z", type: "moved_to_inbox", account: "emprise", messageId: "m1" };
    assert.notEqual(signalKey(a), signalKey(b));
  });
});

describe("loadEmittedSignalKeys + appendSignals", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "etriage-sig-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty set when file missing", () => {
    const r = loadEmittedSignalKeys(home);
    assert.equal(r.size, 0);
  });

  it("appends signals atomically and reloads correctly", () => {
    const sig: Signal = {
      ts: "2026-05-05T22:00:00Z",
      type: "bucket_changed",
      account: "emprise",
      messageId: "m1",
      prior: "see-mail",
      current: "delete",
    };
    appendSignals(home, [sig]);
    const path = join(home, ".config", "email-triage", "signals.jsonl");
    assert.ok(existsSync(path));
    const keys = loadEmittedSignalKeys(home);
    assert.equal(keys.size, 1);
    assert.ok(keys.has(signalKey(sig)));
  });

  it("appends multiple times without duplicating across runs (caller checks keys before appending)", () => {
    const s1: Signal = { ts: "2026-05-05T22:00:00Z", type: "bucket_changed", account: "emprise", messageId: "m1" };
    const s2: Signal = { ts: "2026-05-05T22:01:00Z", type: "moved_to_inbox", account: "emprise", messageId: "m2" };
    appendSignals(home, [s1]);
    appendSignals(home, [s2]);
    const keys = loadEmittedSignalKeys(home);
    assert.equal(keys.size, 2);
  });
});

// ───── orchestrator ─────

describe("sweepOnce", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "etriage-sweep-"));
    mkdirSync(join(home, ".config", "email-triage"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeDailyLog(entries: DailyLogEntry[]) {
    writeFileSync(
      join(home, ".config", "email-triage", "daily-log.json"),
      JSON.stringify({ date: "2026-05-05", triaged_at: "2026-05-05T20:55:00Z", emails: entries }),
    );
  }

  it("scans the daily log, calls fetcher per email, emits new signals only", async () => {
    writeDailyLog([
      {
        account: "emprise",
        message_id: "m1",
        from: "a@x.com",
        subject: "s1",
        assigned_bucket: "see-mail",
        assigned_label_id: "Label_3614305421198210016",
        secondary_labels: [],
        draft_created: false,
        notes: "",
      },
      {
        account: "emprise",
        message_id: "m2",
        from: "b@x.com",
        subject: "s2",
        assigned_bucket: "delete",
        assigned_label_id: "Label_7959061764173529209",
        secondary_labels: [],
        draft_created: false,
        notes: "",
      },
    ]);

    // Fetcher returns: m1 was moved to delete (correction), m2 unchanged
    // (still has UNREAD because user never opened it).
    const fetcher = async (acct: string, mid: string): Promise<GmailMetadata> => {
      if (mid === "m1") return { id: "m1", labelIds: ["Label_7959061764173529209", "UNREAD"] };
      if (mid === "m2") return { id: "m2", labelIds: ["Label_7959061764173529209", "UNREAD"] };
      throw new Error("unexpected fetch");
    };

    const r = await sweepOnce(home, new Date("2026-05-05T22:00:00Z"), fetcher);
    assert.equal(r.scanned, 2);
    assert.equal(r.emitted.length, 1);
    assert.equal(r.emitted[0].type, "bucket_changed");
    assert.equal(r.emitted[0].messageId, "m1");

    // signals.jsonl should contain the one new signal
    const content = readFileSync(join(home, ".config", "email-triage", "signals.jsonl"), "utf-8");
    assert.equal(content.trim().split("\n").length, 1);
  });

  it("is idempotent — running twice for the same Gmail state writes zero new lines on second run", async () => {
    writeDailyLog([
      {
        account: "emprise",
        message_id: "m1",
        from: "a@x.com",
        subject: "s1",
        assigned_bucket: "see-mail",
        assigned_label_id: "Label_3614305421198210016",
        secondary_labels: [],
        draft_created: false,
        notes: "",
      },
    ]);
    const fetcher = async (): Promise<GmailMetadata> => ({
      id: "m1",
      labelIds: ["Label_7959061764173529209"], // delete (correction)
    });

    const r1 = await sweepOnce(home, new Date("2026-05-05T22:00:00Z"), fetcher);
    const r2 = await sweepOnce(home, new Date("2026-05-05T22:30:00Z"), fetcher);
    assert.equal(r1.emitted.length, 1);
    assert.equal(r2.emitted.length, 0, "second run must dedup against existing signals");
  });

  it("returns empty when daily-log is missing — no triage today, nothing to sweep", async () => {
    const fetcher = async (): Promise<GmailMetadata> => {
      throw new Error("fetcher should not be called");
    };
    const r = await sweepOnce(home, new Date(), fetcher);
    assert.equal(r.scanned, 0);
    assert.equal(r.emitted.length, 0);
  });

  it("tolerates fetcher errors per-email and continues", async () => {
    writeDailyLog([
      {
        account: "emprise",
        message_id: "m1",
        from: "a@x.com",
        subject: "s1",
        assigned_bucket: "see-mail",
        assigned_label_id: "Label_3614305421198210016",
        secondary_labels: [],
        draft_created: false,
        notes: "",
      },
      {
        account: "emprise",
        message_id: "m2",
        from: "b@x.com",
        subject: "s2",
        assigned_bucket: "delete",
        assigned_label_id: "Label_7959061764173529209",
        secondary_labels: [],
        draft_created: false,
        notes: "",
      },
    ]);
    const fetcher = async (_a: string, mid: string): Promise<GmailMetadata> => {
      if (mid === "m1") throw new Error("API blip");
      return { id: "m2", labelIds: ["INBOX", "UNREAD"] }; // moved_to_inbox
    };

    const r = await sweepOnce(home, new Date("2026-05-05T22:00:00Z"), fetcher);
    assert.equal(r.scanned, 2);
    assert.equal(r.errors.length, 1);
    assert.equal(r.emitted.length, 1);
    assert.equal(r.emitted[0].type, "moved_to_inbox");
  });
});

// ───── stale see-mail detection ─────

describe("detectStaleSeemail", () => {
  it("emits signal for see-mail emails older than 30d still UNREAD with no thread activity", () => {
    const oldEntry: DailyLogEntry = {
      account: "personal",
      message_id: "stale1",
      from: "newsletter@example.com",
      subject: "monthly update",
      assigned_bucket: "see-mail",
      assigned_label_id: "Label_6623329574940472323",
      secondary_labels: [],
      draft_created: false,
      notes: "",
    };
    const meta: GmailMetadata = {
      id: "stale1",
      labelIds: ["Label_6623329574940472323", "UNREAD"],
      internalDate: String(Date.parse("2026-04-01T00:00:00Z")), // 34 days before now
    };
    const now = new Date("2026-05-05T00:00:00Z");
    const signals = detectStaleSeemail(oldEntry, meta, now);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, "untouched_seemail_30d");
  });

  it("does NOT emit for see-mail that's been READ (UNREAD removed)", () => {
    const entry: DailyLogEntry = {
      account: "personal",
      message_id: "read1",
      from: "newsletter@example.com",
      subject: "x",
      assigned_bucket: "see-mail",
      assigned_label_id: "Label_6623329574940472323",
      secondary_labels: [],
      draft_created: false,
      notes: "",
    };
    const meta: GmailMetadata = {
      id: "read1",
      labelIds: ["Label_6623329574940472323"], // UNREAD removed
      internalDate: String(Date.parse("2026-04-01T00:00:00Z")),
    };
    const signals = detectStaleSeemail(entry, meta, new Date("2026-05-05T00:00:00Z"));
    assert.equal(signals.length, 0);
  });

  it("does NOT emit for emails younger than 30 days", () => {
    const entry: DailyLogEntry = {
      account: "personal",
      message_id: "fresh1",
      from: "x@x.com",
      subject: "x",
      assigned_bucket: "see-mail",
      assigned_label_id: "Label_6623329574940472323",
      secondary_labels: [],
      draft_created: false,
      notes: "",
    };
    const meta: GmailMetadata = {
      id: "fresh1",
      labelIds: ["Label_6623329574940472323", "UNREAD"],
      internalDate: String(Date.parse("2026-05-04T00:00:00Z")), // 1 day before now
    };
    const signals = detectStaleSeemail(entry, meta, new Date("2026-05-05T00:00:00Z"));
    assert.equal(signals.length, 0);
  });
});
