import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateAgainstSchema,
  schemaForTask,
  SHUTDOWN_DEBRIEF_SCHEMA,
  MORNING_BRIEF_SCHEMA,
  type SchemaViolation,
  type SchemaRule,
} from "./brief-schema.js";

/**
 * Round W2 (2026-05-08): debrief silent-failure recovery from journal +
 * closures + open-loops, used when the vault file ALSO wasn't saved (the
 * 5/8 case: LLM produced 50 chars of "Notion sync completed" garbage AND
 * skipped Step 6 vault save, so Round T's vault recovery had nothing to
 * read). This recovery path reads the deterministic state files the
 * daemon writes throughout the day and synthesizes a minimum-viable
 * debrief.
 */

/**
 * Recovery layer for catastrophic LLM delivery failures. When the LLM
 * produces a tiny / malformed final output (e.g. 125-char "Sync clean"
 * confirmation message instead of the full debrief — observed 2026-05-07),
 * the schema validator catches it. Without recovery, the user gets the
 * garbage; with recovery, we read the long-form vault file the LLM did
 * write to disk during Step 6, transform it to highlight-reel format,
 * and deliver THAT instead.
 *
 * This is the same architectural principle as the Round Q error capture:
 * never silently deliver a malformed result when a deterministic recovery
 * path is available.
 */

export type TaskKind = "shutdown-debrief" | "morning-brief";

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function classifyTask(taskName: string): TaskKind | null {
  const lower = taskName.toLowerCase();
  if (lower.includes("shutdown-debrief") || lower.includes("shutdowndebrief")) {
    return "shutdown-debrief";
  }
  if (lower.includes("morning-brief") || lower.includes("morningbrief")) {
    return "morning-brief";
  }
  return null;
}

/**
 * True if the task is the morning brew. Brew has a different recovery
 * source than brief/debrief — it reads the JSON archive snapshot the
 * brew writes during its Archive step (memory/morning-brew/archive/
 * YYYY-MM-DD.json) instead of a vault markdown file.
 */
export function isMorningBrew(taskName: string): boolean {
  const lower = taskName.toLowerCase();
  return lower.includes("morning-brew") || lower.includes("morningbrew");
}

/**
 * Map a task slug to its expected vault file path. Returns null when
 * the task has no vault counterpart (scripts, watchdogs, etc.).
 */
export function vaultPathForTask(maxosHome: string, taskName: string, now: Date): string | null {
  const kind = classifyTask(taskName);
  if (!kind) return null;
  const date = ymdLocal(now);
  const filename = kind === "shutdown-debrief" ? `${date}-debrief.md` : `${date}-morning-brief.md`;
  return join(maxosHome, "vault", "Work", "Daily", filename);
}

const RECOVERY_LOW_CHARS_THRESHOLD = 500;
const BREW_RECOVERY_LOW_CHARS_THRESHOLD = 100;

/**
 * Decide whether a schema violation merits attempting recovery.
 *
 * Triggers for brief/debrief:
 *  - 3+ required sections missing (massive structural failure)
 *  - OR any required section missing AND total chars < 500 (the
 *    "tiny garbage output" case from 2026-05-07)
 *
 * Triggers for morning-brew (added Round W, 2026-05-08):
 *  - header missing AND total chars < 100 (the silent-empty case
 *    observed 2026-05-06 + 2026-05-08, where the brew LLM session
 *    completed its back-end work — wrote the archive JSON, updated
 *    state.json — but ended on a tool call so claude --print stdout
 *    was empty). Recovery here reads the archive snapshot the brew
 *    DID save and synthesizes a deterministic minimum-viable brew.
 *
 *    Stricter threshold (100 vs 500) because brew output is shorter
 *    by design — a real brew can be 400-800 chars on a slow news
 *    day and we don't want to override real LLM output.
 */
export function shouldAttemptRecovery(v: SchemaViolation): boolean {
  if (isMorningBrew(v.task)) {
    if (v.missingRequired.includes("header") && v.totalChars < BREW_RECOVERY_LOW_CHARS_THRESHOLD) {
      return true;
    }
    return false;
  }
  const kind = classifyTask(v.task);
  if (!kind) return false;
  if (v.missingRequired.length >= 3) return true;
  if (v.missingRequired.length >= 1 && v.totalChars < RECOVERY_LOW_CHARS_THRESHOLD) {
    return true;
  }
  return false;
}

// ───── Vault → highlight-reel transformation ─────

const HEADING_MAPPINGS_DEBRIEF: Array<{ from: RegExp; to: string }> = [
  { from: /^#\s+Shutdown Debrief\b/m, to: "🌅 Shutdown Debrief" },
  { from: /^##\s+Wins\b/im, to: "## ✅ Wins" },
  { from: /^##\s+Ghosted\b[^\n]*/im, to: "## 👻 Ghosted" },
  { from: /^##\s+Open Loops\b/im, to: "## 🔄 Open Loops" },
  { from: /^##\s+Top 3 (Priorities )?for Tomorrow\b/im, to: "## 🎯 Top 3 for Tomorrow" },
  { from: /^##\s+Tomorrow'?s? Calendar\b[^\n]*/im, to: "## 📅 Tomorrow" },
];

const HEADING_MAPPINGS_BRIEF: Array<{ from: RegExp; to: string }> = [
  { from: /^#\s+Morning Brief\b/m, to: "☀️ Morning Brief" },
  { from: /^##\s+Top [Pp]riority\b/m, to: "## 🪨 Top priority" },
  { from: /^##\s+Ghosted\b[^\n]*/im, to: "## 👻 Ghosted" },
  { from: /^##\s+Today\b[^\n]*/im, to: "## 📅 Today" },
  { from: /^##\s+First [Pp]resence\b/im, to: "## 📍 First presence" },
  { from: /^##\s+Overnight\b[^\n]*/im, to: "## 🚨 Overnight" },
];

/**
 * Transform a saved vault long-form (## headers) into highlight-reel
 * format (emoji headers). Idempotent — running it on already-emoji'd
 * content is a no-op.
 *
 * Only converts the canonical structural sections; leaves body content
 * alone. Strips out incidental ### subheadings (Step labels) that the
 * LLM sometimes leaves in the long-form output.
 */
export function convertVaultToHighlightReel(content: string, kind: TaskKind): string {
  const mappings = kind === "shutdown-debrief" ? HEADING_MAPPINGS_DEBRIEF : HEADING_MAPPINGS_BRIEF;
  let out = content;
  for (const m of mappings) {
    out = out.replace(m.from, m.to);
  }
  // Strip ### Step ... subheadings (only those — we keep meaningful ###
  // user content). The pattern matches ### Friday Step 2:, ### Step 5a, etc.
  out = out.replace(/^###\s+(Friday\s+)?Step\s+\d.*$/gim, "");
  // Collapse triple+ blank lines to double for cleanliness
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

// ───── Recovery orchestrator ─────

export interface RecoveryAttempt {
  recovered: boolean;
  content?: string;
  reason?: string;
  vaultPath?: string;
}

const RECOVERY_REQUIRED_SECTIONS_DEBRIEF = ["Wins", "Ghosted", "Open Loops"];
const RECOVERY_REQUIRED_SECTIONS_BRIEF = ["Top Priority", "Ghosted"];

function vaultHasMinimumSections(content: string, kind: TaskKind): boolean {
  const required = kind === "shutdown-debrief"
    ? RECOVERY_REQUIRED_SECTIONS_DEBRIEF
    : RECOVERY_REQUIRED_SECTIONS_BRIEF;
  const lower = content.toLowerCase();
  return required.every((s) => lower.includes(s.toLowerCase()));
}

/**
 * Try to recover the proper output from disk. Used only after
 * shouldAttemptRecovery returns true. Dispatches by task kind:
 *  - brief/debrief → reads vault markdown file, transforms to
 *    highlight-reel format
 *  - morning-brew → reads archive JSON snapshot the brew wrote
 *    during its Archive step, synthesizes a deterministic brew
 *
 * Returns `recovered: false` with a reason when the source artifact
 * is missing, empty, or lacks required fields — caller falls back to
 * whatever the LLM did produce (better that than nothing).
 *
 * Function name preserved for backward compatibility with gateway.ts;
 * the "Vault" in the name now covers all on-disk recovery sources.
 */
export function recoverFromVault(
  maxosHome: string,
  taskName: string,
  now: Date,
): RecoveryAttempt {
  if (isMorningBrew(taskName)) {
    return recoverBrewFromArchive(maxosHome, now);
  }
  const kind = classifyTask(taskName);
  if (!kind) return { recovered: false, reason: "task has no vault counterpart" };
  const path = vaultPathForTask(maxosHome, taskName, now);
  if (!path) return { recovered: false, reason: "no vault path resolved" };
  if (!existsSync(path)) {
    // Round W2 fallback: when the vault file ALSO wasn't saved (LLM
    // skipped Step 6), try synthesizing the debrief from closures +
    // journal + open-loops state. Brief uses the same fallback path.
    const stateRecovery = recoverFromState(maxosHome, kind, now);
    if (stateRecovery.recovered) return stateRecovery;
    return {
      recovered: false,
      vaultPath: path,
      reason: `vault file not found at expected path AND state-recovery failed: ${stateRecovery.reason}`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return {
      recovered: false,
      vaultPath: path,
      reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!vaultHasMinimumSections(raw, kind)) {
    // Same fallback as the missing-file case.
    const stateRecovery = recoverFromState(maxosHome, kind, now);
    if (stateRecovery.recovered) return stateRecovery;
    return {
      recovered: false,
      vaultPath: path,
      reason: "vault file present but missing required sections (LLM may have failed before save)",
    };
  }
  const transformed = convertVaultToHighlightReel(raw, kind);
  // Verify the transformation produced a result that would PASS the schema
  const schema = kind === "shutdown-debrief" ? SHUTDOWN_DEBRIEF_SCHEMA : MORNING_BRIEF_SCHEMA;
  const violation = validateAgainstSchema(transformed, schema, taskName);
  if (violation.missingRequired.length >= 3) {
    return {
      recovered: false,
      vaultPath: path,
      reason: `transformation incomplete (still missing: ${violation.missingRequired.join(", ")})`,
    };
  }
  return { recovered: true, content: transformed, vaultPath: path };
}

// ───── Round W2 (2026-05-08): Debrief/Brief recovery from state ─────
//
// When the LLM produces garbage AND skips the vault-file save, the only
// surviving artifacts are the deterministic state files MaxOS writes
// throughout the day:
//   - memory/closures-YYYY-MM-DD.md (CLOSURE/DECISION/FACT lines)
//   - memory/dropped-loops.md (today's drops, by date heading)
//   - memory/open-loops.json (current open loops)
//   - memory/YYYY-MM-DD.md (journal — task results + checkpoints)
//
// recoverFromState reads these and synthesizes a minimum-viable debrief
// or brief that satisfies the schema. The output is plain and labeled
// (banner prepended by gateway) so Mark knows it's recovered, not LLM.

interface ClosureLine {
  time: string;       // "09:12"
  kind: "CLOSURE" | "DECISION" | "FACT";
  text: string;       // everything after the kind tag
}

function parseClosuresFile(path: string): ClosureLine[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return []; }
  const lines = raw.split("\n");
  const out: ClosureLine[] = [];
  const re = /^-\s*\[(\d{2}:\d{2})\]\s*\[(CLOSURE|DECISION|FACT)\]\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    out.push({ time: m[1], kind: m[2] as ClosureLine["kind"], text: m[3].trim() });
  }
  return out;
}

interface DroppedLine {
  date: string;       // "2026-05-08"
  heading: string;
  bullet: string;
}

function parseDroppedLoopsForDate(path: string, ymd: string): DroppedLine[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return []; }
  const lines = raw.split("\n");
  const out: DroppedLine[] = [];
  let currentDate: string | null = null;
  let currentHeading: string | null = null;
  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/);
    if (headingMatch) {
      currentDate = headingMatch[1];
      currentHeading = headingMatch[2].trim();
      continue;
    }
    if (currentDate !== ymd) continue;
    const bulletMatch = line.match(/^-\s+(.+)$/);
    if (bulletMatch && currentHeading) {
      out.push({ date: ymd, heading: currentHeading, bullet: bulletMatch[1].trim() });
    }
  }
  return out;
}

interface OpenLoop {
  id?: string;
  title?: string;
  created?: string;
}

function parseOpenLoops(path: string): OpenLoop[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === "object");
  } catch {
    return [];
  }
}

function parseJournalCheckpoints(path: string): string[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return []; }
  // Extract `### checkpoint (HH:MM ...)` blocks — these capture what
  // happened during the day in Mark's voice (the daemon writes them
  // when context arrives between scheduled tasks).
  const out: string[] = [];
  const re = /^###\s+checkpoint\s+\([^)]+\)\s*\n([\s\S]*?)(?=\n###\s|\n---\s|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const body = m[1].trim();
    if (body) out.push(body);
  }
  return out;
}

function deriveWinsFromClosures(closures: ClosureLine[]): string[] {
  // Closures = things that resolved today. We surface the DECISION and
  // non-text-message CLOSURE entries — texts are too noisy as wins.
  const wins: string[] = [];
  for (const c of closures) {
    if (c.kind === "DECISION") {
      wins.push(c.text);
      continue;
    }
    if (c.kind === "CLOSURE" && !/^texted\s+/i.test(c.text)) {
      wins.push(c.text);
    }
  }
  // De-dup adjacent identical entries (same closure logged twice)
  const dedup: string[] = [];
  for (const w of wins) {
    if (dedup[dedup.length - 1] !== w) dedup.push(w);
  }
  return dedup;
}

function countOutboundFromClosures(closures: ClosureLine[]): number {
  return closures.filter((c) => c.kind === "CLOSURE" && /^texted\s+/i.test(c.text)).length;
}

function isFridayLocal(d: Date): boolean {
  return d.getDay() === 5;
}

function isSaturdayNext(d: Date): boolean {
  // True if the day AFTER `d` is Saturday (Sabbath) — Friday afternoon's
  // tomorrow.
  return d.getDay() === 5;
}

export interface DebriefStateInputs {
  ymd: string;
  closures: ClosureLine[];
  dropped: DroppedLine[];
  openLoops: OpenLoop[];
  checkpoints: string[];
  outboundCount: number;
  isFriday: boolean;
}

export function gatherDebriefState(maxosHome: string, now: Date): DebriefStateInputs {
  const ymd = ymdLocal(now);
  const closuresPath = join(maxosHome, "workspace", "memory", `closures-${ymd}.md`);
  const droppedPath = join(maxosHome, "workspace", "memory", "dropped-loops.md");
  const openPath = join(maxosHome, "workspace", "memory", "open-loops.json");
  const journalPath = join(maxosHome, "workspace", "memory", `${ymd}.md`);
  const closures = parseClosuresFile(closuresPath);
  return {
    ymd,
    closures,
    dropped: parseDroppedLoopsForDate(droppedPath, ymd),
    openLoops: parseOpenLoops(openPath),
    checkpoints: parseJournalCheckpoints(journalPath),
    outboundCount: countOutboundFromClosures(closures),
    isFriday: isFridayLocal(now),
  };
}

export function formatDebriefFromState(s: DebriefStateInputs, now: Date): string {
  const wins = deriveWinsFromClosures(s.closures);
  const dropMentions = s.dropped.map((d) => `${d.heading}: ${d.bullet}`);
  const lines: string[] = [];
  const dayPart = `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;
  lines.push(`🌅 Shutdown Debrief - ${dayPart}`);
  lines.push("");
  lines.push("## ✅ Wins");
  if (wins.length === 0 && s.outboundCount === 0) {
    lines.push("- (no closures or outbound logged today)");
  } else {
    for (const w of wins.slice(0, 8)) lines.push(`- ${w}`);
    if (s.outboundCount > 0) lines.push(`- Outbound today: ${s.outboundCount} message(s) logged in closures`);
  }
  lines.push("");
  lines.push("## 👻 Ghosted");
  lines.push("- (no live ghosted-state available in recovered debrief — daemon's read-status check requires the LLM. Check open-loops + Telegram for anything pending.)");
  lines.push("");
  lines.push("## 🔄 Open Loops");
  if (s.openLoops.length === 0) {
    lines.push("- (none open)");
  } else {
    for (const l of s.openLoops.slice(0, 10)) {
      const id = l.id ?? "unknown";
      const title = l.title ?? "(no title in state)";
      lines.push(`- ${id} - ${title}`);
    }
  }
  if (dropMentions.length > 0) {
    lines.push("");
    lines.push("### Dropped today");
    for (const d of dropMentions.slice(0, 5)) lines.push(`- ${d}`);
  }
  lines.push("");
  lines.push("## 🎯 Top 3 for Tomorrow");
  if (s.isFriday) {
    lines.push("1. Saturday is Sabbath - no work tomorrow.");
    lines.push("2. Sunday: review open loops above + decide priorities then.");
    lines.push("3. Sunday morning brief at 6 AM will reset focus.");
  } else if (s.openLoops.length > 0) {
    const top = s.openLoops.slice(0, 3);
    top.forEach((l, i) => {
      lines.push(`${i + 1}. ${l.title ?? l.id ?? "open loop"}`);
    });
    while (top.length < 3) {
      const i = top.length;
      lines.push(`${i + 1}. (no additional open loop in state — set tomorrow's focus during morning brief)`);
      top.push({});
    }
  } else {
    lines.push("1. (no open loops in state - set tomorrow's focus during morning brief)");
    lines.push("2. (review the journal entries below for outstanding threads)");
    lines.push("3. (check Telegram for anything that came in after this debrief)");
  }
  lines.push("");
  lines.push("## 📅 Tomorrow");
  if (s.isFriday) {
    lines.push("Saturday - Sabbath. Brain off. Family on. No scheduled tasks fire tomorrow.");
  } else {
    lines.push("(calendar lookup not available in recovered debrief - check Google Calendar or wait for tomorrow's morning brief)");
  }
  if (s.checkpoints.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("### Today's checkpoints (raw, from journal)");
    for (const cp of s.checkpoints.slice(0, 4)) {
      const trimmed = cp.length > 280 ? cp.slice(0, 280) + "..." : cp;
      lines.push(trimmed);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function formatBriefFromState(s: DebriefStateInputs, now: Date): string {
  const lines: string[] = [];
  const dayPart = `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;
  lines.push(`☀️ Morning Brief - ${dayPart}`);
  lines.push("");
  lines.push("## 🪨 Top priority");
  if (s.openLoops.length > 0) {
    const top = s.openLoops[0];
    lines.push(`- ${top.title ?? top.id ?? "(open loop in state)"}`);
  } else {
    lines.push("- (no open loops in state — set focus this morning)");
  }
  lines.push("");
  lines.push("## 👻 Ghosted");
  lines.push("- (live ghosted-state requires the LLM-driven brief. Check Telegram + Gmail manually for anything pending response.)");
  lines.push("");
  lines.push("## 📍 First presence");
  lines.push("- (calendar lookup not available in recovered brief — check Google Calendar)");
  lines.push("");
  lines.push("## 🚨 Overnight");
  lines.push("- (overnight email/iMessage scan not available in recovered brief — manual check required)");
  return lines.join("\n");
}

function recoverFromState(maxosHome: string, kind: TaskKind, now: Date): RecoveryAttempt {
  const inputs = gatherDebriefState(maxosHome, now);
  const content = kind === "shutdown-debrief"
    ? formatDebriefFromState(inputs, now)
    : formatBriefFromState(inputs, now);
  // Confirm the synthesized content has the canonical header (so the
  // schema validator passes after the gateway prepends the banner).
  const schema = kind === "shutdown-debrief" ? SHUTDOWN_DEBRIEF_SCHEMA : MORNING_BRIEF_SCHEMA;
  const violation = validateAgainstSchema(content, schema, kind);
  if (violation.missingRequired.includes("header")) {
    return {
      recovered: false,
      reason: `state-recovery synthesized content missing header (impossible — bug)`,
    };
  }
  return {
    recovered: true,
    content,
    vaultPath: join(maxosHome, "workspace", "memory", `closures-${inputs.ymd}.md`),
  };
}

// ───── Morning Brew recovery (Round W, 2026-05-08) ─────

/**
 * Brew archive snapshot shape (what brew-archive.ts writeArchive writes).
 * Fields are loosely typed because the brew writes whatever the LLM
 * picked — we only validate the minimum-required fields and tolerate
 * the rest.
 */
interface BrewArchive {
  date?: string;
  ai?: { headline?: string; url?: string; source?: string; score?: number };
  prime?: {
    status?: string;
    url?: string;
    build?: boolean;
    candidate?: string;
    prototype?: string;
    reason?: string;
    suggest?: string;
  } | null;
  learning?: {
    track?: string;
    topic?: string;
    day?: number;
    type?: string;
    url?: string;
    alternative?: string;
  } | null;
  streak?: number;
  feedbackAppliedFrom?: string | null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatBrewDate(now: Date): string {
  return `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;
}

/**
 * Synthesize a minimum-viable brew from the archive snapshot. Deliberately
 * plain — no attempt to fake the LLM's voice. Mark sees "Recovered from
 * saved state" banner via gateway.ts so he knows this is not the polished
 * version.
 *
 * Returns null if the archive lacks the minimum field (ai.headline) — in
 * that case caller reports recovery failure and Mark gets the original
 * empty result with the "no output" alert.
 */
export function formatBrewFromArchive(snap: BrewArchive, now: Date): string | null {
  if (!snap?.ai?.headline) return null;
  const lines: string[] = [];
  lines.push(`☕️ Morning Brew - ${formatBrewDate(now)}`);
  lines.push("");
  lines.push("🧠 AI");
  lines.push(snap.ai.headline);
  const aiMeta: string[] = [];
  if (snap.ai.url) aiMeta.push(snap.ai.url);
  if (snap.ai.source) aiMeta.push(snap.ai.source);
  if (typeof snap.ai.score === "number") aiMeta.push(`score ${snap.ai.score}`);
  if (aiMeta.length > 0) lines.push(`Source: ${aiMeta.join(" · ")}`);

  if (snap.prime) {
    lines.push("");
    lines.push("⚡️ Prime Framework Hit");
    if (snap.prime.candidate) lines.push(snap.prime.candidate);
    if (snap.prime.url) lines.push(snap.prime.url);
    if (snap.prime.prototype) lines.push(`Prototype: ${snap.prime.prototype}`);
    if (snap.prime.reason) lines.push(snap.prime.reason);
    if (snap.prime.suggest) lines.push(snap.prime.suggest);
    if (snap.prime.build === true && !snap.prime.prototype) lines.push("Build status: complete (no prototype URL in archive)");
    if (snap.prime.build === false && !snap.prime.suggest) lines.push("Build status: skipped");
  }

  if (snap.learning) {
    lines.push("");
    const track = snap.learning.track ?? snap.learning.topic ?? "current track";
    const dayPart = typeof snap.learning.day === "number" ? `Day ${snap.learning.day}: ` : "";
    lines.push(`📚 Learning - ${dayPart}${track}`);
    if (snap.learning.url) lines.push(snap.learning.url);
    if (snap.learning.alternative) lines.push(`Alternative: ${snap.learning.alternative}`);
  }

  return lines.join("\n");
}

function recoverBrewFromArchive(maxosHome: string, now: Date): RecoveryAttempt {
  const date = ymdLocal(now);
  const archivePath = join(
    maxosHome,
    "workspace",
    "memory",
    "morning-brew",
    "archive",
    `${date}.json`,
  );
  if (!existsSync(archivePath)) {
    return {
      recovered: false,
      vaultPath: archivePath,
      reason: "no archive snapshot for today (brew failed before Archive step)",
    };
  }
  let snap: BrewArchive;
  try {
    snap = JSON.parse(readFileSync(archivePath, "utf-8")) as BrewArchive;
  } catch (err) {
    return {
      recovered: false,
      vaultPath: archivePath,
      reason: `archive parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const content = formatBrewFromArchive(snap, now);
  if (!content) {
    return {
      recovered: false,
      vaultPath: archivePath,
      reason: "archive missing required ai.headline field",
    };
  }
  return { recovered: true, content, vaultPath: archivePath };
}
