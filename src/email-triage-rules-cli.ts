import { homedir } from "node:os";
import {
  loadRules,
  saveRules,
  recordRuleHit,
  proposeRule,
  promoteRule,
  retireRule,
  evaluateRulesForLifecycle,
  parseInlineFlags,
  type Rule,
  type RuleKind,
  type RuleDraft,
} from "./email-rule-store.js";
import type { BucketName } from "./email-signal-sweep.js";

// ───── record-hit ─────

export interface RecordHitInput {
  ruleId: string;
  signal: "kept" | "corrected";
}

export interface RecordHitResult {
  ok: boolean;
  rule?: Rule;
  error?: string;
}

export function runRecordHit(
  home: string,
  input: RecordHitInput,
  now: Date,
): RecordHitResult {
  if (input.signal !== "kept" && input.signal !== "corrected") {
    return { ok: false, error: "signal must be 'kept' or 'corrected'" };
  }
  const store = loadRules(home);
  const exists = store.rules.find((r) => r.id === input.ruleId);
  if (!exists) {
    return { ok: false, error: `rule '${input.ruleId}' not found in rules.json` };
  }
  const updated = recordRuleHit(store, input.ruleId, input.signal, now);
  saveRules(home, updated);
  const rule = updated.rules.find((r) => r.id === input.ruleId);
  return { ok: true, rule };
}

// ───── propose ─────

const VALID_BUCKETS: ReadonlyArray<BucketName> = ["re-mail", "see-mail", "archive", "delete"];
const VALID_KINDS: ReadonlyArray<RuleKind> = ["sender_pattern", "subject_pattern", "sender_subject_pattern"];

export interface ProposeInput {
  kind: RuleKind;
  sender_regex?: string;
  subject_regex?: string;
  action: BucketName;
  created_from: string;
  notes?: string;
}

export interface ProposeResult {
  ok: boolean;
  rule?: Rule;
  error?: string;
}

export function runProposeRule(
  home: string,
  input: ProposeInput,
  now: Date,
): ProposeResult {
  if (!VALID_KINDS.includes(input.kind)) {
    return { ok: false, error: `kind must be one of: ${VALID_KINDS.join(", ")}` };
  }
  if (!VALID_BUCKETS.includes(input.action)) {
    return { ok: false, error: `action must be one of: ${VALID_BUCKETS.join(", ")}` };
  }
  if (!input.sender_regex && !input.subject_regex) {
    return { ok: false, error: "at least one of sender_regex or subject_regex required (need a pattern to match)" };
  }
  if (!input.created_from) {
    return { ok: false, error: "created_from is required (e.g. 'training-2026-05-05')" };
  }
  // Validate regex compiles. Strip Python-style inline flags first
  // (parseInlineFlags is the same helper the rule matcher uses).
  for (const pattern of [input.sender_regex, input.subject_regex]) {
    if (!pattern) continue;
    try {
      const { source, flags } = parseInlineFlags(pattern);
      new RegExp(source, flags);
    } catch (err) {
      return { ok: false, error: `invalid regex '${pattern}': ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const draft: RuleDraft = {
    kind: input.kind,
    pattern: {
      sender_regex: input.sender_regex,
      subject_regex: input.subject_regex,
    },
    action: input.action,
    created_from: input.created_from,
    notes: input.notes,
  };
  const store = loadRules(home);
  const updated = proposeRule(store, draft, now);
  saveRules(home, updated);
  const rule = updated.rules[updated.rules.length - 1];
  return { ok: true, rule };
}

// ───── lifecycle ─────

export interface LifecycleResult {
  promoted: string[];
  retired: string[];
}

export function runLifecycle(home: string): LifecycleResult {
  const store = loadRules(home);
  const decisions = evaluateRulesForLifecycle(store);
  let next = store;
  for (const id of decisions.toPromote) next = promoteRule(next, id);
  for (const id of decisions.toRetire) next = retireRule(next, id);
  if (decisions.toPromote.length > 0 || decisions.toRetire.length > 0) {
    saveRules(home, next);
  }
  return { promoted: decisions.toPromote, retired: decisions.toRetire };
}

// ───── approve (the human lever) ─────

/**
 * Confidence floor for a hand-approved rule. decideBucketFromRules only
 * takes the no-LLM "rule" path at >= 0.9 and ignores anything under 0.7,
 * so promoting a fresh 0.5-confidence rule without this floor would be a
 * no-op: active in the store, still never deciding anything.
 */
const APPROVED_CONFIDENCE_FLOOR = 0.9;

export interface ApproveInput {
  ruleIds?: string[];
  bucket?: BucketName;
  all?: boolean;
  dryRun?: boolean;
  approvedBy?: string;
}

export interface ApproveResult {
  ok: boolean;
  approved: string[];
  skipped: Array<{ id: string; reason: string }>;
  dryRun: boolean;
  error?: string;
}

/**
 * Promote proposed rules to active because a human said so, bypassing the
 * triggers/confidence gate in evaluateRulesForLifecycle.
 *
 * Why this exists (2026-08-05): promotion was automatic-only, gated on
 * >= 3 triggers, and the sender-matching bug meant triggers never
 * incremented. 66 rules sat in `proposed` with no way for Mark to say yes.
 * The automatic path is fixed too, but a system that can only promote
 * itself has no owner.
 */
export function runApprove(
  home: string,
  input: ApproveInput,
  now: Date,
): ApproveResult {
  const dryRun = input.dryRun === true;
  const selectors = [
    input.ruleIds !== undefined && input.ruleIds.length > 0,
    input.bucket !== undefined,
    input.all === true,
  ].filter(Boolean).length;
  if (selectors === 0) {
    return {
      ok: false,
      approved: [],
      skipped: [],
      dryRun,
      error: "pick what to approve: --rule <id> (repeatable), --bucket <bucket>, or --all",
    };
  }
  if (input.bucket !== undefined && !VALID_BUCKETS.includes(input.bucket)) {
    return {
      ok: false,
      approved: [],
      skipped: [],
      dryRun,
      error: `bucket must be one of: ${VALID_BUCKETS.join(", ")}`,
    };
  }

  const store = loadRules(home);
  const byId = new Map(store.rules.map((r) => [r.id, r]));
  const approved: string[] = [];
  const skipped: ApproveResult["skipped"] = [];

  // Explicit ids win; otherwise every proposed rule, optionally narrowed
  // to one bucket. --all and --bucket never touch active/retired rules.
  const targets: string[] = input.ruleIds?.length
    ? input.ruleIds
    : store.rules
        .filter((r) => r.status === "proposed")
        .filter((r) => (input.bucket ? r.action === input.bucket : true))
        .map((r) => r.id);

  for (const id of targets) {
    const rule = byId.get(id);
    if (!rule) {
      skipped.push({ id, reason: "not found in rules.json" });
      continue;
    }
    if (rule.status === "active") {
      skipped.push({ id, reason: "already active" });
      continue;
    }
    if (rule.status === "retired") {
      skipped.push({ id, reason: "retired — revive it deliberately, not by approving" });
      continue;
    }
    approved.push(id);
  }

  if (!dryRun && approved.length > 0) {
    const stamp = new Set(approved);
    let next = store;
    for (const id of approved) next = promoteRule(next, id);
    next = {
      ...next,
      rules: next.rules.map((r) =>
        stamp.has(r.id)
          ? {
              ...r,
              confidence: Math.max(r.confidence, APPROVED_CONFIDENCE_FLOOR),
              approved_by: input.approvedBy ?? "mark",
              approved_at: now.toISOString(),
            }
          : r,
      ),
    };
    saveRules(home, next);
  }

  return { ok: true, approved, skipped, dryRun };
}

// ───── pending (what am I approving?) ─────

export interface PendingRule {
  id: string;
  action: BucketName;
  sender_regex?: string;
  subject_regex?: string;
  created_at: string;
  created_from: string;
  triggers: number;
  confidence: number;
  notes?: string;
}

export interface PendingResult {
  total: number;
  byBucket: Record<string, PendingRule[]>;
}

/** Every proposed rule, grouped by the bucket it would assign, newest first. */
export function runPending(home: string): PendingResult {
  const store = loadRules(home);
  const byBucket: Record<string, PendingRule[]> = {};
  let total = 0;
  for (const r of store.rules) {
    if (r.status !== "proposed") continue;
    total++;
    (byBucket[r.action] ??= []).push({
      id: r.id,
      action: r.action,
      sender_regex: r.pattern.sender_regex,
      subject_regex: r.pattern.subject_regex,
      created_at: r.created_at,
      created_from: r.created_from,
      triggers: r.stats.triggers,
      confidence: r.confidence,
      notes: r.notes,
    });
  }
  for (const list of Object.values(byBucket)) {
    list.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }
  return { total, byBucket };
}

/** Plain text, terminal-shaped: what each rule would do and how to say yes. */
export function formatPending(result: PendingResult): string {
  if (result.total === 0) return "nothing pending — no proposed rules to approve.";
  const lines: string[] = [`${result.total} rules waiting on you`, ""];
  const order = ["delete", "archive", "see-mail", "re-mail"];
  const buckets = Object.keys(result.byBucket).sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );
  for (const bucket of buckets) {
    const rules = result.byBucket[bucket];
    lines.push(`${bucket.toUpperCase()} — ${rules.length}`);
    for (const r of rules) {
      const pattern = [r.sender_regex, r.subject_regex].filter(Boolean).join("  +  ");
      lines.push(`  ${r.id}`);
      lines.push(`    ${pattern}`);
      if (r.notes) lines.push(`    ${r.notes}`);
    }
    lines.push("");
    lines.push(`  approve the whole bucket:  email-rules.sh approve --bucket ${bucket}`);
    lines.push("");
  }
  lines.push(`approve one:  email-rules.sh approve --rule ${result.byBucket[buckets[0]][0].id}`);
  lines.push("approve all:  email-rules.sh approve --all");
  return lines.join("\n");
}

// ───── list ─────

export interface ListResult {
  totals: {
    active: number;
    proposed: number;
    retired: number;
    byBucket: Record<string, number>;
  };
  rules: Array<{
    id: string;
    status: string;
    action: BucketName;
    confidence: number;
    triggers: number;
    pattern: { sender_regex?: string; subject_regex?: string };
    notes?: string;
  }>;
}

export function runList(home: string): ListResult {
  const store = loadRules(home);
  const totals = {
    active: 0,
    proposed: 0,
    retired: 0,
    byBucket: {} as Record<string, number>,
  };
  const rules: ListResult["rules"] = [];
  for (const r of store.rules) {
    if (r.status === "active") totals.active++;
    else if (r.status === "proposed") totals.proposed++;
    else if (r.status === "retired") totals.retired++;
    if (r.status !== "retired") {
      totals.byBucket[r.action] = (totals.byBucket[r.action] ?? 0) + 1;
    }
    rules.push({
      id: r.id,
      status: r.status,
      action: r.action,
      confidence: r.confidence,
      triggers: r.stats.triggers,
      pattern: r.pattern,
      notes: r.notes,
    });
  }
  return { totals, rules };
}

// ───── CLI ─────

const isCLI = process.argv[1]?.endsWith("email-triage-rules-cli.js");
if (isCLI) {
  const argv = process.argv;
  const cmd = argv[2];
  const arg = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const home = process.env.HOME ?? homedir();

  if (cmd === "record-hit") {
    const ruleId = arg("--rule");
    const signal = arg("--signal") as "kept" | "corrected" | null;
    if (!ruleId || !signal) {
      console.error("usage: record-hit --rule <id> --signal kept|corrected");
      process.exit(2);
    }
    const r = runRecordHit(home, { ruleId, signal }, new Date());
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "propose") {
    const r = runProposeRule(
      home,
      {
        kind: (arg("--kind") ?? "sender_pattern") as RuleKind,
        sender_regex: arg("--sender-regex") ?? undefined,
        subject_regex: arg("--subject-regex") ?? undefined,
        action: (arg("--action") ?? "delete") as BucketName,
        created_from: arg("--created-from") ?? `cli-${new Date().toLocaleDateString("en-CA")}`,
        notes: arg("--notes") ?? undefined,
      },
      new Date(),
    );
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "approve") {
    // --rule is repeatable: collect every occurrence, not just the first.
    const ruleIds = argv.reduce<string[]>((acc, a, i) => {
      if (a === "--rule" && argv[i + 1]) acc.push(argv[i + 1]);
      return acc;
    }, []);
    const r = runApprove(
      home,
      {
        ruleIds,
        bucket: (arg("--bucket") ?? undefined) as BucketName | undefined,
        all: argv.includes("--all"),
        dryRun: argv.includes("--dry-run"),
      },
      new Date(),
    );
    if (argv.includes("--json")) {
      console.log(JSON.stringify(r));
    } else if (!r.ok) {
      console.error(r.error);
    } else {
      const verb = r.dryRun ? "would approve" : "approved";
      console.log(`${verb} ${r.approved.length} rule(s)${r.approved.length ? ": " + r.approved.join(", ") : ""}`);
      for (const s of r.skipped) console.log(`  skipped ${s.id} — ${s.reason}`);
      if (!r.dryRun && r.approved.length > 0) {
        console.log("they decide mail starting with the next triage run.");
      }
    }
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "pending") {
    const r = runPending(home);
    console.log(argv.includes("--json") ? JSON.stringify(r, null, 2) : formatPending(r));
    process.exit(0);
  } else if (cmd === "lifecycle") {
    const r = runLifecycle(home);
    console.log(JSON.stringify(r));
    process.exit(0);
  } else if (cmd === "list") {
    const r = runList(home);
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  } else {
    console.error("usage: email-triage-rules-cli <subcommand>");
    console.error("  record-hit --rule <id> --signal kept|corrected");
    console.error("  propose --kind <kind> --sender-regex <re> [--subject-regex <re>] --action <bucket> --created-from <src> [--notes <txt>]");
    console.error("  pending [--json]                                      what is waiting on you");
    console.error("  approve --rule <id> [--rule <id>...] | --bucket <bucket> | --all [--dry-run] [--json]");
    console.error("  lifecycle");
    console.error("  list");
    process.exit(2);
  }
}
