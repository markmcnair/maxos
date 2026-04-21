import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemFacts, formatSystemFacts } from "../src/system-facts.js";

describe("buildSystemFacts", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "maxos-facts-"));
    mkdirSync(join(home, "workspace"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads model from maxos.json", () => {
    writeFileSync(
      join(home, "maxos.json"),
      JSON.stringify({ engine: { model: "claude-opus-4-7" } }),
    );
    const facts = buildSystemFacts({ maxosHome: home });
    assert.equal(facts.model, "claude-opus-4-7");
  });

  it("returns 'unknown' model when maxos.json is missing", () => {
    const facts = buildSystemFacts({ maxosHome: home });
    assert.equal(facts.model, "unknown");
  });

  it("returns 'unknown' model when maxos.json is malformed", () => {
    writeFileSync(join(home, "maxos.json"), "{ not valid json");
    const facts = buildSystemFacts({ maxosHome: home });
    assert.equal(facts.model, "unknown");
  });

  it("includes the workspace path", () => {
    const facts = buildSystemFacts({ maxosHome: home });
    assert.equal(facts.workspace, join(home, "workspace"));
  });

  it("includes the vault path", () => {
    const facts = buildSystemFacts({ maxosHome: home });
    assert.equal(facts.vault, join(home, "vault"));
  });

  it("captures the current date/timezone", () => {
    const facts = buildSystemFacts({ maxosHome: home });
    assert.match(facts.nowISO, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("formatSystemFacts", () => {
  it("renders as a markdown block the LLM is instructed to trust", () => {
    const block = formatSystemFacts({
      model: "claude-opus-4-7",
      workspace: "/Users/Max/.maxos/workspace",
      vault: "/Users/Max/.maxos/vault",
      nowISO: "2026-04-20T22:30:00-05:00",
      version: "0.1.0",
      maxosHome: "/Users/Max/.maxos",
    });
    assert.ok(block.includes("## System Facts"));
    assert.ok(block.includes("claude-opus-4-7"));
    assert.ok(block.includes("trust these over any prior belief"));
    assert.ok(block.includes("2026-04-20"));
  });

  it("always emits the non-negotiable trust instruction", () => {
    const block = formatSystemFacts({
      model: "unknown",
      workspace: "",
      vault: "",
      nowISO: "",
      version: "0.0.0",
      maxosHome: "",
    });
    assert.ok(block.toLowerCase().includes("do not answer from general knowledge"));
  });
});
