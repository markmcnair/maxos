# Email Triage — Autonomous See / Archive / Delete Buckets

**Status:** approved by user 2026-05-05, implementation in progress
**Owner:** Max (the system)
**Goal:** Mark stops looking at see-mail, archive, and delete buckets entirely. He sees only re-mail. Drafts stay drafts (re-mail unchanged).

---

## Problem

The existing email triage system has a "training" task that's been silently failing for ~3 weeks. Symptoms:

- `tasks/email-triage.md` rules unchanged for 3 weeks despite nightly training cron firing
- `~/.config/email-triage/training-history.json` doesn't exist — never created
- Training task design says "exit silently if zero corrections" — no audit trail
- Only signal it learns from is *manual label changes in Gmail* (<5% of available evidence)
- Rules live as prose in markdown the LLM rewrites — can't measure per-rule performance, can't retire stale rules, can't promote earned rules

User-facing pain: sees/archives/deletes still feel untrustworthy enough that he checks them. Opening Gmail at all defeats the inbox-zero design.

## Goal (concrete success metric)

After 12 weeks of operation:

- **Re-mail behavior unchanged.** Drafts continue. User reviews and sends. (Out of scope for this work.)
- **See / archive / delete are 100% autonomous.** User does not open these buckets except by his own choice (e.g., searching for a known email).
- **Precision target ≥ 95%** on each non-re-mail bucket, measured against signals (user fishing back, user reading-then-leaving, etc.).
- **Asymmetric error tolerance:** when uncertain, prefer false-positive see-mail (extra context) over false-negative delete (lost important email).
- **Visibility:** weekly digest shows precision per bucket, rule count, novel-email count. User can see whether the system is improving without reading code or logs.

## Non-goals

- Auto-send tier (drafts → sent without review). Explicitly off the table.
- Voice-diff capture for re-mail drafts. Re-mail loop is fine as-is.
- Multi-account scaling beyond the current Emprise + Personal pair.
- Mobile / iOS hooks. Cron-driven, runs on the daemon.

## Architecture (5 components)

The work decomposes into five components built in this order. Each ships independently with tests; later components depend on data the earlier ones produce.

### Component 1 — Telemetry foundation

**Files added:**
- `~/.config/email-triage/training-runs.jsonl` — append-only, one record per nightly training run, **including zero-correction nights**
- `~/.config/email-triage/digest-summary.json` — rolling 30-day stats consumed by maxos-digest

**Code added:**
- `src/email-triage-telemetry.ts` — pure helpers: `recordTrainingRun(home, payload)`, `loadRecent(home, days)`, `summarizeForDigest(home)`. Atomic append.
- Hook in `src/maxos-digest.ts` to surface a one-line training stat: `email-triage: 26 today, 30d precision 94%, 2 corrections this week, 12 active rules`.

**Prompt change:**
- `tasks/email-triage-training.md` Step 6 ("Log the training") rewritten to require a record EVERY night, even with `corrections_found: 0`. Explicit anti-pattern documented: "exit silently with no log entry" is now considered a bug.

**Acceptance:**
- After one full night cycle, `training-runs.jsonl` has at least one entry.
- maxos-digest contains the email-triage line.
- `summarizeForDigest` returns sane numbers given mocked input. Tested.

### Component 2 — Multi-signal capture

**Files added:**
- `~/.config/email-triage/signals.jsonl` — append-only, one line per observed signal

**Signal types:**

| Signal | Detection | Strength |
|---|---|---|
| `bucket_changed` | label diff between daily-log and current state | Strong correction |
| `moved_to_inbox` | email no longer has any 1-Max/* label, INBOX present | Strong correction (treats as needs-review) |
| `read_after_archive_or_delete` | email is in archive/delete bucket but `UNREAD` removed since assignment | Mild "should've been see-mail" |
| `untouched_seemail_30d` | see-mail email older than 30d, never opened, no other labels | Retroactive "should've been archive" |
| `searched_for_archive` | (out of scope for v1; can't reliably detect via Gmail API) | — |
| `replied_to_seemail` | see-mail email has thread `historyId` advanced AND user sent in that thread | Confirms see-mail correct (could've also been re-mail; weak) |
| `triage_drafted_then_sent` | re-mail draft sent unchanged within 24h | Confirms re-mail correct (informational only) |

**Code added:**
- `src/email-signal-sweep.ts` — scans Gmail for state changes since `last_swept_at`. Pure data extraction; emits structured signal records. Idempotent (signal records keyed by `(message_id, signal_type)`).
- New cron entry in HEARTBEAT.md: every 30 minutes during waking hours (e.g. `*/30 6-22 * * *`), runs `node dist/src/email-signal-sweep.js`. Silent.

**Acceptance:**
- After 24 hours of operation, signals.jsonl has bucket_changed, moved_to_inbox, and read_after_archive_or_delete entries based on real user behavior.
- Sweep is idempotent: running twice for the same Gmail state writes zero new lines on the second run.
- Tested with mocked Gmail responses.

### Component 3 — Structured rule database

**Files added:**
- `~/.config/email-triage/rules.json` — versioned rule store

**Rule schema:**
```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "rule-2026-05-05-mealtrain-signup",
      "kind": "sender_subject_pattern",
      "pattern": {
        "sender_regex": "@mealtrain\\.com$",
        "subject_regex": "(?i)^You have signed up"
      },
      "action": "delete",
      "confidence": 0.95,
      "status": "active",  // proposed | active | retired
      "stats": {
        "triggers": 12,
        "kept_count": 12,        // user did not correct
        "corrected_count": 0,
        "last_triggered": "2026-05-04T15:55:00Z"
      },
      "created_at": "2026-04-15T22:01:00Z",
      "created_from": "training-2026-04-15",
      "notes": "Mark moved 3 of these from see-mail → delete in one week"
    }
  ]
}
```

**Code added:**
- `src/email-rule-store.ts` — pure module: `loadRules`, `saveRules` (atomic temp+rename), `findMatchingRule(rules, email)`, `recordRuleHit(rules, ruleId, kept | corrected)`, `promoteRule(rules, ruleId)`, `retireRule(rules, ruleId)`, `proposeRule(rules, draft)`. Heavy unit-test coverage; this is load-bearing.
- Confidence math: starts at 0.5 for proposed rules. Each `kept` raises by `0.5 * (1 - confidence)`. Each `corrected` lowers by `0.3` (clamped ≥ 0). Retire when `triggers >= 5 AND confidence < 0.6`. Promote `proposed → active` when `triggers >= 3 AND confidence >= 0.85`.
- Pattern matcher: regex on sender + optional regex on subject. Both must match. Sender regex takes precedence over subject in ranking.

**Acceptance:**
- Loading a missing rules.json returns an empty rule set; no crash.
- Saving and reloading roundtrips schema.
- `findMatchingRule` returns the highest-confidence rule among matches; ties broken by most-recent-`last_triggered`.
- Confidence math passes property-based tests.
- Pruning retired rules behind a flag (kept by default for forensics).

### Component 4 — Rules-first triage with LLM fallback

**Behavior change:**
- `tasks/email-triage.md` rewritten so Step 4 ("Categorize") becomes:
  1. For each email, evaluate `rules.json`. If a rule with `status: active` AND `confidence >= 0.9` matches, USE IT. Log `rule_id` in daily-log.
  2. If a rule matches but confidence is in `[0.7, 0.9)`, USE IT but flag as "low-confidence rule hit" in daily-log.
  3. Else, ask the LLM to categorize. Log as `novel: true` in daily-log.
- LLM still drafts re-mail replies. That part of the prompt is unchanged.

**Daily-log schema additions:**
```jsonc
{
  "emails": [
    {
      // ...existing fields...
      "rule_id": "rule-2026-05-05-mealtrain-signup",  // null if novel
      "rule_confidence": 0.95,
      "novel": false,
      "decision_source": "rule" | "llm-fallback"
    }
  ]
}
```

**Code added:**
- `src/email-triage-decisions.ts` — pure decision tree: `decideBucket(email, rules)` returns `{ bucket, source, ruleId, confidence }`. The LLM-fallback path is a stub that returns `{ source: "llm-fallback" }` so the actual prompt task can call out.
- The triage task still uses the LLM, but the LLM runs the deterministic decision FIRST (via Bash subshell on a tiny TS script, or by reading rules.json inline) and only categorizes the residual.

**Training loop change (Step 5 of `email-triage-training.md`):**
- For each daily-log email, look at signals captured for that message_id since the triage time.
- If the email used a rule and signals show `kept` → `recordRuleHit(ruleId, "kept")`.
- If signals show `corrected` (bucket_changed, moved_to_inbox) → `recordRuleHit(ruleId, "corrected")`.
- For `novel: true` emails, propose a new rule based on the LLM's categorization + sender/subject pattern. New rules start in `proposed` status.
- Promote/retire per Component 3 thresholds.

**Acceptance:**
- A novel email triaged by LLM, then user confirms (no signals fired in 48h) → proposed rule's confidence rises.
- A rule-driven decision corrected by user → that rule's confidence drops; if it falls below threshold, retire.
- After 30 days, ratio of rule-decided emails to LLM-fallback emails should be visible in maxos-digest.

### Component 5 — Precision/recall reporting

**Files added:**
- `~/.config/email-triage/precision-window.json` — rolling 30-day metrics, recomputed nightly

**Metrics:**
- **See-mail precision:** `(see-mail emails user opened OR replied to OR moved-to-inbox-as-needs-review) / total see-mail`. Higher is better.
- **Archive precision:** `(archive emails user did NOT fish back) / total archive`. Higher is better.
- **Delete precision:** `(delete emails user did NOT fish back) / total delete`. Higher is better.
- **Rule coverage:** `rule-decided / total triaged`. Should grow week over week.
- **Novel rate:** `LLM-fallback / total triaged`. Should shrink over time.

**Code added:**
- `src/email-precision.ts` — `computePrecisionWindow(home, now, windowDays = 30)` returns the metrics. Uses signals.jsonl + daily logs.
- New section in maxos-digest: weekly stats (one extra line in the daily digest, full breakdown in the weekly digest).

**Acceptance:**
- After 7 days of signals, precision metrics are computable.
- Reasonable null behavior: returns "insufficient data" when window has < 10 emails.
- Tested with mocked signals files.

## Sequencing & risk

- Build order: 1 → 2 → 3 → 4 → 5. Each component delivers value standalone.
- Each component lands with TDD tests + plan-doc round entry.
- Risk: Gmail API quota. Sweep is read-only and runs every 30 min; well within free quota for a single user.
- Risk: false-negative delete (deleting an important email). Mitigated by:
  - Confidence threshold of 0.9 for delete rules vs 0.7 for see-mail
  - 30-day soft-delete (Gmail keeps deleted emails 30 days in trash)
  - Multi-signal capture surfaces these as `moved_to_inbox` events; the rule retires.

## What this design explicitly chooses NOT to do

- Does not introduce a new ML model. Rules + LLM only.
- Does not auto-send. Drafts stay drafts.
- Does not cross-correlate across accounts (a rule in Personal stays in Personal).
- Does not retroactively update past decisions. Once an email is in a bucket, it stays unless the user moves it.
- Does not learn from re-mail draft edits. Voice loop stays as-is.

## Test strategy

- Every pure helper has unit tests via `node:test` in `tests/`.
- Signal capture has fixture-based tests with sample Gmail JSON payloads.
- Rule store has property-based tests for confidence math (e.g., never goes negative, monotone under repeated `kept`).
- Integration tests with temp directories for the file-store side effects (atomic writes, idempotency).
- Live verification after each component lands: real email cycle for 24h, then check telemetry / signals / rules / precision file content.

## Architectural takeaway (for future work)

This design treats the LLM as a *strategist*, not a labor pool:
- LLM categorizes only ambiguous emails (the long tail).
- LLM proposes new rules based on its own classifications.
- LLM curates: nightly training inspects signals + rule stats, decides what to promote/retire.

The deterministic layer is the durable memory. Rules accumulate measurable performance. The LLM augments where rules don't yet reach. Both layers compound — the rule corpus grows; the LLM's prompts get sharper as feedback flows. Same pattern as Round Q/R observability: deterministic boundaries, LLM where judgment matters, every event leaves an audit trail.
