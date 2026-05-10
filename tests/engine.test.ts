import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOneShotArgs, InteractiveSession, formatOneShotExitError } from "../src/engine.js";

describe("formatOneShotExitError (Round R: include stdout when stderr is empty)", () => {
  it("uses stderr when present", () => {
    const msg = formatOneShotExitError(2, "rate limit\n", "");
    assert.match(msg, /code 2/);
    assert.match(msg, /rate limit/);
  });

  it("falls back to stdout when stderr is empty (the claude-CLI auth case)", () => {
    // Round R regression: claude CLI writes auth errors to stdout, exit 1.
    // Pre-fix the daemon's engine only forwarded stderr, so daemon.log
    // showed `oneShot exited with code 1: ` with no payload — the
    // 2026-05-04 / 2026-05-05 token-auth storms went undiagnosed because
    // of this. Including stdout in the error path lets AUTH_PATTERN match.
    const claudeStdout =
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}';
    const msg = formatOneShotExitError(1, "", claudeStdout);
    assert.match(msg, /code 1/);
    assert.match(msg, /401/);
    assert.match(msg, /authentication/i);
  });

  it("includes both streams when both are present, labeling each", () => {
    const msg = formatOneShotExitError(2, "stderr line", "stdout line");
    assert.match(msg, /stderr line/);
    assert.match(msg, /stdout line/);
  });

  it("truncates long streams to keep the message bounded", () => {
    const longStderr = "X".repeat(2000);
    const msg = formatOneShotExitError(1, longStderr, "");
    assert.ok(msg.length < 1500, `message should be bounded, got ${msg.length}`);
  });

  it("handles totally-empty case without garbage trailing chars", () => {
    const msg = formatOneShotExitError(127, "", "");
    assert.match(msg, /code 127/);
    assert.match(msg, /no output/i);
  });
});

describe("buildOneShotArgs", () => {
  it("builds correct args for a simple prompt", () => {
    const args = buildOneShotArgs({
      prompt: "Hello world",
      cwd: "/tmp/workspace",
      model: "sonnet",
      outputFormat: "text",
      timeout: 300000,
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Write"],
    });
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("Hello world"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("sonnet"));
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("text"));
    assert.ok(args.includes("--permission-mode"));
    assert.ok(args.includes("bypassPermissions"));
    assert.ok(args.includes("--allowed-tools"));
    assert.ok(args.includes("Read,Write"));
  });
});

describe("InteractiveSession", () => {
  it("constructs, starts, reports alive, kills, reports not alive", () => {
    const session = new InteractiveSession({
      sessionName: "test-session",
      cwd: "/tmp/workspace",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Write"],
      watchdogTimeout: 30000,
    });

    assert.equal(session.alive, false, "should not be alive before start");

    session.start();
    assert.equal(session.alive, true, "should be alive after start");

    session.kill();
    assert.equal(session.alive, false, "should not be alive after kill");
  });

  it("rejects when sending to a session that is not alive", async () => {
    const session = new InteractiveSession({
      sessionName: "test-dead",
      cwd: "/tmp/workspace",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowedTools: [],
      watchdogTimeout: 30000,
    });

    await assert.rejects(session.send("hello"), /Session not alive/);
  });

  it("send() returns a Promise that rejects on dead session", async () => {
    const session = new InteractiveSession({
      sessionName: "test-promise",
      cwd: "/tmp/workspace",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowedTools: [],
      watchdogTimeout: 30000,
    });
    // Don't start — verify send rejects on dead session and returns a Promise
    const promise = session.send("hello");
    assert.ok(promise instanceof Promise, "send() should return a Promise");
    await assert.rejects(promise, /Session not alive/);
  });

  it("exposes claudeSessionId getter", () => {
    const session = new InteractiveSession({
      sessionName: "test-id",
      cwd: "/tmp/workspace",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowedTools: [],
      watchdogTimeout: 30000,
    });
    assert.equal(session.claudeSessionId, null, "should be null before any message");
  });
});
