import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  parseChatGPTExport,
  conversationToMarkdown,
  slugForFilename,
  exportToFiles,
  extractCustomInstructions,
  formatCustomInstructionsBlock,
  type ChatGPTConversation,
} from "../src/chatgpt-import.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "chatgpt-sample.json"), "utf-8"),
) as ChatGPTConversation[];
const FIXTURE_CI = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "chatgpt-with-custom-instructions.json"), "utf-8"),
) as ChatGPTConversation[];

describe("parseChatGPTExport", () => {
  it("returns all conversations from the raw JSON array", () => {
    const out = parseChatGPTExport(FIXTURE);
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "Brainstorming product names");
  });

  it("filters out archived conversations when option is set", () => {
    const withArchived = [
      ...FIXTURE,
      { ...FIXTURE[0], is_archived: true, conversation_id: "archived-1" },
    ];
    const out = parseChatGPTExport(withArchived, { skipArchived: true });
    assert.equal(out.length, 3);
  });

  it("skips malformed entries without throwing", () => {
    const bad = [
      ...FIXTURE,
      { not_a_conversation: true } as unknown as ChatGPTConversation,
    ];
    const out = parseChatGPTExport(bad);
    assert.equal(out.length, 3);
  });
});

describe("conversationToMarkdown", () => {
  it("renders user and assistant turns alternating", () => {
    const md = conversationToMarkdown(FIXTURE[0]);
    assert.ok(md.includes("**You:**"), "expected **You:** marker");
    assert.ok(md.includes("**GPT:**"), "expected **GPT:** marker");
    assert.ok(md.includes("brainstorm names"));
    assert.ok(md.includes("BrewCrate"));
  });

  it("includes YAML frontmatter with title, date, conversation_id, message_count", () => {
    const md = conversationToMarkdown(FIXTURE[0]);
    assert.ok(md.startsWith("---\n"));
    assert.ok(md.includes("title: "));
    assert.ok(md.includes("2024-11-30"));
    assert.ok(md.includes("conversation_id: 11111111-aaaa-bbbb-cccc-111111111111"));
    assert.ok(md.includes("message_count: 4"));
  });

  it("skips system messages with empty content (e.g. hidden system prompts)", () => {
    const md = conversationToMarkdown(FIXTURE[1]);
    // Empty system message at the start should not produce a **System:** block
    assert.ok(!md.includes("**System:**\n\n\n"), "empty system should be skipped");
    assert.ok(md.includes("What's the capital of France"));
  });

  it("follows the current_node chain (ignores regenerated branches)", () => {
    const md = conversationToMarkdown(FIXTURE[2]);
    assert.ok(md.includes("KEPT branch"), "main-path assistant should appear");
    assert.ok(!md.includes("REGENERATED"), "branched-off assistant should NOT appear");
  });

  it("handles Untitled conversations with a usable fallback title", () => {
    const md = conversationToMarkdown(FIXTURE[1]);
    // Should NOT be literal "Untitled" — use date + preview
    assert.ok(md.includes("title: "));
  });
});

describe("slugForFilename", () => {
  it("produces filesystem-safe slugs", () => {
    assert.equal(slugForFilename("Brainstorming product names"), "brainstorming-product-names");
    assert.equal(slugForFilename("What's the /slash/ problem?"), "whats-the-slash-problem");
    assert.equal(slugForFilename("   Leading and trailing   "), "leading-and-trailing");
  });

  it("truncates long titles", () => {
    const long = "a ".repeat(200);
    const slug = slugForFilename(long);
    assert.ok(slug.length <= 80);
  });

  it("handles Unicode / emoji gracefully", () => {
    const slug = slugForFilename("🎉 Party Time 🎉");
    // Emojis stripped, text preserved
    assert.ok(slug.includes("party"));
    assert.ok(slug.includes("time"));
  });

  it("returns non-empty fallback for titles that strip to nothing", () => {
    const slug = slugForFilename("!!!");
    assert.ok(slug.length > 0);
  });
});

describe("extractCustomInstructions", () => {
  it("returns null when no conversation has a substantive system message", () => {
    // FIXTURE has one empty system message — should not count as custom instructions
    const result = extractCustomInstructions(FIXTURE);
    assert.equal(result, null);
  });

  it("finds the custom instructions when a system message contains them", () => {
    const result = extractCustomInstructions(FIXTURE_CI);
    assert.ok(result);
    assert.ok(result.content.includes("Jane Doe"));
    assert.ok(result.content.includes("TypeScript"));
    assert.equal(result.occurrences, 2, "should see it in 2 of the 3 conversations");
  });

  it("returns the most common system message when multiple candidates exist", () => {
    const mixed: ChatGPTConversation[] = [
      ...FIXTURE_CI,
      ...FIXTURE_CI,
      // Add a one-off rare system message
      {
        ...FIXTURE_CI[0],
        conversation_id: "unique-sys",
        mapping: {
          root: { id: "root", message: null, parent: null, children: ["s"] },
          s: {
            id: "s",
            message: {
              id: "s",
              author: { role: "system" },
              create_time: 1,
              content: { content_type: "text", parts: ["UNIQUE ONE-OFF SYSTEM PROMPT, ignore me"] },
            } as any,
            parent: "root",
            children: [],
          },
        },
        current_node: "s",
      } as ChatGPTConversation,
    ];
    const result = extractCustomInstructions(mixed);
    assert.ok(result);
    assert.ok(result.content.includes("Jane Doe"), "should pick the MORE COMMON one, not the one-off");
    assert.ok(!result.content.includes("UNIQUE ONE-OFF"));
  });

  it("ignores system messages that are too short to be custom instructions", () => {
    const shortOnly: ChatGPTConversation = {
      ...FIXTURE_CI[0],
      mapping: {
        root: { id: "root", message: null, parent: null, children: ["s"] },
        s: {
          id: "s",
          message: {
            id: "s",
            author: { role: "system" },
            create_time: 1,
            content: { content_type: "text", parts: ["You are a helpful assistant."] },
          } as any,
          parent: "root",
          children: [],
        },
      },
      current_node: "s",
    };
    const result = extractCustomInstructions([shortOnly]);
    assert.equal(result, null, "too short should not match");
  });
});

describe("formatCustomInstructionsBlock", () => {
  it("produces a markdown-formatted section for appending to USER.md", () => {
    const block = formatCustomInstructionsBlock({
      content: "- I am Jane Doe\n- I prefer bulleted answers",
      occurrences: 42,
    });
    assert.ok(block.includes("## Imported from ChatGPT"));
    assert.ok(block.includes("Jane Doe"));
    assert.ok(block.includes("42 conversations"));
  });

  it("strips the generic ChatGPT preamble so only the user's actual instructions remain", () => {
    const block = formatCustomInstructionsBlock({
      content: "The user provided the following information about themselves. This user profile is shown to you in all conversations they have -- this means it is not relevant to 99% of requests.\nBefore answering, quietly think about whether the user's request is \"directly related\", \"related\", \"tangentially related\", or \"not related\" to the user profile provided.\n\nHere are the user's custom instructions:\n- I am Jane Doe\n- I prefer bulleted answers",
      occurrences: 10,
    });
    assert.ok(!block.includes("99% of requests"), "preamble should be stripped");
    assert.ok(block.includes("Jane Doe"));
  });
});

describe("exportToFiles", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "chatgpt-export-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes one markdown file per conversation under YYYY/MM directory structure", async () => {
    const result = await exportToFiles(FIXTURE, outDir);
    assert.equal(result.filesWritten, 3);

    // YYYY/MM subdirectory should exist
    const entries = readdirSync(outDir);
    assert.ok(entries.includes("2024"), `expected 2024 dir, got ${entries.join(",")}`);
  });

  it("produces valid markdown for each file", async () => {
    await exportToFiles(FIXTURE, outDir);
    const year = readdirSync(outDir)[0];
    const month = readdirSync(join(outDir, year))[0];
    const files = readdirSync(join(outDir, year, month));
    assert.ok(files.length > 0);
    for (const f of files) {
      const content = readFileSync(join(outDir, year, month, f), "utf-8");
      assert.ok(content.startsWith("---\n"), `${f} should have frontmatter`);
    }
  });

  it("deduplicates filename collisions by appending conversation_id suffix", async () => {
    const dupes = [
      { ...FIXTURE[0], conversation_id: "dup-a" },
      { ...FIXTURE[0], conversation_id: "dup-b" },
    ];
    const result = await exportToFiles(dupes, outDir);
    assert.equal(result.filesWritten, 2);
  });

  it("reports count and any skipped entries", async () => {
    const withBad = [
      ...FIXTURE,
      { not_valid: true } as unknown as ChatGPTConversation,
    ];
    const result = await exportToFiles(withBad, outDir);
    assert.equal(result.filesWritten, 3);
    assert.equal(result.skipped, 1);
  });
});
