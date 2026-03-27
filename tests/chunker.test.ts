import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { smartChunk } from "../src/utils/chunker.js";

describe("smartChunk", () => {
  it("returns single chunk for short messages", () => {
    const chunks = smartChunk("Hello world", 4096);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "Hello world");
  });

  it("splits at paragraph boundaries", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = smartChunk(text, 30);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[0].includes("Paragraph one."));
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 30, `Chunk too long: ${chunk.length}`);
    }
  });

  it("splits at sentence boundaries when paragraphs are too long", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const chunks = smartChunk(text, 40);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 40);
    }
  });

  it("hard splits words that exceed max length", () => {
    const text = "a".repeat(100);
    const chunks = smartChunk(text, 30);
    assert.ok(chunks.length >= 4);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 30);
    }
  });

  it("preserves content — join equals original minus whitespace changes", () => {
    const text = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = smartChunk(text, 20);
    const rejoined = chunks.join("\n\n");
    assert.ok(rejoined.includes("Para one."));
    assert.ok(rejoined.includes("Para two."));
    assert.ok(rejoined.includes("Para three."));
  });
});
