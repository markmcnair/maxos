import { loadOpenLoops, saveOpenLoops, type OpenLoop } from "./loop-reconciler.js";
import { readClosuresFile } from "./memory.js";
import {
  appendDroppedLoop,
  loadDroppedLoopIds,
  loadDroppedTopics,
  pruneOpenLoopsAgainstDropped,
} from "./dropped-loops-filter.js";

export interface ClosureEntry {
  time: string;
  tag: "CLOSURE" | "DECISION" | "FACT";
  body: string;
}

const CLOSURE_LINE_RE = /^-\s+\[(\d{1,2}:\d{2})\]\s+\[(CLOSURE|DECISION|FACT)\]\s+(.+?)\s*$/;

/**
 * Parse a single closure-log line. Returns null for lines that don't match
 * the SOUL.md-mandated format (`- [HH:MM] [TAG] body`). Tolerant of trailing
 * whitespace.
 */
export function parseClosureLine(line: string): ClosureEntry | null {
  const m = line.match(CLOSURE_LINE_RE);
  if (!m) return null;
  return { time: m[1], tag: m[2] as ClosureEntry["tag"], body: m[3].trim() };
}

const DROP_PATTERNS: RegExp[] = [
  /\bdrop(ped|ping)?\b/i,
  /\bkill(ed|ing)?\b/i,
  /\babandoned?\b/i,
  /no longer/i,
  /not (pursuing|pursing|happening|moving forward)/i,
  /paused indefinitely/i,
  /\b(was|is) wrong\b/i,
  // Copular forms only — bare "over", "done", "dead" are too noisy in
  // ordinary chat ("start over", "I'm done", "battery is dead in a different sense").
  /\b(was|is|are|were) (dead|over)\b/i,
  /\bnever real\b/i,
  /\b(is|are|was|were) (irrelevant|fake)\b/i,
  // Unambiguous standalone:
  /\birrelevant\b/i,
];

/**
 * True iff a closure entry is a [DECISION] that signals a loop should be
 * permanently retired. Pattern-based, deterministic, no LLM. Matches both
 * "drop X" and "X is over" forms.
 */
export function isDropDecision(entry: ClosureEntry): boolean {
  if (entry.tag !== "DECISION") return false;
  return DROP_PATTERNS.some((p) => p.test(entry.body));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the open loop a drop-decision body refers to. Match priority:
 *   1. Loop id flanked by non-id chars (treats hyphens as id chars so
 *      "kr" doesn't match inside "kr-wholesale-testimonials"). Ids are
 *      tried longest-first so "kr-wholesale-testimonials" wins over "kr".
 *   2. Multi-token person name (e.g. "Rachel Myers") — single first
 *      names like "Alfonso" are too generic and produce false positives
 *      in ordinary chat ("Alfonso meeting was great today").
 *   3. Topic phrase (first 3 ≥4-char words, e.g. "Kingdom Roasters wholesale").
 *
 * Returns null if nothing matches with reasonable confidence.
 */
export function findMatchingLoop(loops: OpenLoop[], decisionBody: string): OpenLoop | null {
  // Longest id first prevents shorter-prefix loops from winning a
  // substring match over more-specific siblings.
  const sortedById = [...loops].sort((a, b) => b.id.length - a.id.length);
  for (const l of sortedById) {
    // Match the id only when surrounded by non-id chars (whitespace,
    // punctuation, line edges). Treats `[a-z0-9._-]` as id chars.
    const idRe = new RegExp(
      `(^|[^a-z0-9._\\-])${escapeRegex(l.id)}([^a-z0-9._\\-]|$)`,
      "i",
    );
    if (idRe.test(decisionBody)) return l;
  }

  for (const l of loops) {
    if (!l.person) continue;
    const tokens = l.person.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue; // single first name is too noisy
    const re = new RegExp(`\\b${escapeRegex(l.person)}\\b`, "i");
    if (re.test(decisionBody)) return l;
  }

  for (const l of loops) {
    const words = l.topic.split(/\s+/).filter((w) => w.replace(/[^a-z0-9]/gi, "").length >= 4);
    if (words.length < 2) continue;
    const phrase = words.slice(0, 3).join(" ");
    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "i");
    if (re.test(decisionBody)) return l;
  }

  return null;
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * P0-1: parse a `[FACT] new-loop {json}` line emitted by the LLM-driven
 * shutdown-debrief. The LLM no longer edits open-loops.json directly —
 * instead it appends FACT lines to the closures file (which is naturally
 * append-only), and this function picks them up. Eliminates the
 * race between the LLM's non-atomic Edit/Write and the closure-watcher /
 * reconciler's atomic saveOpenLoops.
 *
 * Wire format:
 *   - [HH:MM] [FACT] new-loop {"id":"...","topic":"...","person":"...","phone":"...","email":"...","notes":"..."}
 *
 * Required: id (non-empty string), topic (non-empty string)
 * Optional: person, phone, email, notes
 *
 * Returns null on malformed input or missing required fields.
 */
export function parseNewLoopFact(line: string): {
  id: string;
  topic: string;
  person?: string;
  phone?: string;
  email?: string;
  notes?: string;
} | null {
  const entry = parseClosureLine(line);
  if (!entry || entry.tag !== "FACT") return null;
  const m = entry.body.match(/^new-loop\s+(\{.+\})\s*$/);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const topic = typeof o.topic === "string" ? o.topic.trim() : "";
  if (!id || !topic) return null;
  const out: ReturnType<typeof parseNewLoopFact> = { id, topic };
  if (typeof o.person === "string" && o.person.trim()) out!.person = o.person.trim();
  if (typeof o.phone === "string" && o.phone.trim()) out!.phone = o.phone.trim();
  if (typeof o.email === "string" && o.email.trim()) out!.email = o.email.trim();
  if (typeof o.notes === "string" && o.notes.trim()) out!.notes = o.notes.trim();
  return out;
}

/**
 * Round V helper. Scan CLOSURE / DECISION lines in the closure files and
 * record (loopId, position) for each one referencing a loop id. The
 * position is `fileIdx * 1_000_000 + lineIdx` so callers can compare
 * against a FACT line's position to detect "FACT then resolution" vs
 * "resolution then FACT" ordering.
 *
 * Loop-id extraction patterns:
 *  - CLOSURE: `... (loop <id>)` at end of body
 *  - DECISION drop (Round O+): `dropped (<id>) — ...`
 *  - DECISION drop (legacy):    `dropped <id> —`
 */
function collectResolutions(closureSources: string[]): Array<{ loopId: string; position: number }> {
  const out: Array<{ loopId: string; position: number }> = [];
  const closureLoopRe = /\(loop\s+([a-z0-9._\-]+)\)\s*$/i;
  const decisionDropParensRe = /^dropped\s+\(([a-z0-9._\-]+)\)\s+—/i;
  const decisionDropBareRe = /^dropped\s+([a-z0-9._\-]{3,})\s+—/i;

  for (let fileIdx = 0; fileIdx < closureSources.length; fileIdx++) {
    const lines = closureSources[fileIdx].split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const entry = parseClosureLine(line);
      if (!entry) continue;
      const position = fileIdx * 1_000_000 + lineIdx;
      if (entry.tag === "CLOSURE") {
        const m = entry.body.match(closureLoopRe);
        if (m) out.push({ loopId: m[1], position });
      } else if (entry.tag === "DECISION") {
        const m1 = entry.body.match(decisionDropParensRe);
        if (m1) {
          out.push({ loopId: m1[1], position });
          continue;
        }
        const m2 = entry.body.match(decisionDropBareRe);
        if (m2) {
          out.push({ loopId: m2[1], position });
        }
      }
    }
  }
  return out;
}

function resolutionAfter(
  resolutions: Array<{ loopId: string; position: number }>,
  loopId: string,
  factPosition: number,
): boolean {
  for (const r of resolutions) {
    if (r.loopId === loopId && r.position > factPosition) return true;
  }
  return false;
}

/**
 * P0-1: process today's + yesterday's closures, find any [FACT] new-loop
 * lines, and add them to open-loops.json — atomically via saveOpenLoops.
 *
 * Tombstone-aware: if a parsed loop's id is on the dropped-loops.md
 * tombstone list (or matches by keyword), the loop is silently skipped
 * and reported in `blockedByTombstone`. This means the LLM trying to
 * re-create a previously-deleted loop just no-ops — the determinism
 * holds without the LLM having to remember.
 *
 * Idempotent: a loop already in open-loops.json (by id) is skipped.
 *
 * Returns:
 *  - added: ids that were newly added
 *  - blockedByTombstone: ids the LLM tried to add that were tombstoned
 */
export function applyNewLoopFactsFromClosures(
  maxosHome: string,
  now: Date = new Date(),
): { added: string[]; blockedByTombstone: string[] } {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const closureSources = [
    readClosuresFile(maxosHome, now) ?? "",
    readClosuresFile(maxosHome, yesterday) ?? "",
  ];

  const droppedTopics = loadDroppedTopics(maxosHome);
  const droppedIds = loadDroppedLoopIds(maxosHome);
  const droppedIdSet = new Set(droppedIds);

  const existingLoops = loadOpenLoops(maxosHome);
  const existingIds = new Set(existingLoops.map((l) => l.id));

  // Round V (2026-05-08) Toyota-loop dup-fire fix:
  //
  // Index every CLOSURE / DECISION line in the scanned closures files by
  // (loop_id, line_position). When a FACT new-loop is found, check whether
  // the SAME loop id has any CLOSURE or DECISION later in the same files.
  // If so, the FACT was already consumed — skip silently to prevent the
  // ping-pong loop where reconciler closes, closure-watcher re-adds.
  //
  // Each entry is `{ loopId, position }` where position is a stable
  // ordering key (file_index * 1e9 + line_index). FACT-after-resolution
  // must still be ALLOWED — that's a legitimate re-raise after closure.
  const resolutions = collectResolutions(closureSources);

  const today = ymdLocal(now);
  const seenInThisRun = new Set<string>();
  const added: string[] = [];
  const blockedByTombstone: string[] = [];
  const newLoops: OpenLoop[] = [];

  for (let fileIdx = 0; fileIdx < closureSources.length; fileIdx++) {
    const source = closureSources[fileIdx];
    const lines = source.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const factPosition = fileIdx * 1_000_000 + lineIdx;
      const parsed = parseNewLoopFact(line);
      if (!parsed) continue;
      // Dedup within this run (same id appearing in both yesterday + today)
      if (seenInThisRun.has(parsed.id)) continue;
      seenInThisRun.add(parsed.id);
      // Already in open-loops → skip silently (idempotent)
      if (existingIds.has(parsed.id)) continue;
      // Tombstoned by exact id → block
      if (droppedIdSet.has(parsed.id)) {
        blockedByTombstone.push(parsed.id);
        continue;
      }
      // Round V: FACT was already resolved by a later CLOSURE/DECISION on
      // the same loop id within the closure-window — skip. (FACT-after-
      // resolution is allowed: that's a legit re-raise.)
      if (resolutionAfter(resolutions, parsed.id, factPosition)) {
        continue;
      }
      // Tombstoned by keyword (catches re-adds that kept similar topic
      // but invented a new id slug) — run the same prune that closure-
      // watcher uses
      const candidate: OpenLoop = {
        id: parsed.id,
        topic: parsed.topic,
        firstSeen: today,
        lastUpdated: today,
        ...(parsed.person ? { person: parsed.person } : {}),
        ...(parsed.phone ? { phone: parsed.phone } : {}),
        ...(parsed.email ? { email: parsed.email } : {}),
        ...(parsed.notes ? { notes: parsed.notes } : {}),
      };
      const { pruned } = pruneOpenLoopsAgainstDropped([candidate], droppedTopics, []);
      if (pruned.length > 0) {
        blockedByTombstone.push(parsed.id);
        continue;
      }
      newLoops.push(candidate);
      added.push(parsed.id);
    }
  }

  if (newLoops.length > 0) {
    saveOpenLoops(maxosHome, [...existingLoops, ...newLoops]);
  }

  return { added, blockedByTombstone };
}

/**
 * Process today's and yesterday's closures, find [DECISION] drops, and
 * remove any matching open-loop entries. Self-healing — runs every 15 min
 * via closure-watcher, so a chat-session correction propagates within one
 * cycle and the next morning brief never sees the dropped loop.
 *
 * Audit P1-3: ALSO appends a permanent tombstone to dropped-loops.md for
 * each match. Without this, verbal drops were only enforced for 2 days
 * (the closures-file scan window), and the LLM-driven debrief could
 * resurrect the loop from a fresh meeting transcript on day 3+.
 *
 * Source attribution: drops triggered by Google-Task-deletion DECISION
 * lines (which the reconciler writes — they have an explicit "Google Task
 * deleted" marker) get `source: "google-task-deletion"`. Anything else
 * (chat-session DECISIONs from SOUL.md "drop X" / "kill that thread")
 * gets `source: "verbal"`. Either way the tombstone is permanent, but
 * the reason text reflects the source so future audits stay debuggable.
 *
 * Returns the list of loop ids that were removed (for logging).
 */
export function applyDropDecisionsToLoops(
  maxosHome: string,
  now: Date = new Date(),
): { removed: string[] } {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const closureSources = [
    readClosuresFile(maxosHome, now) ?? "",
    readClosuresFile(maxosHome, yesterday) ?? "",
  ];

  const loops = loadOpenLoops(maxosHome);
  if (loops.length === 0) return { removed: [] };

  const dropMatches = new Map<string, { loop: OpenLoop; body: string }>();
  for (const source of closureSources) {
    for (const line of source.split("\n")) {
      const entry = parseClosureLine(line);
      if (!entry) continue;
      if (!isDropDecision(entry)) continue;
      const matched = findMatchingLoop(loops, entry.body);
      if (matched && !dropMatches.has(matched.id)) {
        dropMatches.set(matched.id, { loop: matched, body: entry.body });
      }
    }
  }

  if (dropMatches.size === 0) return { removed: [] };

  // Audit P1-3: write a permanent tombstone for each verbal/Google-Tasks
  // drop. The reconciler already writes its own tombstone on the same
  // cycle (so Google-Task drops can hit appendDroppedLoop twice — but it's
  // idempotent on (loop:xxx)).
  const droppedDate = ymdLocal(now);
  for (const { loop, body } of dropMatches.values()) {
    const isGoogleTaskSourced = /Google Task deleted/i.test(body);
    appendDroppedLoop(maxosHome, {
      topic: loop.topic,
      loopId: loop.id,
      date: droppedDate,
      reason: isGoogleTaskSourced
        ? 'Mark deleted Google Task from "🤖 MaxOS Loops"'
        : `Mark dropped this in conversation: "${body.slice(0, 120)}"`,
      source: isGoogleTaskSourced ? "google-task-deletion" : "verbal",
      person: loop.person,
    });
  }

  const droppedIds = new Set(dropMatches.keys());
  const remaining = loops.filter((l) => !droppedIds.has(l.id));
  saveOpenLoops(maxosHome, remaining);
  return { removed: Array.from(droppedIds) };
}
