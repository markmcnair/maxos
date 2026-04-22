import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ChannelMessageLike {
  messageId: string;
  conversationId: string;
  text?: string;
  replyToId?: string;
  timestamp: number;
}

export interface ReplyLogEntry {
  ts: number;
  msgId: string;
  replyToId: string;
  conversationId: string;
  body: string;
}

export function logTelegramReply(msg: ChannelMessageLike, logPath: string): void {
  if (!msg.replyToId) return;
  const entry: ReplyLogEntry = {
    ts: msg.timestamp,
    msgId: msg.messageId,
    replyToId: msg.replyToId,
    conversationId: msg.conversationId,
    body: msg.text ?? "",
  };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}
