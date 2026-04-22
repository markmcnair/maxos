import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claudeProjectSlug,
  parseFeedbackFile,
  loadAuthoritativeRules,
  formatAuthoritativeRules,
  type AuthoritativeRule,
} from "../src/authoritative-rules.js";

describe("claudeProjectSlug", () => {
  it("replaces / and . with - to match Claude Code's project-dir slug", () => {
    assert.equal(claudeProjectSlug("/Users/Max/.maxos/workspace"), "-Users-Max--maxos-workspace");
  });

  it("handles paths with trailing slashes", () => {
    assert.equal(claudeProjectSlug("/Users/Max/.maxos/workspace/"), "-Users-Max--maxos-workspace-");
  });

  it("returns empty string for empty input", () => {
    assert.equal(claudeProjectSlug(""), "");
  });
});

describe("parseFeedbackFile", () => {
  it("extracts YAML frontmatter name/description and the body", () => {
    const raw = `---
name: Body vault files are two-way synced to Notion
description: After interactive edits, push immediately
type: feedback
---

Body/ pillar files ARE synced to Notion two-way.

Run sync immediately after interactive edits.`;
    const rule = parseFeedbackFile("feedback_body_notion_sync.md", raw);
    assert.equal(rule.name, "Body vault files are two-way synced to Notion");
    assert.equal(rule.filename, "feedback_body_notion_sync.md");
    assert.ok(rule.body.includes("Body/ pillar files ARE synced"));
    assert.ok(!rule.body.includes("---"), "frontmatter should be stripped from body");
  });

  it("handles files without frontmatter — uses filename as name", () => {
    const raw = `Just a body with no frontmatter.`;
    const rule = parseFeedbackFile("feedback_noname.md", raw);
    assert.equal(rule.name, "feedback_noname");
    assert.equal(rule.body, "Just a body with no frontmatter.");
  });

  it("handles files with frontmatter but no explicit name", () => {
    const raw = `---
type: feedback
---

Body text`;
    const rule = parseFeedbackFile("feedback_anon.md", raw);
    // Falls back to filename-derived name
    assert.equal(rule.name, "feedback_anon");
  });
});

describe("loadAuthoritativeRules", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "auth-rules-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("loads every feedback_*.md from workspace/memory/", () => {
    writeFileSync(
      join(home, "workspace", "memory", "feedback_rule_a.md"),
      "---\nname: Rule A\n---\n\nBody A",
    );
    writeFileSync(
      join(home, "workspace", "memory", "feedback_rule_b.md"),
      "---\nname: Rule B\n---\n\nBody B",
    );
    // Non-feedback file should be ignored
    writeFileSync(
      join(home, "workspace", "memory", "random.md"),
      "not a feedback",
    );
    const rules = loadAuthoritativeRules(home);
    assert.equal(rules.length, 2);
    assert.ok(rules.some((r) => r.name === "Rule A"));
    assert.ok(rules.some((r) => r.name === "Rule B"));
  });

  it("returns empty array when no feedback files exist", () => {
    assert.deepEqual(loadAuthoritativeRules(home), []);
  });

  it("returns empty array when the directory is missing", () => {
    assert.deepEqual(loadAuthoritativeRules("/nonexistent/path"), []);
  });

  it("dedupes by filename when the same rule appears in multiple source dirs", () => {
    // Create a second source (simulating Claude auto-memory)
    const claudeDir = join(home, "claude-memory");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(home, "workspace", "memory", "feedback_overlap.md"),
      "---\nname: Workspace version (wins)\n---\n\nbody",
    );
    writeFileSync(
      join(claudeDir, "feedback_overlap.md"),
      "---\nname: Claude version (loses)\n---\n\nbody",
    );
    const rules = loadAuthoritativeRules(home, [claudeDir]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].name, "Workspace version (wins)");
  });

  it("merges feedback files from additional source dirs when not duplicated", () => {
    const claudeDir = join(home, "claude-memory");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(home, "workspace", "memory", "feedback_a.md"),
      "---\nname: A\n---",
    );
    writeFileSync(
      join(claudeDir, "feedback_b.md"),
      "---\nname: B\n---",
    );
    const rules = loadAuthoritativeRules(home, [claudeDir]);
    assert.equal(rules.length, 2);
  });
});

describe("formatAuthoritativeRules", () => {
  const rules: AuthoritativeRule[] = [
    {
      filename: "feedback_body_notion_sync.md",
      name: "Body vault files are two-way synced to Notion",
      body: "Body/ pillar files ARE synced to Notion two-way. Run sync immediately after edits.",
    },
    {
      filename: "feedback_dcfs_ghosting.md",
      name: "DCFS/DHS placement pings are not ghosted",
      body: "Never flag DHS/DCFS placement texts as ghosted or open loops.",
    },
  ];

  it("emits the non-negotiable header with directive language", () => {
    const md = formatAuthoritativeRules(rules);
    assert.ok(md.includes("## Authoritative Rules"));
    assert.ok(md.toLowerCase().includes("non-negotiable"));
    assert.ok(md.toLowerCase().includes("override"));
  });

  it("includes each rule's name as a subsection and its body as content", () => {
    const md = formatAuthoritativeRules(rules);
    assert.ok(md.includes("Body vault files are two-way synced to Notion"));
    assert.ok(md.includes("Run sync immediately"));
    assert.ok(md.includes("DCFS/DHS placement pings"));
  });

  it("returns empty string for empty input (so callers can skip the section cleanly)", () => {
    assert.equal(formatAuthoritativeRules([]), "");
  });
});
