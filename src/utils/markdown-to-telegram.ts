/**
 * Convert Claude's Markdown output to Telegram-compatible HTML.
 *
 * Telegram supports a limited subset of HTML:
 *   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">, <blockquote>
 *
 * Claude outputs standard Markdown:
 *   **bold**, *italic*, `code`, ```code blocks```, [text](url),
 *   # headers, > blockquotes, - lists
 *
 * This is intentionally simple — handles the common cases Claude actually
 * produces, not a full Markdown parser. Deterministic, no dependencies.
 */
export function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Code blocks first (before any inline processing)
  // ```lang\ncode\n``` → <pre><code>code</code></pre>
  html = html.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_match, code: string) => {
    return `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`;
  });

  // Inline code: `code` → <code>code</code>
  // Must run before bold/italic to avoid conflicts
  html = html.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Bold+italic: ***text*** or ___text___
  html = html.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");

  // Bold: **text**
  html = html.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");

  // Italic: *text* (but not inside words like file*name)
  html = html.replace(/(?<!\w)\*([^\s*][^*]*?)\*(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) → <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headers: # text → <b>text</b> (Telegram has no headers, just bold them)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Blockquotes: > text → <blockquote>text</blockquote>
  // Collapse consecutive > lines into one blockquote
  html = html.replace(/(?:^>\s?(.*)$\n?)+/gm, (match) => {
    const lines = match.split("\n")
      .map(l => l.replace(/^>\s?/, ""))
      .filter(l => l.trim() !== "" || l === "");
    return `<blockquote>${lines.join("\n").trim()}</blockquote>\n`;
  });

  // Horizontal rules: --- or *** → just a line
  html = html.replace(/^(?:[-*_]){3,}\s*$/gm, "—————");

  // Clean up excessive blank lines (Telegram renders them as gaps)
  html = html.replace(/\n{3,}/g, "\n\n");

  return html.trim();
}

/** Escape HTML entities inside code blocks */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
