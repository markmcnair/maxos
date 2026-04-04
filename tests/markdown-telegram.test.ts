import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToTelegramHtml } from "../src/utils/markdown-to-telegram.js";

describe("markdownToTelegramHtml", () => {
  it("converts **bold** to <b>", () => {
    assert.equal(markdownToTelegramHtml("**hello**"), "<b>hello</b>");
  });

  it("converts *italic* to <i>", () => {
    assert.equal(markdownToTelegramHtml("*hello*"), "<i>hello</i>");
  });

  it("converts ***bold italic*** to <b><i>", () => {
    assert.equal(markdownToTelegramHtml("***hello***"), "<b><i>hello</i></b>");
  });

  it("converts ~~strike~~ to <s>", () => {
    assert.equal(markdownToTelegramHtml("~~hello~~"), "<s>hello</s>");
  });

  it("converts [text](url) to <a>", () => {
    assert.equal(
      markdownToTelegramHtml("[click](https://example.com)"),
      '<a href="https://example.com">click</a>'
    );
  });

  it("converts # headers to <b>", () => {
    assert.equal(markdownToTelegramHtml("# Title"), "<b>Title</b>");
    assert.equal(markdownToTelegramHtml("### Sub"), "<b>Sub</b>");
  });

  it("converts inline `code` to <code>", () => {
    assert.equal(markdownToTelegramHtml("use `npm install`"), "use <code>npm install</code>");
  });

  it("converts code blocks to <pre><code>", () => {
    const input = "```js\nconsole.log('hi');\n```";
    const expected = "<pre><code>console.log('hi');</code></pre>";
    assert.equal(markdownToTelegramHtml(input), expected);
  });

  it("escapes HTML inside code blocks", () => {
    const input = "```\n<div>hello</div>\n```";
    assert.ok(markdownToTelegramHtml(input).includes("&lt;div&gt;"));
  });

  it("converts blockquotes", () => {
    const input = "> This is a quote";
    assert.ok(markdownToTelegramHtml(input).includes("<blockquote>"));
    assert.ok(markdownToTelegramHtml(input).includes("This is a quote"));
  });

  it("handles mixed formatting in one line", () => {
    const input = "**Bold** and *italic* and [link](https://x.com)";
    const result = markdownToTelegramHtml(input);
    assert.ok(result.includes("<b>Bold</b>"));
    assert.ok(result.includes("<i>italic</i>"));
    assert.ok(result.includes('<a href="https://x.com">link</a>'));
  });

  it("collapses excessive blank lines", () => {
    const input = "line 1\n\n\n\n\nline 2";
    assert.equal(markdownToTelegramHtml(input), "line 1\n\nline 2");
  });

  it("handles the AI post format from test", () => {
    const input = `**Post:** Jeremiah Lowin ([@jlowin](https://x.com/jlowin)) — Prefect Horizon launch

**Why it's interesting:** Lowin coined "the context layer" — the middleware where AI agents interface with your business.

**Takeaway for Emprise:** You're essentially building a context layer with MaxOS.`;
    const result = markdownToTelegramHtml(input);
    assert.ok(result.includes("<b>Post:</b>"));
    assert.ok(result.includes('<a href="https://x.com/jlowin">@jlowin</a>'));
    assert.ok(result.includes("<b>Why it's interesting:</b>"));
    assert.ok(!result.includes("**")); // No raw markdown left
  });
});
