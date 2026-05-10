import { existsSync, readFileSync } from "node:fs";
import { findOutboundForMessageId, type OutboundRecord } from "./brew-outbound-capture.js";
import { classifyReply, type ReplyChoice } from "./brew-reply-parser.js";

export interface ReplyContextInput {
  replyToId?: string;
  text?: string;
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Pure formatter — produces the [REPLY CONTEXT: ...] block from already-resolved
 * inputs. Tested directly. The block is what the chat session reads to know
 * (a) it's looking at a reply, (b) which task originated, (c) the classified
 * intent, and (d) NOT to echo the body as a wake-word.
 */
export function formatReplyContext(
  replyText: string,
  intent: ReplyChoice,
  outbound: OutboundRecord | null,
  dateStr: string,
): string {
  const replyBody = replyText.trim();

  if (!outbound) {
    return [
      `[REPLY CONTEXT: This Telegram message is a reply to a previous message of yours, but no matching outbound task record was found.`,
      `Reply body: "${replyBody}". Classified intent: ${intent}.`,
      `Read today's daily journal (memory/${dateStr}.md) to figure out what the user is responding to.`,
      `Do NOT echo "${replyBody}" back as a wake-word — interpret it as a continuation of an earlier exchange.]`,
    ].join(" ");
  }

  return [
    `[REPLY CONTEXT: This Telegram message is a reply to a "${outbound.task}" message you sent at ${dateStr}.`,
    `Reply body: "${replyBody}". Classified intent: ${intent}.`,
    `Read memory/${dateStr}.md for the original task output.`,
    `Do NOT echo "${replyBody}" back as a wake-word — respond to the user's choice in the context of the original ${outbound.task}.]`,
  ].join(" ");
}

/**
 * Wrapper that loads outbound-ids.jsonl from disk and produces the context
 * block. Returns empty string when the message is not a reply or has no body.
 *
 * The "now" parameter is used when no matching outbound record is found,
 * so the context still points to *today's* journal.
 */
export function buildReplyContext(
  msg: ReplyContextInput,
  outboundPath: string,
  now: Date = new Date(),
): string {
  if (!msg.replyToId || !msg.text?.trim()) return "";

  const linesContent = existsSync(outboundPath) ? readFileSync(outboundPath, "utf-8") : "";
  const outbound = linesContent
    ? findOutboundForMessageId(linesContent, msg.replyToId)
    : null;

  const intent = classifyReply(msg.text);
  const dateStr = outbound ? ymdLocal(new Date(outbound.ts)) : ymdLocal(now);

  return formatReplyContext(msg.text, intent, outbound, dateStr);
}
