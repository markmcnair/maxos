import { existsSync, readFileSync } from "node:fs";
import type { ReplyLogEntry } from "./telegram-reply-logger.js";

export type ReplyChoice = "continue" | "switch" | "ambiguous";

export function classifyReply(body: string): ReplyChoice {
  const t = body.trim().toLowerCase();
  if (!t) return "ambiguous";
  if (/^(a\b|continue|yes|go|keep)/i.test(t)) return "continue";
  if (/^(b\b|new|switch|change)/i.test(t)) return "switch";
  return "ambiguous";
}

export function findReplyTo(path: string, targetMsgId: string): ReplyLogEntry | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  let latest: ReplyLogEntry | null = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ReplyLogEntry;
      if (entry.replyToId === targetMsgId) {
        if (!latest || entry.ts > latest.ts) latest = entry;
      }
    } catch {
      continue;
    }
  }
  return latest;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const msgId = process.argv[2];
  const path = process.argv[3] ?? `${process.env.HOME}/.maxos/workspace/memory/telegram-replies.jsonl`;
  if (!msgId) {
    console.error("usage: brew-reply-parser <msgId> [path]");
    process.exit(1);
  }
  const reply = findReplyTo(path, msgId);
  if (!reply) {
    console.log(JSON.stringify({ found: false }));
  } else {
    console.log(JSON.stringify({ found: true, choice: classifyReply(reply.body), body: reply.body, ts: reply.ts }));
  }
}
