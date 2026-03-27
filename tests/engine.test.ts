import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOneShotArgs, buildInteractiveArgs } from "../src/engine.js";

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

describe("buildInteractiveArgs", () => {
  it("builds args for a fresh session", () => {
    const args = buildInteractiveArgs({
      sessionName: "main",
      cwd: "/tmp/workspace",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Write"],
      resume: false,
    });
    assert.ok(args.includes("-n"));
    assert.ok(args.includes("main"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("sonnet"));
    assert.ok(!args.includes("--resume"));
  });

  it("builds args for session resume", () => {
    const args = buildInteractiveArgs({
      sessionName: "main",
      cwd: "/tmp/workspace",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read"],
      resume: true,
    });
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("main"));
  });
});
