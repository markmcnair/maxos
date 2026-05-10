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
        created_from: arg("--created-from") ?? `cli-${new Date().toISOString().slice(0, 10)}`,
        notes: arg("--notes") ?? undefined,
      },
      new Date(),
    );
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
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
    console.error("  lifecycle");
    console.error("  list");
    process.exit(2);
  }
}
