import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface OutboundRecord {
  task: string;
  messageId: string;
  ts: number;
}

export function recordOutboundId(path: string, rec: OutboundRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}

export function findLatestForTask(
  _path: string,
  task: string,
  linesContent: string,
): OutboundRecord | null {
  let latest: OutboundRecord | null = null;
  for (const line of linesContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as OutboundRecord;
      if (r.task === task && (!latest || r.ts > latest.ts)) latest = r;
    } catch { continue; }
  }
  return latest;
}
