import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildReplyContext, formatReplyContext } from "../src/reply-context.js";

describe("formatReplyContext (pure)", () => {
  it("formats the no-outbound case with a wake-word warning", () => {
    const block = formatReplyContext("B", "switch", null, "2026-04-26");
    assert.match(block, /REPLY CONTEXT/);
    assert.match(block, /no matching outbound task record/);
    assert.match(block, /memory\/2026-04-26\.md/);
    assert.match(block, /Do NOT echo "B"/);
    assert.match(block, /Classified intent: switch/);
  });

  it("formats the matched-task case with task name and date", () => {
    const block = formatReplyContext(
      "B",
      "switch",
      { task: "morning-brew", messageId: "m1", ts: 1714000000000 },
      "2026-04-25",
    );
    assert.match(block, /reply to a "morning-brew" message/);
    assert.match(block, /at 2026-04-25/);
    assert.match(block, /memory\/2026-04-25\.md/);
    assert.match(block, /Do NOT echo "B"/);
    assert.match(block, /context of the original morning-brew/);
  });

  it("trims the body before quoting", () => {
    const block = formatReplyContext("  A  ", "continue", null, "2026-04-27");
    assert.match(block, /Reply body: "A"/);
    assert.doesNotMatch(block, /Reply body: " {2}A {2}"/);
  });
});

describe("buildReplyContext (with file system)", () => {
  let tmp: string;
  let outboundPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reply-ctx-"));
    outboundPath = join(tmp, "outbound-ids.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns empty when message has no replyToId", () => {
    assert.equal(buildReplyContext({ text: "hi" }, outboundPath), "");
  });

  it("returns empty when message has empty body", () => {
    assert.equal(buildReplyContext({ replyToId: "m1", text: "" }, outboundPath), "");
    assert.equal(buildReplyContext({ replyToId: "m1", text: "   " }, outboundPath), "");
  });

  it("returns empty when message has no text", () => {
    assert.equal(buildReplyContext({ replyToId: "m1" }, outboundPath), "");
  });

  it("returns no-outbound context when outbound file is missing", () => {
    const block = buildReplyContext(
      { replyToId: "m1", text: "B" },
      "/nonexistent-path",
      new Date("2026-04-27T12:00:00"),
    );
    assert.match(block, /no matching outbound task record/);
    assert.match(block, /memory\/2026-04-27\.md/);
    assert.match(block, /Classified intent: switch/);
  });

  it("returns no-outbound context when no entry matches replyToId", () => {
    writeFileSync(
      outboundPath,
      JSON.stringify({ task: "morning-brief", messageId: "other", ts: 1714000000000 }) + "\n",
    );
    const block = buildReplyContext(
      { replyToId: "m1", text: "A" },
      outboundPath,
      new Date("2026-04-27T12:00:00"),
    );
    assert.match(block, /no matching outbound task record/);
    assert.match(block, /Classified intent: continue/);
  });

  it("returns matched-task context with the task name and original date", () => {
    const ts = new Date("2026-04-25T06:15:00").getTime();
    writeFileSync(
      outboundPath,
      JSON.stringify({ task: "morning-brew", messageId: "m1", ts }) + "\n",
    );
    const block = buildReplyContext(
      { replyToId: "m1", text: "B" },
      outboundPath,
      new Date("2026-04-27T12:00:00"),
    );
    assert.match(block, /reply to a "morning-brew" message/);
    assert.match(block, /at 2026-04-25/);
    assert.match(block, /memory\/2026-04-25\.md/);
  });

  it("returns the FIRST match in the log when multiple records share a messageId", () => {
    // Telegram message_ids are globally unique, so this case can't actually
    // occur in production. But documenting the resolved behavior protects
    // against silent drift if findOutboundForMessageId's return semantics
    // change in the future. ISSUE-011 fix: name says what's tested, comment
    // notes the production constraint.
    const lines = [
      JSON.stringify({ task: "morning-brew", messageId: "m1", ts: 1 }),
      JSON.stringify({ task: "morning-brief", messageId: "m1", ts: 2 }),
    ].join("\n");
    writeFileSync(outboundPath, lines + "\n");
    const block = buildReplyContext({ replyToId: "m1", text: "B" }, outboundPath);
    assert.match(block, /morning-brew/);
  });

  it("regression: 'B' reply does not silently pass through to chat session without context", () => {
    const ts = new Date("2026-04-26T06:15:00").getTime();
    writeFileSync(
      outboundPath,
      JSON.stringify({ task: "morning-brew", messageId: "brew-msg-id", ts }) + "\n",
    );
    const block = buildReplyContext(
      { replyToId: "brew-msg-id", text: "B" },
      outboundPath,
    );
    // Must explicitly tell the chat session not to echo "B" — that's the whole bug
    assert.match(block, /Do NOT echo "B"/);
    assert.match(block, /morning-brew/);
  });
});
