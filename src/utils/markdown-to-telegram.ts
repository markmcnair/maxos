/**
 * Convert Claude's Markdown output to Telegram-compatible HTML.
 *
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">, <blockquote>
 *
 * Order of operations matters:
 * 1. Extract code blocks and inline code (preserve them verbatim)
 * 2. Escape <, >, & in ALL remaining text (prevents "can't parse entities" errors)
 * 3. Apply Markdown→HTML transforms (produces real HTML tags on escaped text)
 * 4. Restore code blocks
 */
export function markdownToTelegramHtml(md: string): string {
  // Step 1: Extract code blocks and inline code into placeholders
  const codeBlocks: string[] = [];
  let html = md;

  // Fenced code blocks: ```lang\ncode\n```
  html = html.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Inline code: `code`
  html = html.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Step 2: Escape <, >, & in everything that's NOT inside a code placeholder
  html = escapeHtml(html);

  // Step 3: Apply Markdown→HTML transforms (these produce real tags)

  // Bold+italic: ***text***
  html = html.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");

  // Bold: **text**
  html = html.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");

  // Italic: *text* (not inside words)
  html = html.replace(/(?<!\w)\*([^\s*][^*]*?)\*(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) — URL was escaped, need to unescape &amp; back to & for href
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    return `<a href="${url.replace(/&amp;/g, '&')}">${text}</a>`;
  });

  // Headers: # text → <b>text</b>
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Blockquotes: > lines → <blockquote>
  html = html.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
    const lines = match.split("\n")
      .map(l => l.replace(/^&gt;\s?/, ""))
      .filter(l => l.trim() !== "" || l === "");
    return `<blockquote>${lines.join("\n").trim()}</blockquote>\n`;
  });

  // Horizontal rules: --- or ***
  html = html.replace(/^(?:[-*_]){3,}\s*$/gm, "—————");

  // Step 4: Restore code blocks
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx: string) => {
    return codeBlocks[parseInt(idx, 10)];
  });

  // Clean up excessive blank lines
  html = html.replace(/\n{3,}/g, "\n\n");

  return html.trim();
}

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Strip HTML tags and unescape entities — for plain text fallback */
export function stripHtmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}
