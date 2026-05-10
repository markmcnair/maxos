import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One record per nightly training run. Contract: write a record EVERY
 * night the cron fires, including zero-correction nights. Pre-fix the
 * training task said "exit silently if no corrections" → no audit trail
 * → 3-week silent failure that bit Mark on 2026-05-05. The presence of
 * a row in this file IS the proof the cron fired.
 */
export interface TrainingRunRecord {
  /** YYYY-MM-DD of the day this training pertains to */
  date: string;
  /** ISO 8601 of when the training run started */
  ranAt: string;
  /** How many corrections the training found in the daily-log diff */
  correctionsFound: number;
  /** The corrections themselves — sender/subject/orig/corrected/rule */
  corrections: Array<{
    from: string;
    subject: string;
    originalBucket: string;
    correctedBucket: string;
    ruleAdded?: string;
  }>;
  /** Number of new rules added (proposed or active) */
  rulesAdded: number;
  /** Number of rules retired this run */
  rulesRetired: number;
  /** Whether the skill markdown was modified */
  skillUpdated: boolean;
  /**
   * Optional reason — useful when correctionsFound is 0 to distinguish
   * "no daily-log file" from "log present but no diff" from "everything
   * was correct."
   */
  reason?: string;
  /**
   * Round S+ Component 5: total emails triaged for the day. Lets the
   * precision-window calc derive bucket-level precision over time.
   * Older records (pre-Round-S) lack this field; precision excludes
   * them gracefully.
   */
  totalTriaged?: number;
  /**
   * Round S+ Component 5: per-bucket counts triaged on this day.
   * Combined with `corrections.originalBucket` totals, lets us compute
   * "of the N see-mails Max chose, M were corrected → precision".
   */
  totalsByBucket?: Partial<Record<"re-mail" | "see-mail" | "archive" | "delete", number>>;
  /**
   * Round S+ Component 5: how many emails were decided by a high-
   * confidence rule vs. by LLM fallback. Tracks the rule-coverage curve
   * — should grow week over week as rules accumulate.
   */
  ruleCoverage?: { ruleDecided: number; lowConfidenceRule: number; llmFallback: number };
}

function configDir(maxosOrUserHome: string): string {
  return join(maxosOrUserHome, ".config", "email-triage");
}

function trainingLogPath(home: string): string {
  return join(configDir(home), "training-runs.jsonl");
}

/**
 * Append a training-run record. Creates the directory + file as needed.
 * One JSON object per line, terminated with `\n`. Never throws on
 * already-exists; appends are atomic from the OS perspective.
 */
export function recordTrainingRun(home: string, record: TrainingRunRecord): void {
  const path = trainingLogPath(home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

const ONE_DAY_MS = 86400_000;

function isWithinDays(record: TrainingRunRecord, nowMs: number, days: number): boolean {
  const ts = Date.parse(record.ranAt);
  if (Number.isNaN(ts)) return false;
  return nowMs - ts <= days * ONE_DAY_MS;
}

/**
 * Read training-runs.jsonl, parse JSONL, return records within `days`
 * of `now`. Tolerant of malformed lines (skipped silently). Returns
 * empty array when file missing.
 */
export function loadRecentTrainingRuns(
  home: string,
  days: number,
  nowMs: number = Date.now(),
): TrainingRunRecord[] {
  const path = trainingLogPath(home);
  if (!existsSync(path)) return [];
  const out: TrainingRunRecord[] = [];
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isValidRecord(parsed)) continue;
      if (isWithinDays(parsed, nowMs, days)) out.push(parsed);
    }
  } catch {
    return [];
  }
  return out;
}

function isValidRecord(x: unknown): x is TrainingRunRecord {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.date === "string" &&
    typeof o.ranAt === "string" &&
    typeof o.correctionsFound === "number" &&
    Array.isArray(o.corrections) &&
    typeof o.rulesAdded === "number" &&
    typeof o.rulesRetired === "number" &&
    typeof o.skillUpdated === "boolean"
  );
}

export interface DigestSummary {
  runs: number;
  totalCorrections: number;
  totalRulesAdded: number;
  totalRulesRetired: number;
  lastRunDate: string | null;
  nightsSinceLastRun: number | null;
}

/**
 * Aggregate the last `windowDays` of training runs into a digest payload.
 * `nightsSinceLastRun` is the gap between today's date and the most
 * recent ran-at — surfaces "training has been silent for N nights"
 * which is the failure mode this whole telemetry layer exists to catch.
 */
export function summarizeForDigest(
  home: string,
  nowMs: number,
  windowDays: number = 30,
): DigestSummary {
  const records = loadRecentTrainingRuns(home, windowDays, nowMs);
  if (records.length === 0) {
    return {
      runs: 0,
      totalCorrections: 0,
      totalRulesAdded: 0,
      totalRulesRetired: 0,
      lastRunDate: null,
      nightsSinceLastRun: null,
    };
  }
  let totalCorrections = 0;
  let totalRulesAdded = 0;
  let totalRulesRetired = 0;
  let latestRanAtMs = 0;
  let latestDate = "";
  for (const r of records) {
    totalCorrections += r.correctionsFound;
    totalRulesAdded += r.rulesAdded;
    totalRulesRetired += r.rulesRetired;
    const ts = Date.parse(r.ranAt);
    if (!Number.isNaN(ts) && ts > latestRanAtMs) {
      latestRanAtMs = ts;
      latestDate = r.date;
    }
  }
  const nightsSinceLastRun = Math.floor((nowMs - latestRanAtMs) / ONE_DAY_MS);
  return {
    runs: records.length,
    totalCorrections,
    totalRulesAdded,
    totalRulesRetired,
    lastRunDate: latestDate || null,
    nightsSinceLastRun,
  };
}

/**
 * Format the one-line summary that goes into maxos-digest. Compact;
 * surfaces "training has been silent for N nights" prominently because
 * that's the failure mode we care about catching. Nothing about precision
 * here — that comes from the precision-window in component 5.
 */
export function formatDigestLine(s: DigestSummary): string {
  if (s.runs === 0 || s.lastRunDate === null) {
    return "email-triage training: no data yet (cron not yet fired or telemetry not landed)";
  }
  const gap = s.nightsSinceLastRun ?? 0;
  if (gap > 1) {
    // Stale: training hasn't run for more than one night
    return `email-triage training: STALE — ${gap} night(s) since last run on ${s.lastRunDate} (cron broken?)`;
  }
  return `email-triage training: ${s.runs} runs, ${s.totalCorrections} corrections, ${s.totalRulesAdded} rules added, ${s.totalRulesRetired} retired (last: ${s.lastRunDate})`;
}
