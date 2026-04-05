import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToTelegramHtml, stripHtmlToPlain } from "../src/utils/markdown-to-telegram.js";

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

  it("preserves & in link URLs", () => {
    const input = "[search](https://example.com?a=1&b=2)";
    const result = markdownToTelegramHtml(input);
    assert.ok(result.includes('href="https://example.com?a=1&b=2"'));
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

  it("escapes < and > in regular text", () => {
    const input = "if x < 10 and y > 5 then do it";
    const result = markdownToTelegramHtml(input);
    assert.ok(result.includes("&lt;"));
    assert.ok(result.includes("&gt;"));
    assert.ok(!result.includes("<10")); // No unescaped angle brackets
  });

  it("escapes & in regular text", () => {
    const input = "Tom & Jerry";
    const result = markdownToTelegramHtml(input);
    assert.ok(result.includes("&amp;"));
  });

  it("does not double-escape code blocks", () => {
    const input = "```\nx < 10 && y > 5\n```";
    const result = markdownToTelegramHtml(input);
    // Should have &lt; not &amp;lt;
    assert.ok(result.includes("&lt;"));
    assert.ok(!result.includes("&amp;lt;"));
  });

  it("converts blockquotes", () => {
    const input = "> This is a quote";
    const result = markdownToTelegramHtml(input);
    assert.ok(result.includes("<blockquote>"));
    assert.ok(result.includes("This is a quote"));
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
    assert.ok(!result.includes("**")); // No raw markdown left
  });
});

describe("stripHtmlToPlain", () => {
  it("strips tags and unescapes entities", () => {
    assert.equal(stripHtmlToPlain("<b>hello</b>"), "hello");
    assert.equal(stripHtmlToPlain("x &lt; 10"), "x < 10");
    assert.equal(stripHtmlToPlain("Tom &amp; Jerry"), "Tom & Jerry");
    assert.equal(stripHtmlToPlain("a &gt; b"), "a > b");
  });

  it("handles mixed content", () => {
    const input = '<b>Bold</b> and <a href="https://x.com">link</a> with x &lt; 10';
    const result = stripHtmlToPlain(input);
    assert.equal(result, "Bold and link with x < 10");
  });
});
