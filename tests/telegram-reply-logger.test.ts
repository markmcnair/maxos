import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logTelegramReply, type ChannelMessageLike } from "../src/telegram-reply-logger.js";

describe("logTelegramReply", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "brew-reply-log-"));
    logPath = join(tmp, "telegram-replies.jsonl");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("appends a JSONL line when message has replyToId", () => {
    const msg: ChannelMessageLike = {
      messageId: "m2",
      conversationId: "dm:mark",
      text: "A",
      replyToId: "m1",
      timestamp: 1714000000000,
    };
    logTelegramReply(msg, logPath);
    const line = readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.msgId, "m2");
    assert.equal(parsed.replyToId, "m1");
    assert.equal(parsed.body, "A");
    assert.equal(parsed.ts, 1714000000000);
  });

  it("does NOT write when replyToId is absent", () => {
    const msg: ChannelMessageLike = {
      messageId: "m3",
      conversationId: "dm:mark",
      text: "hello",
      timestamp: 1714000000001,
    };
    logTelegramReply(msg, logPath);
    assert.equal(existsSync(logPath), false);
  });

  it("appends multiple lines across calls", () => {
    logTelegramReply({ messageId: "m2", conversationId: "dm:mark", text: "A", replyToId: "m1", timestamp: 1 }, logPath);
    logTelegramReply({ messageId: "m4", conversationId: "dm:mark", text: "B", replyToId: "m3", timestamp: 2 }, logPath);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
  });
});
