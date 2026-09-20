import type { DailyArchive } from "./brew-archive.js";
import { learningTopicOf } from "./brew-archive.js";

export interface Nudge {
  /** The EXACT weight-line key from tuning.md that this nudge moves. */
  key: string;
  delta: number;
  reason: string;
}

export interface SkippedNudge extends Nudge {
  why: string;
}

export interface ApplyResult {
  text: string;
  applied: Nudge[];
  skipped: SkippedNudge[];
}

export interface WeightLine {
  key: string;
  value: number;
  section: string;
  /** Distinctive words used to decide whether an archive is "about" this key. */
  terms: string[];
}

/** Weeks a key has gone unmatched. Persisted between runs by the weekly job. */
export interface NudgeState {
  coldWeeks: Record<string, number>;
}

export interface ProposeResult {
  nudges: Nudge[];
  state: NudgeState;
  /** Distinct archive days each weight line matched, for the weekly report. */
  matchedDays: Record<string, number>;
  /** Keys with no distinctive terms — unmeasurable, never nudged. See below. */
  unmeasurable: string[];
}

const MAX_DELTA = 0.05;
const STUCK_DAYS = 3;
const STUCK_DELTA = 0.03;
const COLD_WEEKS = 3;
const COLD_DELTA = -0.02;

/**
 * Words that say what a topic IS, never WHICH one. A weight line whose only
 * remaining words are these cannot be measured against an archive, so it is
 * reported as `unmeasurable` and never nudged in either direction.
 *
 * The gate matters most on the cold path: without it, "Open-source model
 * releases" would match nothing (every distinctive word stripped), be scored
 * cold three weeks running, and decay a weight Mark set by hand — the
 * auto-generated-suppression failure mode, one layer down.
 */
const GENERIC = new Set([
  "ai", "the", "and", "for", "with", "from", "that", "this", "its", "own",
  "can", "under", "over", "into", "onto", "per", "via", "use", "using", "used",
  "new", "specific", "itself", "tool", "tools", "tooling", "stuff", "thing",
  "things", "work", "works", "apply", "remove", "model", "models", "source",
  "open", "releases", "release", "app", "apps", "based", "general", "generic",
  "mark", "his", "her", "them", "they", "you", "your", "one", "two",
  // Tightened 2026-09-06 after a live probe: "business" matched an SDE
  // valuation pick to the Business-RAG weight, and "off"/"multi"/"dev" match
  // far more than the category they came from.
  "business", "multi", "dev", "off", "personal",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Distinctive words of a weight-line key. */
export function keyTerms(key: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenize(key)) {
    if (t.length < 3) continue;
    if (GENERIC.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}

/**
 * Parse `- Some key: 0.85` bullets, but ONLY inside a `## ...weights` section.
 *
 * The section gate is what keeps the nudger off Mark's prose. `## Learning
 * picker` holds hand-written rules like "- Quality bar: views/subs > 5x"; those
 * are his, and a heading-blind parser that only required a colon would have
 * rewritten them.
 */
export function parseWeightLines(tuningMd: string): WeightLine[] {
  const out: WeightLine[] = [];
  let section = "";
  let inWeights = false;
  for (const line of tuningMd.split("\n")) {
    const h = line.match(/^#{2,}\s+(.*\S)\s*$/);
    if (h) {
      section = h[1];
      inWeights = /weights\s*$/i.test(section);
      continue;
    }
    if (!inWeights) continue;
    const m = line.match(/^[-*]\s+(.*\S)\s*:\s*(\d*\.?\d+)\s*$/);
    if (!m) continue;
    // A key duplicated in the file would otherwise be scored twice and get
    // 2 x delta applied to the FIRST bullet, breaking the weekly clamp.
    if (out.some(l => l.key === m[1])) continue;
    out.push({ key: m[1], value: parseFloat(m[2]), section, terms: keyTerms(m[1]) });
  }
  return out;
}

/** Everything an archive is "about", flattened for term matching. */
function archiveText(a: DailyArchive): string {
  const bits: string[] = [];
  if (a.ai) bits.push(a.ai.headline ?? "", a.ai.source ?? "", a.ai.url ?? "");
  const topic = learningTopicOf(a);
  if (topic) bits.push(topic);
  const l = a.learning;
  if (l) {
    if (typeof l.rock === "string") bits.push(l.rock);
    if (typeof l.why === "string") bits.push(l.why);
    if (typeof l.url === "string") bits.push(l.url);
  }
  if (a.prime) bits.push(a.prime.headline ?? "", a.prime.suggest ?? "");
  return bits.join(" ");
}

function matches(line: WeightLine, words: Set<string>): boolean {
  return line.terms.some(t => words.has(t));
}

/**
 * Propose nudges for the window.
 *
 * Two things changed from the 2026-04 original, both because it returned an
 * empty set for four straight weeks against real data:
 *
 * 1. It scores the weight lines that EXIST in tuning.md, not free-form topic
 *    slugs. The old version keyed nudges on the archive's own slug, which was
 *    unique every day, so nothing ever reached the 3-day threshold and nothing
 *    it proposed could have been found in the file anyway.
 * 2. It reads `topic`/`track` through `learningTopicOf`, and never touches
 *    `streak` or `prime`, which the brew stopped writing on 2026-06-17.
 */
export function proposeNudges(
  archives: DailyArchive[],
  tuningMd: string,
  prevState: NudgeState = { coldWeeks: {} },
): ProposeResult {
  const lines = parseWeightLines(tuningMd);
  const state: NudgeState = { coldWeeks: { ...prevState.coldWeeks } };
  const nudges: Nudge[] = [];
  const matchedDays: Record<string, number> = {};
  const unmeasurable: string[] = [];

  const days = new Map<string, Set<string>>();
  for (const a of archives) {
    if (!a?.date) continue;
    days.set(a.date, new Set(tokenize(archiveText(a))));
  }
  const dayCount = days.size;

  // No archives in the window means the brew did not run — a Sabbath-only week,
  // a launchd stall, a wiped directory. That is an absence of evidence, not
  // evidence that Mark lost interest, so nothing moves and the cold ledger is
  // left exactly as it was.
  if (dayCount === 0) {
    return { nudges: [], state: prevState, matchedDays: {}, unmeasurable: [] };
  }

  for (const line of lines) {
    if (line.terms.length === 0) {
      unmeasurable.push(line.key);
      delete state.coldWeeks[line.key];
      continue;
    }
    let hit = 0;
    for (const words of days.values()) if (matches(line, words)) hit++;
    matchedDays[line.key] = hit;

    if (hit >= STUCK_DAYS) {
      state.coldWeeks[line.key] = 0;
      nudges.push({
        key: line.key,
        delta: STUCK_DELTA,
        reason: `matched ${hit} of ${dayCount} days in the window`,
      });
    } else if (hit > 0) {
      state.coldWeeks[line.key] = 0;
    } else {
      const cold = (prevState.coldWeeks[line.key] ?? 0) + 1;
      if (cold >= COLD_WEEKS) {
        state.coldWeeks[line.key] = 0;
        nudges.push({
          key: line.key,
          delta: COLD_DELTA,
          reason: `no pick matched it in ${cold} consecutive weeks`,
        });
      } else {
        state.coldWeeks[line.key] = cold;
      }
    }
  }

  // Keys Mark deleted from tuning.md must not linger in the cold ledger.
  const live = new Set(lines.map(l => l.key));
  for (const k of Object.keys(state.coldWeeks)) if (!live.has(k)) delete state.coldWeeks[k];

  return { nudges, state, matchedDays, unmeasurable };
}

/**
 * Apply nudges to tuning.md and REPORT what did not land.
 *
 * The old version did `if (!m) continue` — a nudge that matched no line
 * vanished without a trace, and the weekly job printed `applied: nudges.length`
 * regardless. That is how four weeks of "0 nudges applied" read as success.
 */
export function applyNudges(tuningMd: string, nudges: Nudge[]): ApplyResult {
  let out = tuningMd;
  const applied: Nudge[] = [];
  const skipped: SkippedNudge[] = [];

  const done = new Set<string>();
  for (const n of nudges) {
    if (done.has(n.key)) {
      skipped.push({ ...n, why: "another nudge already moved this key this run" });
      continue;
    }
    const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, n.delta));
    const re = new RegExp(
      `^([-*]\\s+${escapeRegex(n.key)}\\s*:\\s*)(\\d*\\.?\\d+)\\s*$`,
      "m",
    );
    const m = out.match(re);
    if (!m) {
      skipped.push({ ...n, why: "no weight line in tuning.md with that exact key" });
      continue;
    }
    const oldVal = parseFloat(m[2]);
    const newVal = Math.max(0, Math.min(1.0, Math.round((oldVal + clamped) * 100) / 100));
    if (newVal === oldVal) {
      skipped.push({ ...n, why: `already at the ${oldVal === 0 ? "floor" : "ceiling"} (${oldVal})` });
      continue;
    }
    out = out.replace(re, `$1${newVal}`);
    done.add(n.key);
    applied.push({ ...n, delta: clamped });
  }

  return { text: out, applied, skipped };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
