import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCommitments,
  extractCancellations,
  loadEmittedKeys,
  appendRecords,
  recordKey,
  loadActiveCommitments,
  type CommitmentRecord,
  type CancellationRecord,
} from "../src/commitment-extractor.js";

// ───── Pure extraction: commitments ─────

describe("extractCommitments", () => {
  const messageBase = {
    messageId: "m1",
    sender: "+15015551234",
    recipient: "lane@example.com",
    sentAt: "2026-05-07T16:00:00Z",
    channel: "email" as const,
  };

  it("extracts 'I'll send X by Friday'", () => {
    const r = extractCommitments({ ...messageBase, body: "I'll send the keys by Friday." });
    assert.equal(r.length, 1);
    assert.match(r[0].commitment, /send the keys/i);
    assert.equal(r[0].recipient, "lane@example.com");
    assert.equal(r[0].deadlineHint, "friday");
  });

  it("extracts 'let me get back to you'", () => {
    const r = extractCommitments({ ...messageBase, body: "Sounds good, let me get back to you tomorrow." });
    assert.equal(r.length, 1);
    assert.match(r[0].commitment, /get back/i);
    assert.equal(r[0].deadlineHint, "tomorrow");
  });

  it("extracts 'I'll follow up on X next week'", () => {
    const r = extractCommitments({ ...messageBase, body: "I'll follow up on the contract next week." });
    assert.equal(r.length, 1);
    assert.equal(r[0].deadlineHint, "next week");
  });

  it("extracts deadlines with specific dates", () => {
    const r = extractCommitments({ ...messageBase, body: "I'll have it to you by May 15." });
    assert.equal(r.length, 1);
    assert.match(r[0].deadlineHint, /may 15/i);
  });

  it("extracts 'give me until [day]'", () => {
    const r = extractCommitments({ ...messageBase, body: "Give me until Wednesday and I'll send it." });
    assert.equal(r.length, 1);
    assert.equal(r[0].deadlineHint, "wednesday");
  });

  it("returns multiple commitments when message has multiple", () => {
    const r = extractCommitments({
      ...messageBase,
      body: "I'll send the proposal by Tuesday. Then I'll follow up with pricing next week.",
    });
    assert.ok(r.length >= 2);
  });

  it("does NOT extract from incoming message body (different sender heuristic)", () => {
    // Defensive — caller is responsible for filtering OUT non-Mark messages.
    // The extractor extracts whatever it sees; the sweep filters by sender.
    const r = extractCommitments({
      ...messageBase,
      body: "I'll send it tomorrow",
      isFromMark: false,
    });
    assert.equal(r.length, 0, "should not extract when isFromMark is false");
  });

  it("returns empty for messages with no commitment language", () => {
    const r = extractCommitments({ ...messageBase, body: "Sounds good. Talk soon." });
    assert.equal(r.length, 0);
  });

  it("extracts 'going to draft' / 'drafting today'", () => {
    const r = extractCommitments({ ...messageBase, body: "I'm drafting the SOW tonight, will send tomorrow." });
    assert.ok(r.length >= 1);
  });

  it("ignores 'I'll think about it' (vague, no commit)", () => {
    const r = extractCommitments({ ...messageBase, body: "I'll think about it." });
    assert.equal(r.length, 0);
  });

  it("trims commitment to a sane length", () => {
    const r = extractCommitments({
      ...messageBase,
      body: "I'll send you a really really long detailed comprehensive document with all the things you asked about including financials operations and team structure by Friday.",
    });
    assert.ok(r.length === 1);
    assert.ok(r[0].commitment.length <= 200, "commitment summary should be capped");
  });
});

// ───── Pure extraction: cancellations ─────

describe("extractCancellations", () => {
  const messageBase = {
    messageId: "c1",
    sender: "+15015551234",
    recipient: "darnell@example.com",
    sentAt: "2026-05-07T16:00:00Z",
    channel: "imessage" as const,
  };

  it("extracts 'can't make it tonight'", () => {
    const r = extractCancellations({ ...messageBase, body: "Hey, can't make it tonight — see you next week!" });
    assert.equal(r.length, 1);
    assert.equal(r[0].timeReference, "tonight");
  });

  it("extracts 'have to cancel'", () => {
    const r = extractCancellations({ ...messageBase, body: "Have to cancel our 2pm. Sorry!" });
    assert.equal(r.length, 1);
    assert.match(r[0].timeReference, /2pm/i);
  });

  it("extracts 'need to reschedule'", () => {
    const r = extractCancellations({ ...messageBase, body: "Need to reschedule Friday's meeting to next Monday." });
    assert.equal(r.length, 1);
  });

  it("extracts 'won't be there'", () => {
    const r = extractCancellations({ ...messageBase, body: "Won't be there tomorrow morning." });
    assert.equal(r.length, 1);
    assert.match(r[0].timeReference, /tomorrow/i);
  });

  it("does NOT extract 'I made it' (false-positive guard)", () => {
    const r = extractCancellations({ ...messageBase, body: "Yeah I made it, thanks." });
    assert.equal(r.length, 0);
  });

  it("does NOT extract from incoming message", () => {
    const r = extractCancellations({ ...messageBase, body: "Can't make it tonight", isFromMark: false });
    assert.equal(r.length, 0);
  });

  it("returns empty for plain affirmations", () => {
    const r = extractCancellations({ ...messageBase, body: "Sounds good, see you there!" });
    assert.equal(r.length, 0);
  });
});

// ───── Storage: dedup keys + append + load ─────

describe("recordKey + dedup", () => {
  it("creates stable key from messageId + type + (recipient or topic)", () => {
    const a: CommitmentRecord = {
      type: "commitment",
      ts: "2026-05-07T16:00:00Z",
      messageId: "m1",
      sender: "x",
      recipient: "y",
      channel: "email",
      commitment: "send X",
      deadlineHint: "friday",
    };
    const b: CommitmentRecord = { ...a, ts: "2026-05-08T00:00:00Z" }; // different ts, same key
    assert.equal(recordKey(a), recordKey(b));
  });

  it("produces different keys for commitment vs cancellation with same messageId", () => {
    const c: CommitmentRecord = {
      type: "commitment",
      ts: "2026-05-07T16:00:00Z",
      messageId: "m1",
      sender: "x", recipient: "y", channel: "email",
      commitment: "send X", deadlineHint: "friday",
    };
    const x: CancellationRecord = {
      type: "cancellation",
      ts: "2026-05-07T16:00:00Z",
      messageId: "m1",
      sender: "x", recipient: "y", channel: "email",
      timeReference: "tonight",
    };
    assert.notEqual(recordKey(c), recordKey(x));
  });
});

describe("appendRecords + loadEmittedKeys + loadActiveCommitments", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "commit-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates files in workspace/memory and persists", () => {
    const c: CommitmentRecord = {
      type: "commitment",
      ts: "2026-05-07T16:00:00Z",
      messageId: "m1",
      sender: "+1", recipient: "lane@x.com", channel: "email",
      commitment: "send keys", deadlineHint: "friday",
    };
    appendRecords(home, [c]);
    const path = join(home, "workspace", "memory", "commitments.jsonl");
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf-8"), /send keys/);
  });

  it("loadEmittedKeys returns Set across both commitment + cancellation files", () => {
    const c: CommitmentRecord = {
      type: "commitment", ts: "t", messageId: "mc",
      sender: "x", recipient: "y", channel: "email",
      commitment: "z", deadlineHint: "fri",
    };
    const x: CancellationRecord = {
      type: "cancellation", ts: "t", messageId: "mx",
      sender: "x", recipient: "y", channel: "email",
      timeReference: "tonight",
    };
    appendRecords(home, [c, x]);
    const keys = loadEmittedKeys(home);
    assert.equal(keys.size, 2);
    assert.ok(keys.has(recordKey(c)));
    assert.ok(keys.has(recordKey(x)));
  });

  it("loadActiveCommitments excludes resolved (matched by cancellation or fulfillment) ones", () => {
    // Commit to send X to recipient, then cancel that same recipient's event
    const c: CommitmentRecord = {
      type: "commitment", ts: "2026-05-07T10:00:00Z", messageId: "m-original",
      sender: "+1", recipient: "alice@x.com", channel: "email",
      commitment: "send the proposal",
      deadlineHint: "friday",
    };
    appendRecords(home, [c]);

    // No resolution yet → 1 active
    let active = loadActiveCommitments(home);
    assert.equal(active.length, 1);

    // Mark fulfilled by sending a follow-up to same recipient that mentions the proposal
    const fulfillment: CommitmentRecord = {
      type: "commitment", ts: "2026-05-08T10:00:00Z", messageId: "m-fulfill",
      sender: "+1", recipient: "alice@x.com", channel: "email",
      commitment: "sent the proposal",
      deadlineHint: "n/a",
      resolves: "m-original",
    };
    appendRecords(home, [fulfillment]);
    active = loadActiveCommitments(home);
    // The original is now resolved
    assert.equal(active.length, 0);
  });
});
