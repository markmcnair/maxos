import { homedir } from "node:os";
import { findMatchingRule, loadRules, type Rule, type EmailFeatures } from "./email-rule-store.js";
import type { BucketName } from "./email-signal-sweep.js";

/**
 * The decision returned per email. The `source` field tells the caller
 * how to use the result:
 *  - "rule"               → use the bucket directly, log ruleId. No LLM.
 *  - "rule-low-confidence" → use the bucket BUT mark as low-conf in log
 *                            (training task scrutinizes these later).
 *  - "llm-fallback"       → no high-confidence rule. Caller should ask
 *                            the LLM. Recorded as `novel: true` in log.
 */
export type DecisionSource = "rule" | "rule-low-confidence" | "llm-fallback";

export interface Decision {
  source: DecisionSource;
  bucket: BucketName | null;
  ruleId: string | null;
  confidence: number | null;
  novel: boolean;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.9;
const LOW_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Decide the bucket for an email using the rule store. Pure — no I/O.
 *
 * Decision tree:
 *   1. Find the best-matching rule (loadRules has already filtered out
 *      retired rules).
 *   2. If no match → llm-fallback.
 *   3. If match is `proposed` → rule-low-confidence regardless of conf
 *      (proposed rules haven't earned active status).
 *   4. If match is `active` and confidence >= 0.9 → rule.
 *   5. If match is `active` and confidence in [0.7, 0.9) → rule-low-confidence.
 *   6. Otherwise → llm-fallback.
 *
 * The asymmetry from the spec's "false-positive see-mail > false-negative
 * delete" lives at the rule confidence level: training keeps delete-rule
 * confidences higher (slower to promote into active) than see-mail rules.
 */
export function decideBucketFromRules(
  email: EmailFeatures,
  rules: Rule[],
): Decision {
  const match = findMatchingRule(rules, email);
  if (!match) {
    return { source: "llm-fallback", bucket: null, ruleId: null, confidence: null, novel: true };
  }
  if (match.status === "proposed") {
    return {
      source: "rule-low-confidence",
      bucket: match.action,
      ruleId: match.id,
      confidence: match.confidence,
      novel: false,
    };
  }
  if (match.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return {
      source: "rule",
      bucket: match.action,
      ruleId: match.id,
      confidence: match.confidence,
      novel: false,
    };
  }
  if (match.confidence >= LOW_CONFIDENCE_THRESHOLD) {
    return {
      source: "rule-low-confidence",
      bucket: match.action,
      ruleId: match.id,
      confidence: match.confidence,
      novel: false,
    };
  }
  return { source: "llm-fallback", bucket: null, ruleId: null, confidence: null, novel: true };
}

// ───── CLI ─────

const isCLI = process.argv[1]?.endsWith("email-triage-decide.js");
if (isCLI) {
  const argv = process.argv;
  const i = (flag: string) => {
    const x = argv.indexOf(flag);
    return x >= 0 ? argv[x + 1] : null;
  };
  const from = i("--from");
  const subject = i("--subject") ?? "";
  if (!from) {
    console.error("usage: email-triage-decide.js --from '<addr>' [--subject '<subj>']");
    process.exit(2);
  }
  const home = process.env.HOME ?? homedir();
  const store = loadRules(home);
  const decision = decideBucketFromRules({ from, subject }, store.rules);
  console.log(JSON.stringify(decision));
}
