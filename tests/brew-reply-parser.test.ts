import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findReplyTo,
  classifyReply,
  type ReplyChoice,
} from "../src/brew-reply-parser.js";

describe("classifyReply", () => {
  it("recognizes A / continue / yes as continue", () => {
    assert.equal(classifyReply("A"), "continue");
    assert.equal(classifyReply("a"), "continue");
    assert.equal(classifyReply("continue"), "continue");
    assert.equal(classifyReply("yes"), "continue");
    assert.equal(classifyReply("Continue RAG track"), "continue");
  });

  it("recognizes B / new / switch as switch", () => {
    assert.equal(classifyReply("B"), "switch");
    assert.equal(classifyReply("b"), "switch");
    assert.equal(classifyReply("switch"), "switch");
    assert.equal(classifyReply("new topic please"), "switch");
  });

  it("returns ambiguous for unknown replies", () => {
    assert.equal(classifyReply("hmm not sure"), "ambiguous");
    assert.equal(classifyReply(""), "ambiguous");
  });
});

describe("findReplyTo", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reply-parser-"));
    p = join(tmp, "telegram-replies.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("finds most recent reply to a given msgId", () => {
    writeFileSync(p, [
      JSON.stringify({ ts: 1, msgId: "r1", replyToId: "m1", conversationId: "dm", body: "A" }),
      JSON.stringify({ ts: 2, msgId: "r2", replyToId: "m1", conversationId: "dm", body: "B" }),
      JSON.stringify({ ts: 3, msgId: "r3", replyToId: "m2", conversationId: "dm", body: "A" }),
    ].join("\n") + "\n");
    const found = findReplyTo(p, "m1");
    assert.equal(found?.body, "B");
    assert.equal(found?.ts, 2);
  });

  it("returns null when no reply", () => {
    writeFileSync(p, JSON.stringify({ ts: 1, msgId: "r1", replyToId: "other", conversationId: "dm", body: "A" }) + "\n");
    assert.equal(findReplyTo(p, "m1"), null);
  });

  it("returns null when file missing", () => {
    assert.equal(findReplyTo("/nonexistent", "m1"), null);
  });
});
