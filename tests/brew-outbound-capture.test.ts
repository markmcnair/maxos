import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordOutboundId, findLatestForTask } from "../src/brew-outbound-capture.js";

describe("recordOutboundId", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "outbound-"));
    p = join(tmp, "outbound-ids.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("records task name + messageId + timestamp", () => {
    recordOutboundId(p, { task: "morning-brew", messageId: "m123", ts: 1714000000000 });
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.task, "morning-brew");
    assert.equal(parsed.messageId, "m123");
    assert.equal(parsed.ts, 1714000000000);
  });

  it("appends across calls", () => {
    recordOutboundId(p, { task: "morning-brew", messageId: "m1", ts: 1 });
    recordOutboundId(p, { task: "morning-brew", messageId: "m2", ts: 2 });
    assert.equal(readFileSync(p, "utf-8").trim().split("\n").length, 2);
  });
});

describe("findLatestForTask", () => {
  it("returns the most recent entry matching the task", () => {
    const content = [
      JSON.stringify({ task: "morning-brew", messageId: "m1", ts: 1 }),
      JSON.stringify({ task: "morning-brew", messageId: "m2", ts: 3 }),
      JSON.stringify({ task: "other", messageId: "m3", ts: 5 }),
      JSON.stringify({ task: "morning-brew", messageId: "m4", ts: 2 }),
    ].join("\n") + "\n";
    const r = findLatestForTask("", "morning-brew", content);
    assert.equal(r?.messageId, "m2");
    assert.equal(r?.ts, 3);
  });

  it("returns null when no matching task", () => {
    const content = JSON.stringify({ task: "other", messageId: "m1", ts: 1 }) + "\n";
    assert.equal(findLatestForTask("", "morning-brew", content), null);
  });

  it("tolerates blank lines and corrupt JSON", () => {
    const content = `\n${JSON.stringify({ task: "morning-brew", messageId: "m1", ts: 1 })}\n\nnot-json\n`;
    const r = findLatestForTask("", "morning-brew", content);
    assert.equal(r?.messageId, "m1");
  });
});
