import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OutboundEvent {
  ts: number;
  task?: string;
  conversationId: string;
  chunkCount: number;
  totalChars: number;
  durationMs: number;
  status: "ok" | "failed";
  error?: string;
  retried?: boolean;
}

/**
 * Append an outbound event to the JSONL log. Best-effort — never throws back
 * to the caller, since we don't want monitoring to break the actual send path.
 */
export function logOutboundEvent(path: string, event: OutboundEvent): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + "\n");
  } catch {
    // swallow — outbound logging must never block the actual send path
  }
}

export interface OutboundSummary {
  total: number;
  ok: number;
  failed: number;
  retried: number;
  successRate: number; // 0..1
  totalChars: number;
  averageDurationMs: number;
  /** Last failure event, if any, in this window. */
  lastFailure?: OutboundEvent;
}

/**
 * Pure summarizer — given a set of JSONL lines from the outbound log,
 * compute aggregate stats for the events whose ts falls in [since, until].
 */
export function summarizeOutbound(
  linesContent: string,
  since: number,
  until: number = Date.now(),
): OutboundSummary {
  const events: OutboundEvent[] = [];
  for (const line of linesContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as OutboundEvent;
      if (typeof ev.ts !== "number") continue;
      if (ev.ts < since || ev.ts > until) continue;
      events.push(ev);
    } catch {
      continue;
    }
  }
  const ok = events.filter((e) => e.status === "ok");
  const failed = events.filter((e) => e.status === "failed");
  const retried = events.filter((e) => e.retried).length;
  const totalChars = events.reduce((a, e) => a + (e.totalChars || 0), 0);
  const totalMs = events.reduce((a, e) => a + (e.durationMs || 0), 0);
  const lastFailure = failed.sort((a, b) => b.ts - a.ts)[0];
  return {
    total: events.length,
    ok: ok.length,
    failed: failed.length,
    retried,
    successRate: events.length === 0 ? 1 : ok.length / events.length,
    totalChars,
    averageDurationMs: events.length === 0 ? 0 : Math.round(totalMs / events.length),
    lastFailure,
  };
}

/**
 * Read the JSONL log from disk and summarize. Tolerates missing file.
 */
export function readAndSummarize(path: string, since: number, until?: number): OutboundSummary {
  if (!existsSync(path)) {
    return {
      total: 0, ok: 0, failed: 0, retried: 0, successRate: 1,
      totalChars: 0, averageDurationMs: 0,
    };
  }
  const content = readFileSync(path, "utf-8");
  return summarizeOutbound(content, since, until);
}
