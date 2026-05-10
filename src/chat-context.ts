import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeRead(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Pure formatter — wraps daily-journal + closures content into a chat-context
 * block. Returns empty string when both inputs are empty so the caller can
 * skip the prefix entirely.
 */
export function formatChatContext(journalContent: string, closuresContent: string): string {
  if (!journalContent && !closuresContent) return "";
  const parts: string[] = [
    "[CHAT CONTEXT — what scheduled tasks have surfaced today, plus what Mark confirmed today. Use to keep continuity with briefs / scouts / debriefs / brews that ran while this chat session may have been idle. If the user's message references something time-sensitive, anchor to this content first before searching elsewhere.]",
  ];
  if (closuresContent) {
    parts.push(`### Today's closures (facts Mark confirmed today)\n${closuresContent}`);
  }
  if (journalContent) {
    parts.push(`### Today's daily journal (scheduled task output)\n${journalContent}`);
  }
  parts.push("[END CHAT CONTEXT]");
  return parts.join("\n\n");
}

/**
 * Build the chat-context prefix injected ahead of every interactive Telegram
 * message. Closes the chat-session ↔ scheduled-task memory split: the chat
 * session sees what one-shots like morning-brief, brew, scout, and debrief
 * have written today, even if the chat session was started yesterday.
 *
 * `maxChars` is the TOTAL character budget across both sources. The budget
 * is split evenly: half for the journal slice, half for the closures slice.
 * Both get an ellipsis prefix when truncated. Default 4000 chars total
 * (≈ 1000 tokens) keeps cost bounded across long-running chat sessions
 * even on busy days with many closure events.
 */
export function buildChatContext(
  maxosHome: string,
  now: Date = new Date(),
  maxChars = 4000,
): string {
  const ymd = ymdLocal(now);
  const halfBudget = Math.floor(maxChars / 2);

  const journalPath = join(maxosHome, "workspace", "memory", `${ymd}.md`);
  const fullJournal = safeRead(journalPath);
  const journal = fullJournal.length > halfBudget
    ? "…" + fullJournal.slice(-halfBudget)
    : fullJournal;

  const closuresPath = join(maxosHome, "workspace", "memory", `closures-${ymd}.md`);
  const fullClosures = safeRead(closuresPath);
  const closures = fullClosures.length > halfBudget
    ? "…" + fullClosures.slice(-halfBudget)
    : fullClosures;

  return formatChatContext(journal, closures);
}
