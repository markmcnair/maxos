import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logOutboundEvent, summarizeOutbound, readAndSummarize } from "../src/outbound-log.js";

describe("logOutboundEvent", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "outbound-log-"));
    p = join(tmp, "outbound-events.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("appends a JSONL line per event", () => {
    logOutboundEvent(p, {
      ts: 1, conversationId: "dm:123", chunkCount: 1, totalChars: 50,
      durationMs: 100, status: "ok",
    });
    logOutboundEvent(p, {
      ts: 2, conversationId: "dm:123", chunkCount: 2, totalChars: 4000,
      durationMs: 250, status: "failed", error: "Bad Request",
    });
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).status, "ok");
    assert.equal(JSON.parse(lines[1]).status, "failed");
  });

  it("never throws when the path is invalid (best-effort)", () => {
    assert.doesNotThrow(() => {
      logOutboundEvent("/nonexistent/dir/file.jsonl", {
        ts: 1, conversationId: "dm", chunkCount: 1, totalChars: 1,
        durationMs: 1, status: "ok",
      });
    });
  });
});

describe("summarizeOutbound (pure)", () => {
  const events = [
    JSON.stringify({ ts: 100, conversationId: "dm", chunkCount: 1, totalChars: 200, durationMs: 50, status: "ok" }),
    JSON.stringify({ ts: 200, conversationId: "dm", chunkCount: 2, totalChars: 5000, durationMs: 300, status: "ok" }),
    JSON.stringify({ ts: 300, conversationId: "dm", chunkCount: 1, totalChars: 100, durationMs: 80, status: "failed", error: "Bad Request" }),
    JSON.stringify({ ts: 400, conversationId: "dm", chunkCount: 1, totalChars: 50, durationMs: 40, status: "ok", retried: true }),
  ].join("\n");

  it("counts ok, failed, retried, total, totalChars", () => {
    const s = summarizeOutbound(events, 0, 9999);
    assert.equal(s.total, 4);
    assert.equal(s.ok, 3);
    assert.equal(s.failed, 1);
    assert.equal(s.retried, 1);
    assert.equal(s.totalChars, 5350);
  });

  it("computes successRate", () => {
    const s = summarizeOutbound(events, 0, 9999);
    assert.equal(s.successRate, 0.75);
  });

  it("computes averageDurationMs", () => {
    const s = summarizeOutbound(events, 0, 9999);
    // (50 + 300 + 80 + 40) / 4 = 117.5 → 118
    assert.equal(s.averageDurationMs, 118);
  });

  it("returns the most-recent failure as lastFailure", () => {
    const moreEvents = events + "\n" + JSON.stringify({
      ts: 500, conversationId: "dm", chunkCount: 1, totalChars: 10, durationMs: 20,
      status: "failed", error: "Newer fail",
    });
    const s = summarizeOutbound(moreEvents, 0, 9999);
    assert.equal(s.failed, 2);
    assert.equal(s.lastFailure?.error, "Newer fail");
  });

  it("filters by ts window", () => {
    const s = summarizeOutbound(events, 250, 350);
    assert.equal(s.total, 1);
    assert.equal(s.failed, 1);
  });

  it("returns successRate=1 when no events in window (no failure noise)", () => {
    const s = summarizeOutbound(events, 99999, 999999);
    assert.equal(s.total, 0);
    assert.equal(s.successRate, 1);
  });

  it("tolerates corrupt JSON lines", () => {
    const messy = events + "\nnot valid json\n{broken\n" +
      JSON.stringify({ ts: 600, conversationId: "dm", chunkCount: 1, totalChars: 0, durationMs: 10, status: "ok" });
    const s = summarizeOutbound(messy, 0, 9999);
    assert.equal(s.total, 5); // ignored 2 corrupt, kept 5 valid
  });
});

describe("readAndSummarize (with file system)", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "outbound-summ-"));
    p = join(tmp, "outbound-events.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns zero-state for missing file (no error)", () => {
    const s = readAndSummarize(p, 0);
    assert.equal(s.total, 0);
    assert.equal(s.successRate, 1);
  });

  it("reads + summarizes from disk", () => {
    writeFileSync(p, JSON.stringify({
      ts: 100, conversationId: "dm", chunkCount: 1, totalChars: 50,
      durationMs: 25, status: "ok",
    }) + "\n");
    const s = readAndSummarize(p, 0);
    assert.equal(s.total, 1);
    assert.equal(s.ok, 1);
  });
});
