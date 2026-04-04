import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOneShotArgs, InteractiveSession } from "../src/engine.js";

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
