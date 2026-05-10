import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDigestMessage } from "../src/maxos-digest.js";

describe("buildDigestMessage", () => {
  let tmp: string;
  const fixedNow = new Date("2026-04-28T22:00:00");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "digest-"));
    mkdirSync(join(tmp, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("renders the all-green case with the wind-down line", () => {
    const msg = buildDigestMessage({
      maxosHome: tmp,
      now: fixedNow,
      doctorResults: [
        { name: "daemon", status: "PASS", detail: "up" },
        { name: "openrouter", status: "PASS", detail: "ok" },
      ],
    });
    assert.match(msg, /MaxOS digest/);
    assert.match(msg, /All 2 doctor checks pass/);
    assert.match(msg, /Brain off, family on/);
  });

  it("surfaces FAIL checks loudly", () => {
    const msg = buildDigestMessage({
      maxosHome: tmp,
      now: fixedNow,
      doctorResults: [
        { name: "daemon", status: "PASS", detail: "up" },
        { name: "granola", status: "FAIL", detail: "Authentication required" },
      ],
    });
    assert.match(msg, /1 FAIL/);
    assert.match(msg, /granola: Authentication required/);
    assert.match(msg, /\/status detail/);
  });

  it("surfaces WARN checks even without FAILs", () => {
    const msg = buildDigestMessage({
      maxosHome: tmp,
      now: fixedNow,
      doctorResults: [
        { name: "daemon", status: "PASS", detail: "up" },
        { name: "workspace-git", status: "WARN", detail: "last commit 32h ago" },
      ],
    });
    assert.match(msg, /1 warning/);
    assert.match(msg, /workspace-git: last commit/);
  });

  it("counts open loops + Google Tasks mirrors from disk", () => {
    writeFileSync(
      join(tmp, "workspace", "memory", "open-loops.json"),
      JSON.stringify([
        { id: "a", topic: "x", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
        { id: "b", topic: "y", firstSeen: "2026-04-22", lastUpdated: "2026-04-24" },
      ]),
    );
    writeFileSync(
      join(tmp, "workspace", "memory", "google-tasks-state.json"),
      JSON.stringify({ loopToTask: { a: "ta", b: "tb" } }),
    );
    const msg = buildDigestMessage({ maxosHome: tmp, now: fixedNow, doctorResults: [] });
    assert.match(msg, /2 open loops · 2 mirrored/);
  });

  it("aggregates today's outbound and voice violations", () => {
    const todayMs = new Date("2026-04-28T08:00:00").getTime();
    writeFileSync(
      join(tmp, "workspace", "memory", "outbound-events.jsonl"),
      [
        JSON.stringify({ ts: todayMs, conversationId: "dm", chunkCount: 1, totalChars: 100, durationMs: 50, status: "ok" }),
        JSON.stringify({ ts: todayMs + 60_000, conversationId: "dm", chunkCount: 1, totalChars: 200, durationMs: 80, status: "failed", error: "boom" }),
      ].join("\n"),
    );
    writeFileSync(
      join(tmp, "workspace", "memory", "voice-violations.jsonl"),
      JSON.stringify({
        ts: todayMs, conversationId: "dm", task: "morning-brief",
        totalChars: 100, violationCount: 2,
        violations: [
          { pattern: "—", category: "em-dash" },
          { pattern: "Synergy", category: "word" },
        ],
      }) + "\n",
    );
    const msg = buildDigestMessage({ maxosHome: tmp, now: fixedNow, doctorResults: [] });
    assert.match(msg, /outbound today: 2 sent, 50% ok/);
    assert.match(msg, /voice today: 2 violations/);
  });

  it("counts scheduled tasks fired today (since local midnight)", () => {
    const todayMs = new Date("2026-04-28T08:00:00").getTime();
    const yesterday = new Date("2026-04-27T08:00:00").getTime();
    writeFileSync(
      join(tmp, "state.json"),
      JSON.stringify({
        scheduler: {
          lastRun: {
            "task-a": todayMs,
            "task-b": todayMs + 3600_000,
            "task-c": yesterday, // not today
          },
        },
      }),
    );
    const msg = buildDigestMessage({ maxosHome: tmp, now: fixedNow, doctorResults: [] });
    assert.match(msg, /2 scheduled tasks fired today/);
  });

  it("renders silent outbound + clean voice when there's no activity", () => {
    const msg = buildDigestMessage({ maxosHome: tmp, now: fixedNow, doctorResults: [] });
    assert.match(msg, /outbound today: silent/);
    // voice file doesn't exist → line is omitted, that's fine
  });
});
