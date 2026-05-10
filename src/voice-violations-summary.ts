import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceViolation, VoiceViolationLogEntry } from "./voice-violations.js";

export interface ViolationsSummary {
  windowHours: number;
  totalEntries: number;
  totalViolations: number;
  byCategory: Record<string, number>;
  byPattern: Array<{ pattern: string; category: string; count: number }>;
  byTask: Record<string, number>;
  cleanRate: number;
}

/**
 * Aggregate JSONL violation entries within `[since, until]` into a summary.
 * Pure — caller passes content, no FS access. Tested directly.
 */
export function summarizeViolations(
  linesContent: string,
  since: number,
  until: number = Date.now(),
): ViolationsSummary {
  const entries: VoiceViolationLogEntry[] = [];
  for (const line of linesContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as VoiceViolationLogEntry;
      if (typeof e.ts !== "number") continue;
      if (e.ts < since || e.ts > until) continue;
      entries.push(e);
    } catch {
      continue;
    }
  }

  const byCategory: Record<string, number> = {};
  const byPatternMap = new Map<string, { count: number; category: string }>();
  const byTask: Record<string, number> = {};
  let totalViolations = 0;

  for (const entry of entries) {
    totalViolations += entry.violationCount;
    const taskKey = entry.task ?? "(unknown)";
    byTask[taskKey] = (byTask[taskKey] ?? 0) + entry.violationCount;
    for (const v of entry.violations) {
      byCategory[v.category] = (byCategory[v.category] ?? 0) + 1;
      const key = `${v.category}|${v.pattern}`;
      const existing = byPatternMap.get(key);
      if (existing) existing.count++;
      else byPatternMap.set(key, { count: 1, category: v.category });
    }
  }

  const byPattern = [...byPatternMap.entries()]
    .map(([key, val]) => {
      const [, ...patternParts] = key.split("|");
      return { pattern: patternParts.join("|"), category: val.category, count: val.count };
    })
    .sort((a, b) => b.count - a.count);

  return {
    windowHours: Math.round((until - since) / (1000 * 60 * 60)),
    totalEntries: entries.length,
    totalViolations,
    byCategory,
    byPattern,
    byTask,
    cleanRate: 0, // computed by caller using separate "total sends" count, if available
  };
}

/**
 * Render a violations summary as a human-readable block. Compact enough for
 * a Telegram message; the doctor invokes this via an extra subcommand.
 */
export function formatSummary(s: ViolationsSummary): string {
  const lines: string[] = [];
  lines.push(`Voice violations summary — last ${s.windowHours}h:`);
  lines.push(`  ${s.totalEntries} flagged outbound(s), ${s.totalViolations} violation(s)`);
  if (s.totalEntries === 0) {
    lines.push(`  (clean window)`);
    return lines.join("\n");
  }
  lines.push("");
  lines.push("By category:");
  for (const [cat, n] of Object.entries(s.byCategory).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${cat.padEnd(14)} ${n}`);
  }
  if (s.byPattern.length > 0) {
    lines.push("");
    lines.push("Top patterns:");
    for (const p of s.byPattern.slice(0, 10)) {
      lines.push(`  ${String(p.count).padStart(3)} × [${p.category}] "${p.pattern}"`);
    }
  }
  if (Object.keys(s.byTask).length > 0) {
    lines.push("");
    lines.push("By task:");
    for (const [task, n] of Object.entries(s.byTask).sort((a, b) => b[1] - a[1])) {
      const pretty = task === "(unknown)" ? "(interactive chat)" : task;
      lines.push(`  ${String(n).padStart(3)} × ${pretty}`);
    }
  }
  return lines.join("\n");
}

const isCLI = process.argv[1]?.endsWith("voice-violations-summary.js");
if (isCLI) {
  const maxosHome = process.env.MAXOS_HOME || `${process.env.HOME}/.maxos`;
  const path = join(maxosHome, "workspace", "memory", "voice-violations.jsonl");
  if (!existsSync(path)) {
    console.log("Voice violations summary: no log yet (clean or no outbound recorded).");
    process.exit(0);
  }
  const hoursArg = process.argv.indexOf("--hours");
  const hours = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) : 24;
  const since = Date.now() - hours * 3_600_000;
  const summary = summarizeViolations(readFileSync(path, "utf-8"), since);
  console.log(formatSummary(summary));
}
