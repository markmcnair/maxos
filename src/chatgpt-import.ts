import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Partial ChatGPT conversation-export schema — only the fields we touch.
 * OpenAI's actual export is larger; we ignore everything else.
 */
export interface ChatGPTMessage {
  id: string;
  author?: { role?: string };
  create_time?: number | null;
  content?: { content_type?: string; parts?: unknown[] };
}

export interface ChatGPTNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

export interface ChatGPTConversation {
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  conversation_id?: string;
  default_model_slug?: string;
  is_archived?: boolean;
  mapping?: Record<string, ChatGPTNode>;
  current_node?: string;
}

export interface ParseOptions {
  skipArchived?: boolean;
}

export interface ExportResult {
  filesWritten: number;
  skipped: number;
  outDir: string;
}

/**
 * Validate that the entry has the minimum shape of a real conversation.
 * Malformed entries (e.g. from truncated exports) are filtered out silently.
 */
function isValidConversation(c: unknown): c is ChatGPTConversation {
  if (!c || typeof c !== "object") return false;
  const obj = c as Record<string, unknown>;
  if (!obj.mapping || typeof obj.mapping !== "object") return false;
  if (typeof obj.current_node !== "string") return false;
  return true;
}

export function parseChatGPTExport(
  raw: unknown[],
  options: ParseOptions = {},
): ChatGPTConversation[] {
  const out: ChatGPTConversation[] = [];
  for (const entry of raw) {
    if (!isValidConversation(entry)) continue;
    if (options.skipArchived && entry.is_archived) continue;
    out.push(entry);
  }
  return out;
}

function extractText(message: ChatGPTMessage | null | undefined): string {
  if (!message) return "";
  const parts = message.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p === "string" ? p : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function roleLabel(role: string | undefined): string | null {
  switch (role) {
    case "user": return "**You:**";
    case "assistant": return "**GPT:**";
    case "system": return "**System:**";
    case "tool": return "**Tool:**";
    default: return null;
  }
}

/**
 * Walk the conversation from root → current_node via parent pointers.
 * Returns messages in chronological order, main-path only (ignoring
 * regenerated / branched-off siblings).
 */
function linearMessages(conv: ChatGPTConversation): ChatGPTNode[] {
  const mapping = conv.mapping ?? {};
  const current = conv.current_node;
  if (!current || !mapping[current]) return [];
  const chain: ChatGPTNode[] = [];
  let cursor: string | null = current;
  const seen = new Set<string>();
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(mapping[cursor]);
    cursor = mapping[cursor].parent;
  }
  return chain.reverse();
}

function ymdFromEpoch(sec: number | null | undefined): { y: string; m: string; d: string } {
  const t = typeof sec === "number" && sec > 0 ? sec * 1000 : Date.now();
  const dt = new Date(t);
  return {
    y: String(dt.getFullYear()),
    m: String(dt.getMonth() + 1).padStart(2, "0"),
    d: String(dt.getDate()).padStart(2, "0"),
  };
}

function resolveTitle(conv: ChatGPTConversation): string {
  const t = (conv.title ?? "").trim();
  if (t && t.toLowerCase() !== "untitled conversation" && t.toLowerCase() !== "new chat") {
    return t;
  }
  // Fall back to date + first user-message preview
  const msgs = linearMessages(conv);
  const firstUser = msgs.find((n) => n.message?.author?.role === "user");
  const preview = extractText(firstUser?.message).slice(0, 50).replace(/\s+/g, " ").trim();
  const { y, m, d } = ymdFromEpoch(conv.create_time);
  return preview ? `${y}-${m}-${d} ${preview}` : `${y}-${m}-${d} untitled`;
}

export function conversationToMarkdown(conv: ChatGPTConversation): string {
  const title = resolveTitle(conv);
  const { y, m, d } = ymdFromEpoch(conv.create_time);
  const msgs = linearMessages(conv);
  const renderable = msgs.filter((n) => {
    const role = n.message?.author?.role;
    const text = extractText(n.message);
    if (!role) return false;
    if (!text) return false;  // skip empty content (including empty system stubs)
    return true;
  });

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `date: ${y}-${m}-${d}`,
    `conversation_id: ${conv.conversation_id ?? "unknown"}`,
    `message_count: ${renderable.length}`,
    `model: ${conv.default_model_slug ?? "unknown"}`,
    `source: chatgpt-export`,
    "---",
    "",
    `# ${title}`,
    "",
  ].join("\n");

  const body = renderable
    .map((n) => {
      const label = roleLabel(n.message?.author?.role);
      if (!label) return null;
      const text = extractText(n.message);
      return `${label}\n\n${text}\n`;
    })
    .filter(Boolean)
    .join("\n");

  return frontmatter + body;
}

export function slugForFilename(title: string): string {
  const cleaned = (title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")  // strip combining marks
    .replace(/['\u2018\u2019]/g, "")  // drop apostrophes entirely ("what's" → "whats")
    .replace(/[^a-zA-Z0-9\s-]/g, " ") // other non-alphanumeric → space (also strips emoji)
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const truncated = cleaned.slice(0, 80).replace(/-+$/g, "");
  return truncated || "conversation";
}

export interface CustomInstructions {
  content: string;
  occurrences: number;
}

const MIN_CI_LENGTH = 100;

/**
 * Look at the first system message of every conversation and return the
 * most common non-trivial one. ChatGPT injects the user's custom
 * instructions as a system message at the top of EVERY conversation, so
 * if a substantive system message appears in N conversations and N is
 * material, it's almost certainly the user's custom instructions.
 */
export function extractCustomInstructions(
  conversations: ChatGPTConversation[],
): CustomInstructions | null {
  const counts = new Map<string, number>();
  for (const conv of conversations) {
    const mapping = conv.mapping ?? {};
    // Find the first system message in the chain (walk forward from root).
    // Tree has a single "root" node whose children contain the head of the chain.
    let current: string | undefined;
    for (const [id, node] of Object.entries(mapping)) {
      if (node.parent === null && node.message === null) {
        // This is the pseudo-root; its first child starts the real chain.
        current = node.children[0];
        break;
      }
    }
    // Walk forward until we find a system message with text or give up.
    let steps = 0;
    while (current && mapping[current] && steps < 5) {
      const node = mapping[current];
      const role = node.message?.author?.role;
      const text = extractText(node.message);
      if (role === "system" && text.length >= MIN_CI_LENGTH) {
        counts.set(text, (counts.get(text) ?? 0) + 1);
        break;
      }
      // Not a substantive system message — move to next child.
      current = node.children[0];
      steps++;
    }
  }

  if (counts.size === 0) return null;

  // Pick the content with the highest occurrence count.
  let bestContent = "";
  let bestCount = 0;
  for (const [content, count] of counts) {
    if (count > bestCount) {
      bestContent = content;
      bestCount = count;
    }
  }

  // Require at least 2 occurrences to count as custom instructions —
  // single-conversation system messages are more likely to be one-offs.
  if (bestCount < 2) return null;

  return { content: bestContent, occurrences: bestCount };
}

/**
 * Format custom instructions for appending to USER.md. Strips the
 * generic ChatGPT preamble so the user sees just their actual profile.
 */
export function formatCustomInstructionsBlock(ci: CustomInstructions): string {
  let content = ci.content;

  // Strip OpenAI's standard preamble. It starts with "The user provided..."
  // and ends with something like "Here are the user's custom instructions:".
  const marker = /Here (?:are|is) the user['']?s custom instructions?:?\s*/i;
  const match = content.match(marker);
  if (match && match.index !== undefined) {
    content = content.slice(match.index + match[0].length).trim();
  } else {
    // Fallback preamble strip — anything before the first bullet / first blank line
    const blank = content.indexOf("\n\n");
    if (blank > 0 && blank < 400) {
      content = content.slice(blank + 2).trim();
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return [
    "",
    `## Imported from ChatGPT (${today})`,
    "",
    `Derived from the custom-instructions system message present in ${ci.occurrences} conversations. Review and edit as needed — treat this as a starting point, not gospel.`,
    "",
    content,
    "",
  ].join("\n");
}

export async function exportToFiles(
  raw: unknown[],
  outDir: string,
): Promise<ExportResult> {
  const conversations = parseChatGPTExport(raw, { skipArchived: true });
  const skipped = raw.length - conversations.length;
  const usedNames = new Set<string>();
  let filesWritten = 0;

  for (const conv of conversations) {
    const { y, m } = ymdFromEpoch(conv.create_time);
    const dir = join(outDir, y, m);
    mkdirSync(dir, { recursive: true });

    let slug = slugForFilename(resolveTitle(conv));
    let filename = `${slug}.md`;
    if (usedNames.has(join(dir, filename))) {
      const short = (conv.conversation_id ?? String(filesWritten)).slice(0, 8);
      filename = `${slug}-${short}.md`;
    }
    const path = join(dir, filename);
    usedNames.add(path);

    writeFileSync(path, conversationToMarkdown(conv), "utf-8");
    filesWritten++;
  }

  return { filesWritten, skipped, outDir };
}
