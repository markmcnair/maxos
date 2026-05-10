import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { panelToMarkdown, isExpiredOrSoon } from "../src/granola.js";

describe("panelToMarkdown", () => {
  it("converts a typical Granola AI summary panel to markdown", () => {
    const panel = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Team Updates" }] },
        {
          type: "bullet_list",
          content: [
            { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "Emily missed inputs" }] }] },
            { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "Rob 150 calls" }] }] },
          ],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Next Steps" }] },
        { type: "paragraph", content: [{ type: "text", text: "Schedule feedback session." }] },
      ],
    };
    const md = panelToMarkdown(panel);
    assert.match(md, /## Team Updates/);
    assert.match(md, /- Emily missed inputs/);
    assert.match(md, /- Rob 150 calls/);
    assert.match(md, /## Next Steps/);
    assert.match(md, /Schedule feedback session\./);
  });

  it("handles empty content gracefully", () => {
    assert.equal(panelToMarkdown(null), "");
    assert.equal(panelToMarkdown(undefined), "");
    assert.equal(panelToMarkdown({}), "");
  });

  it("preserves nested heading levels", () => {
    const panel = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Top" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Sub" }] },
      ],
    };
    const md = panelToMarkdown(panel);
    assert.match(md, /^# Top/m);
    assert.match(md, /^### Sub/m);
  });

  it("collapses excessive blank lines", () => {
    const panel = {
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
      ],
    };
    const md = panelToMarkdown(panel);
    assert.ok(!/\n{3,}/.test(md), "should not contain 3+ consecutive newlines");
  });
});

describe("isExpiredOrSoon", () => {
  const NOW = 1_000_000;
  const baseToken = {
    accessToken: "x",
    refreshToken: "y",
    clientId: "client_test",
    expiresAt: 0,
  };
  it("returns true when token expired in the past", () => {
    assert.equal(isExpiredOrSoon({ ...baseToken, expiresAt: NOW - 100 }, NOW), true);
  });
  it("returns true when token expires within 60s buffer", () => {
    assert.equal(isExpiredOrSoon({ ...baseToken, expiresAt: NOW + 30 }, NOW), true);
  });
  it("returns false when token is comfortably valid", () => {
    assert.equal(isExpiredOrSoon({ ...baseToken, expiresAt: NOW + 3600 }, NOW), false);
  });
  it("returns true exactly at the buffer boundary", () => {
    assert.equal(isExpiredOrSoon({ ...baseToken, expiresAt: NOW + 60 }, NOW), true);
  });
});
