import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CoveredEntry {
  date: string;
  url: string;
  keywords: string[];
}

export function parseCoveredLog(md: string): CoveredEntry[] {
  const entries: CoveredEntry[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\d{4}-\d{2}-\d{2})\s+·\s+(\S+)\s+·\s+\[([^\]]+)\]/);
    if (!match) continue;
    entries.push({
      date: match[1],
      url: match[2],
      keywords: match[3].split(",").map(s => s.trim().toLowerCase()),
    });
  }
  return entries;
}

export function isNearMatch(
  candidateUrl: string,
  candidateKeywords: string[],
  entries: CoveredEntry[],
): boolean {
  const cks = new Set(candidateKeywords.map(s => s.toLowerCase()));
  for (const e of entries) {
    if (e.url === candidateUrl) return true;
    const overlap = e.keywords.filter(k => cks.has(k)).length;
    if (overlap >= 2) return true;
  }
  return false;
}

export function readCoveredLog(path: string): CoveredEntry[] {
  if (!existsSync(path)) return [];
  return parseCoveredLog(readFileSync(path, "utf-8"));
}

export function appendCovered(path: string, entry: CoveredEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${entry.date} · ${entry.url} · [${entry.keywords.join(", ")}]\n`;
  appendFileSync(path, line);
}
