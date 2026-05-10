import { loadRecentTrainingRuns, type TrainingRunRecord } from "./email-triage-telemetry.js";
import type { BucketName } from "./email-signal-sweep.js";

export interface BucketStats {
  triaged: number;
  corrected: number;
  precision: number; // 0..1; (triaged - corrected) / triaged
}

export interface PrecisionWindow {
  insufficient: boolean;        // true when window has < 1 usable run
  totalEmails: number;          // sum of totalTriaged over usable runs
  totalCorrections: number;     // sum of correctionsFound
  windowDays: number;
  byBucket: Partial<Record<BucketName, BucketStats>>;
  ruleCoverage: {
    ruleDecided: number;
    lowConfidenceRule: number;
    llmFallback: number;
  };
}

const ALL_BUCKETS: BucketName[] = ["re-mail", "see-mail", "archive", "delete"];

/**
 * Compute precision metrics over the last `days` of training runs.
 *
 * Inputs (read from disk):
 *  - training-runs.jsonl — one record per nightly training run
 *
 * Methodology:
 *  Per record, totalsByBucket gives "of the N emails Max put in bucket X
 *  today, how many were corrected by signals?" The precision-window
 *  aggregates these across the lookback window.
 *
 *  Records lacking totalTriaged (pre-Round-S) are excluded from precision
 *  computation but still counted toward `runs` in the digest summary.
 *  Backward-compat without polluting the precision math.
 *
 * Output:
 *  - byBucket: per-bucket triaged + corrected + precision
 *  - ruleCoverage: how many emails were decided by rule vs LLM
 *  - insufficient flag for "<1 usable run" (no precision can be computed)
 */
export function computePrecisionWindow(
  home: string,
  nowMs: number,
  days: number = 30,
): PrecisionWindow {
  const records = loadRecentTrainingRuns(home, days, nowMs);
  const usable = records.filter((r) => typeof r.totalTriaged === "number");
  if (usable.length === 0) {
    return {
      insufficient: true,
      totalEmails: 0,
      totalCorrections: 0,
      windowDays: days,
      byBucket: {},
      ruleCoverage: { ruleDecided: 0, lowConfidenceRule: 0, llmFallback: 0 },
    };
  }

  const byBucket: Partial<Record<BucketName, BucketStats>> = {};
  for (const b of ALL_BUCKETS) {
    byBucket[b] = { triaged: 0, corrected: 0, precision: 1 };
  }
  let totalEmails = 0;
  let totalCorrections = 0;
  const ruleCoverage = { ruleDecided: 0, lowConfidenceRule: 0, llmFallback: 0 };

  for (const r of usable) {
    totalEmails += r.totalTriaged ?? 0;
    totalCorrections += r.correctionsFound;
    if (r.totalsByBucket) {
      for (const b of ALL_BUCKETS) {
        const n = r.totalsByBucket[b] ?? 0;
        byBucket[b]!.triaged += n;
      }
    }
    // Tally corrections by ORIGINAL bucket — that's what Max chose, which
    // is what's being measured for precision.
    for (const c of r.corrections) {
      const b = c.originalBucket as BucketName;
      if (byBucket[b]) byBucket[b]!.corrected += 1;
    }
    if (r.ruleCoverage) {
      ruleCoverage.ruleDecided += r.ruleCoverage.ruleDecided;
      ruleCoverage.lowConfidenceRule += r.ruleCoverage.lowConfidenceRule;
      ruleCoverage.llmFallback += r.ruleCoverage.llmFallback;
    }
  }

  // Compute precision per bucket
  for (const b of ALL_BUCKETS) {
    const s = byBucket[b]!;
    s.precision = s.triaged > 0 ? (s.triaged - s.corrected) / s.triaged : 1;
  }

  return {
    insufficient: false,
    totalEmails,
    totalCorrections,
    windowDays: days,
    byBucket,
    ruleCoverage,
  };
}

/**
 * Format the precision metrics as a one-line digest entry. Compact:
 * shows precision per non-re-mail bucket (re-mail is out of scope for
 * autonomy) plus rule-coverage percentage.
 *
 * Example output:
 *   "30d precision · see-mail 96% · archive 99% · delete 92% · rules 75/100 (75%)"
 */
export function formatPrecisionDigestLine(w: PrecisionWindow): string {
  if (w.insufficient || w.totalEmails === 0) {
    return `email-triage precision: insufficient data (no usable training runs in last ${w.windowDays}d)`;
  }
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const parts: string[] = [`${w.windowDays}d precision`];
  for (const b of ["see-mail", "archive", "delete"] as BucketName[]) {
    const s = w.byBucket[b];
    if (s && s.triaged > 0) {
      parts.push(`${b} ${pct(s.precision)} (${s.corrected}/${s.triaged} corrected)`);
    }
  }
  const totalCovered = w.ruleCoverage.ruleDecided + w.ruleCoverage.lowConfidenceRule;
  if (w.totalEmails > 0) {
    parts.push(`rules ${totalCovered}/${w.totalEmails} (${pct(totalCovered / w.totalEmails)})`);
  }
  return parts.join(" · ");
}
