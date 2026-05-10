import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BucketName } from "./email-signal-sweep.js";

// ───── Schema ─────

export type RuleStatus = "proposed" | "active" | "retired";

export type RuleKind = "sender_pattern" | "subject_pattern" | "sender_subject_pattern";

export interface Rule {
  id: string;
  kind: RuleKind;
  pattern: {
    sender_regex?: string;
    subject_regex?: string;
  };
  action: BucketName;
  confidence: number;        // 0..1
  status: RuleStatus;
  stats: {
    triggers: number;
    kept_count: number;
    corrected_count: number;
    last_triggered?: string;  // ISO 8601
  };
  created_at: string;         // ISO 8601 or YYYY-MM-DD
  created_from: string;       // e.g. "training-2026-05-05" or "manual"
  notes?: string;
}

export interface RuleStore {
  version: number;
  rules: Rule[];
}

export interface EmailFeatures {
  from: string;
  subject: string;
}

// ───── Confidence math ─────

const CONFIDENCE_LIFT_FACTOR = 0.5; // each `kept` adds 0.5 * (1 - c) — diminishing toward 1
const CONFIDENCE_DROP = 0.3;        // each `corrected` subtracts a flat 0.3

/**
 * Apply a confidence adjustment for a single signal. `kept` raises with
 * diminishing returns toward 1.0; `corrected` drops by a fixed amount,
 * clamped at 0. Pure — heavily property-tested.
 */
export function applyConfidenceDelta(
  current: number,
  signal: "kept" | "corrected",
): number {
  if (signal === "kept") {
    const next = current + CONFIDENCE_LIFT_FACTOR * (1 - current);
    return Math.min(1, next);
  }
  return Math.max(0, current - CONFIDENCE_DROP);
}

// ───── Persistence ─────

function rulesPath(home: string): string {
  return join(home, ".config", "email-triage", "rules.json");
}

/**
 * Read rules.json from disk. Returns an empty store when file is missing
 * or malformed (so a corrupt file doesn't crash the daemon — same defense
 * as the Round Q google-tasks-state guard). Filters out individual
 * malformed rules silently.
 */
export function loadRules(home: string): RuleStore {
  const path = rulesPath(home);
  if (!existsSync(path)) return { version: 1, rules: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object") return { version: 1, rules: [] };
    const o = raw as Record<string, unknown>;
    const rules = Array.isArray(o.rules) ? o.rules.filter(isValidRule) : [];
    return { version: typeof o.version === "number" ? o.version : 1, rules };
  } catch {
    return { version: 1, rules: [] };
  }
}

function isValidRule(x: unknown): x is Rule {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.kind === "string" &&
    typeof o.pattern === "object" &&
    typeof o.action === "string" &&
    typeof o.confidence === "number" &&
    typeof o.status === "string" &&
    typeof o.stats === "object" &&
    typeof o.created_at === "string" &&
    typeof o.created_from === "string"
  );
}

/**
 * Save rules.json atomically (temp+rename so concurrent readers never see
 * a half-written file). Creates dir as needed.
 */
export function saveRules(home: string, store: RuleStore): void {
  const path = rulesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* may not exist */ }
    throw err;
  }
}

// ───── Matching ─────

/**
 * Parse a Python-style inline flag prefix `(?i)`, `(?im)`, etc. and
 * convert to JS RegExp constructor flags. JS doesn't support inline
 * flags natively, but rules authored by humans (or LLMs trained on
 * Python regex) commonly use them. Returns `{ source, flags }`.
 */
export function parseInlineFlags(pattern: string): { source: string; flags: string } {
  const m = pattern.match(/^\(\?([imsux]+)\)/);
  if (!m) return { source: pattern, flags: "" };
  // JS supports: i, m, s, u — drop x (extended) since JS doesn't support it
  const flags = m[1].replace(/[^imsu]/g, "");
  return { source: pattern.slice(m[0].length), flags };
}

function tryRegex(pattern: string | undefined, haystack: string): boolean {
  if (!pattern) return true; // no pattern = no constraint
  try {
    const { source, flags } = parseInlineFlags(pattern);
    return new RegExp(source, flags).test(haystack);
  } catch {
    return false; // invalid regex = no match (don't crash)
  }
}

function matchesEmail(rule: Rule, email: EmailFeatures): boolean {
  if (rule.status === "retired") return false;
  const senderOk = tryRegex(rule.pattern.sender_regex, email.from);
  const subjectOk = tryRegex(rule.pattern.subject_regex, email.subject);
  // Both regexes must pass; absent regex = pass
  return senderOk && subjectOk;
}

function lastTriggeredMs(rule: Rule): number {
  const t = rule.stats.last_triggered;
  if (!t) return 0;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Find the best-matching rule for the given email. Highest confidence
 * wins; ties broken by most recent last_triggered. Retired rules are
 * skipped. Proposed rules ARE considered (caller decides what to do
 * with a proposed-rule match — log it, but maybe don't auto-trust).
 *
 * Returns null when no rule matches. Tested: invalid regex doesn't crash
 * the matcher, returns null for that rule.
 */
export function findMatchingRule(rules: Rule[], email: EmailFeatures): Rule | null {
  const matches = rules.filter((r) => matchesEmail(r, email));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return lastTriggeredMs(b) - lastTriggeredMs(a);
  });
  return matches[0];
}

// ───── Lifecycle ─────

export function recordRuleHit(
  store: RuleStore,
  ruleId: string,
  signal: "kept" | "corrected",
  now: Date = new Date(),
): RuleStore {
  const idx = store.rules.findIndex((r) => r.id === ruleId);
  if (idx < 0) return store;
  const rule = { ...store.rules[idx] };
  const stats = { ...rule.stats };
  stats.triggers += 1;
  if (signal === "kept") stats.kept_count += 1;
  else stats.corrected_count += 1;
  stats.last_triggered = now.toISOString();
  rule.stats = stats;
  rule.confidence = applyConfidenceDelta(rule.confidence, signal);
  const newRules = store.rules.slice();
  newRules[idx] = rule;
  return { ...store, rules: newRules };
}

export interface RuleDraft {
  kind: RuleKind;
  pattern: Rule["pattern"];
  action: BucketName;
  created_from: string;
  notes?: string;
}

/**
 * Add a new rule with status=proposed, confidence=0.5. ID is derived from
 * the date + a short slug of the pattern so multiple rules in one night
 * don't collide.
 */
export function proposeRule(
  store: RuleStore,
  draft: RuleDraft,
  now: Date = new Date(),
): RuleStore {
  const date = now.toISOString().slice(0, 10);
  const slug = slugifyPattern(draft.pattern);
  let id = `rule-${date}-${slug}`;
  let n = 1;
  while (store.rules.some((r) => r.id === id)) {
    n++;
    id = `rule-${date}-${slug}-${n}`;
  }
  const rule: Rule = {
    id,
    kind: draft.kind,
    pattern: draft.pattern,
    action: draft.action,
    confidence: 0.5,
    status: "proposed",
    stats: { triggers: 0, kept_count: 0, corrected_count: 0 },
    created_at: now.toISOString(),
    created_from: draft.created_from,
    notes: draft.notes,
  };
  return { ...store, rules: [...store.rules, rule] };
}

function slugifyPattern(pattern: Rule["pattern"]): string {
  const raw = (pattern.sender_regex ?? "") + "|" + (pattern.subject_regex ?? "");
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "x";
}

export function promoteRule(store: RuleStore, ruleId: string): RuleStore {
  return updateStatus(store, ruleId, "active");
}

export function retireRule(store: RuleStore, ruleId: string): RuleStore {
  return updateStatus(store, ruleId, "retired");
}

function updateStatus(store: RuleStore, ruleId: string, status: RuleStatus): RuleStore {
  const idx = store.rules.findIndex((r) => r.id === ruleId);
  if (idx < 0) return store;
  const rule = { ...store.rules[idx], status };
  const newRules = store.rules.slice();
  newRules[idx] = rule;
  return { ...store, rules: newRules };
}

// ───── Lifecycle decision engine ─────

const PROMOTE_MIN_TRIGGERS = 3;
const PROMOTE_MIN_CONFIDENCE = 0.85;
const RETIRE_MIN_TRIGGERS = 5;
const RETIRE_MAX_CONFIDENCE = 0.6;

export interface LifecycleDecisions {
  toPromote: string[];
  toRetire: string[];
}

/**
 * Inspect every rule and decide which should be promoted (proposed →
 * active) or retired. Pure — caller applies the decisions via
 * promoteRule / retireRule if it wants.
 *
 * Promote: status=proposed AND triggers >= 3 AND confidence >= 0.85
 * Retire: status=active AND triggers >= 5 AND confidence < 0.6
 *
 * The single-correction-on-young-rule case (triggers=1, confidence=0.2,
 * status=proposed) does NOT retire — premature retirement is a worse
 * failure mode than carrying a bad rule for a few more triggers.
 */
export function evaluateRulesForLifecycle(store: RuleStore): LifecycleDecisions {
  const toPromote: string[] = [];
  const toRetire: string[] = [];
  for (const r of store.rules) {
    if (
      r.status === "proposed" &&
      r.stats.triggers >= PROMOTE_MIN_TRIGGERS &&
      r.confidence >= PROMOTE_MIN_CONFIDENCE
    ) {
      toPromote.push(r.id);
    } else if (
      r.status === "active" &&
      r.stats.triggers >= RETIRE_MIN_TRIGGERS &&
      r.confidence < RETIRE_MAX_CONFIDENCE
    ) {
      toRetire.push(r.id);
    }
  }
  return { toPromote, toRetire };
}
