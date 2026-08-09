import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  listTasks as defaultListTasks,
  createTaskForLoop as defaultCreateTaskForLoop,
  extractLoopId,
  type GoogleTask,
  type ListTasksResult,
  MAXOS_LOOPS_LIST_ID,
} from "./google-tasks.js";
import { loadOpenLoops, saveOpenLoops, type OpenLoop } from "./loop-reconciler.js";
import { appendDroppedLoop } from "./dropped-loops-filter.js";

/**
 * Dependency-injection seam for the orchestrator. Tests pass mocks here;
 * production calls the real google-tasks module. Keeps the orchestrator
 * testable without resorting to module-level mocks.
 */
export interface RunReconcilerDeps {
  listTasks?: (listId: string, gws: string) => Promise<ListTasksResult>;
  createTaskForLoop?: (
    loopId: string,
    title: string,
    options: { listId?: string; notes?: string; due?: string; gws?: string },
  ) => Promise<string | null>;
}

interface ReconcilerState {
  /** Loop id → Google Task id. Lets us notice when a task disappears. */
  loopToTask: Record<string, string>;
}

function statePath(maxosHome: string): string {
  return join(maxosHome, "workspace", "memory", "google-tasks-state.json");
}

/**
 * Loaded state — either successfully parsed, or a corruption signal.
 *
 * Audit P1-1: silently resetting a corrupt state file to "empty" used to
 * mean "every previously-tracked loop now looks tracked-but-missing on the
 * next run" → mass DROP. The reconciler must bail out (same failure mode
 * as the listTasks-fail guard at line ~217) rather than treating corruption
 * as "no tracked loops."
 */
type LoadStateResult =
  | { ok: true; state: ReconcilerState }
  | { ok: false; error: string };

function loadState(maxosHome: string): LoadStateResult {
  const path = statePath(maxosHome);
  if (!existsSync(path)) return { ok: true, state: { loopToTask: {} } };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return {
      ok: false,
      error: `state.json parse failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as Record<string, unknown>).loopToTask !== "object" ||
    (raw as Record<string, unknown>).loopToTask === null ||
    Array.isArray((raw as Record<string, unknown>).loopToTask)
  ) {
    return { ok: false, error: "state.json has invalid shape" };
  }
  // Filter to string→string entries only — guards against partial corruption
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(
    (raw as { loopToTask: Record<string, unknown> }).loopToTask,
  )) {
    if (typeof v === "string" && v.length > 0) {
      cleaned[k] = v;
    }
  }
  return { ok: true, state: { loopToTask: cleaned } };
}

function saveState(maxosHome: string, state: ReconcilerState): void {
  const path = statePath(maxosHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function appendClosureLine(maxosHome: string, now: Date, line: string): void {
  const path = join(maxosHome, "workspace", "memory", `closures-${ymdLocal(now)}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const prefix = existing.endsWith("\n") || existing === "" ? "" : "\n";
  appendFileSync(path, prefix + line + "\n");
}

function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export interface ReconcileTasksInput {
  loops: OpenLoop[];
  tasks: GoogleTask[];
  state: ReconcilerState;
}

export interface ReconcileTasksDecision {
  /** Loop ids whose Google Task was completed → close as a CLOSURE. */
  closures: { loopId: string; title: string }[];
  /** Loop ids whose Google Task was deleted by Mark → drop via DECISION. */
  drops: { loopId: string; title: string }[];
  /** Loops that should have a Google Task created (none exists yet). */
  creates: OpenLoop[];
  /** New state after applying these decisions. */
  newState: ReconcilerState;
}

/**
 * Pure-function core: given the current loops, the current Google Tasks
 * list, and the previous reconciler state, return the set of decisions
 * to apply. No side effects — testable directly.
 *
 * State machine per loop:
 *   - In state, task present, completed → CLOSURE (write line, drop from state + loops)
 *   - In state, task present, active    → no-op (still open)
 *   - In state, task MISSING            → Mark deleted it → DROP (write DECISION, drop from state + loops)
 *   - Not in state                       → CREATE a new task, add to state
 *
 * "In state" means we previously created a task for this loop. Manual
 * Google-Tasks edits Mark made outside MaxOS are ignored — we only manage
 * the tasks we ourselves created (matched via the [loop:ID] notes marker).
 */
export function reconcileTasks(input: ReconcileTasksInput): ReconcileTasksDecision {
  const { loops, tasks, state } = input;
  const closures: ReconcileTasksDecision["closures"] = [];
  const drops: ReconcileTasksDecision["drops"] = [];
  const creates: OpenLoop[] = [];
  const newLoopToTask: Record<string, string> = {};

  // Index Google tasks by loopId from notes marker (the only ones we manage)
  const tasksByLoopId = new Map<string, GoogleTask>();
  for (const t of tasks) {
    const lid = extractLoopId(t.notes);
    if (lid) tasksByLoopId.set(lid, t);
  }

  const loopById = new Map<string, OpenLoop>();
  for (const l of loops) loopById.set(l.id, l);

  // Process each loop
  for (const loop of loops) {
    const trackedTaskId = state.loopToTask[loop.id];
    const liveTask = tasksByLoopId.get(loop.id);

    if (trackedTaskId && !liveTask) {
      // We tracked it, but the task is gone now → Mark deleted it
      drops.push({ loopId: loop.id, title: loop.topic });
      continue;
    }

    if (liveTask && liveTask.status === "completed") {
      closures.push({ loopId: loop.id, title: loop.topic });
      continue;
    }

    if (liveTask) {
      // Active task, still open — preserve mapping
      newLoopToTask[loop.id] = liveTask.id;
      continue;
    }

    // No task exists → create one
    creates.push(loop);
  }

  return { closures, drops, creates, newState: { loopToTask: newLoopToTask } };
}

/** Format a closure log line for a Google-Tasks-driven completion. */
export function formatClosureLine(now: Date, title: string, loopId?: string): string {
  const idTag = loopId ? ` (loop ${loopId})` : "";
  return `- [${hhmm(now)}] [CLOSURE] Google Task completed — ${title}${idTag}`;
}

/**
 * Format a drop-decision log line that closures-to-loops can match:
 *   - tag is [DECISION], so isDropDecision flags it
 *   - body contains "dropped" → matches DROP_PATTERNS
 *   - body contains the literal loop id → findMatchingLoop matches by id
 */
export function formatDropLine(now: Date, title: string, loopId?: string): string {
  const idTag = loopId ? ` (${loopId})` : "";
  return `- [${hhmm(now)}] [DECISION] dropped${idTag} — Google Task deleted (Mark removed it from "Priority Bucket"), so ${title} was never real`;
}

/**
 * Outcome of one reconciler run.
 *
 * `creates` counts tasks the API actually created — NOT the number we meant to
 * create. Reporting the intent was how "creates=2" came to mean "two API calls
 * that both silently returned null." `createFailures` carries the difference so
 * the run can exit non-zero.
 */
export interface ReconcilerRunResult {
  closures: number;
  drops: number;
  /** Tasks the API confirmed it created. */
  creates: number;
  /** Creations that were attempted and failed. */
  createFailures?: number;
  /**
   * Set when the run bailed out without mutating anything. Carries the RAW
   * cause; which stage failed is reported separately in skippedStage so
   * callers can compose their own message without string-parsing this one.
   */
  skippedReason?: string;
  /** Which stage bailed, for log composition. */
  skippedStage?: "state" | "listTasks";
}

/**
 * Process exit code for a run. A skipped run or a failed creation must NOT
 * exit 0: the cron ticker judges a job purely by its exit status, so exiting 0
 * on failure made every real outage — the 2026-08-05→07 DNS and auth failures
 * among them — indistinguishable from success to every monitor watching.
 */
export function exitCodeForResult(result: ReconcilerRunResult): number {
  if (result.skippedReason) return 1;
  if ((result.createFailures ?? 0) > 0) return 1;
  return 0;
}

/**
 * One-line, ISO-stamped run summary. Emitted unconditionally: the old code
 * printed nothing unless work happened, which made log silence mean either
 * "healthy and idle" or "dead" with no way to tell them apart. A timestamp on
 * every line also makes failure windows recoverable after the fact.
 */
export function formatRunSummary(result: ReconcilerRunResult, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (result.skippedReason) {
    const stage =
      result.skippedStage === "listTasks"
        ? "listTasks failed: "
        : result.skippedStage === "state"
          ? "state load failed: "
          : "";
    return `${stamp} google-tasks-reconciler: skipped — ${stage}${result.skippedReason}`;
  }
  const failures = result.createFailures ?? 0;
  const tail = failures > 0 ? `, createFailures=${failures}` : "";
  return (
    `${stamp} google-tasks-reconciler: closures=${result.closures}, ` +
    `drops=${result.drops}, creates=${result.creates}${tail}`
  );
}

/**
 * Apply reconciler decisions: write closures, write drops, create new tasks,
 * update the open-loops file, persist state. Has side effects; orchestrated
 * separately so unit tests can hit reconcileTasks() in isolation.
 */
export async function runGoogleTasksReconciler(
  options: {
    maxosHome?: string;
    now?: Date;
    gws?: string;
    listId?: string;
    deps?: RunReconcilerDeps;
  } = {},
): Promise<ReconcilerRunResult> {
  const maxosHome = options.maxosHome ?? process.env.MAXOS_HOME ?? `${process.env.HOME}/.hermes`;
  const now = options.now ?? new Date();
  const gws = options.gws ?? "gws-personal";
  const listId = options.listId ?? MAXOS_LOOPS_LIST_ID;
  const listFn = options.deps?.listTasks ?? defaultListTasks;
  const createFn = options.deps?.createTaskForLoop ?? defaultCreateTaskForLoop;

  const loops = loadOpenLoops(maxosHome);
  const stateResult = loadState(maxosHome);

  // Audit P1-1: bail out without mutating state when state.json is corrupt.
  // Otherwise reconcileTasks treats every tracked loop as "missing" → mass
  // DROP. Same failure mode as the listTasks-fail bail-out below.
  // The skip reason travels in the result rather than being logged here, so
  // the CLI emits exactly ONE timestamped line per run instead of an unstamped
  // line plus a stamped summary.
  if (!stateResult.ok) {
    return {
      closures: 0,
      drops: 0,
      creates: 0,
      createFailures: 0,
      skippedReason: stateResult.error,
      skippedStage: "state",
    };
  }
  const state = stateResult.state;

  const tasksResult = await listFn(listId, gws);

  // CRITICAL: bail out without mutating state when the API call fails.
  // Without this guard, a transient auth refresh, network blip, or gws
  // format change would mass-drop every tracked loop because reconcileTasks
  // can't tell "list is empty" from "list lookup failed".
  if (!tasksResult.ok) {
    return {
      closures: 0,
      drops: 0,
      creates: 0,
      createFailures: 0,
      skippedReason: tasksResult.error,
      skippedStage: "listTasks",
    };
  }
  const tasks = tasksResult.tasks;

  const decision = reconcileTasks({ loops, tasks, state });

  // Closures → write to today's closures log AND drop from open-loops
  for (const c of decision.closures) {
    appendClosureLine(maxosHome, now, formatClosureLine(now, c.title, c.loopId));
  }

  // Drops → write [DECISION] lines; closures-to-loops will pick those up
  // and drop the matching open-loop on its next pass. We DO NOT write
  // open-loops directly here — closures-to-loops has the matching logic
  // already, and we want one source of truth for "what drops a loop".
  //
  // ALSO append a permanent tombstone to dropped-loops.md. The closures
  // file is only scanned for 2 days; without the persistent tombstone the
  // LLM-driven debrief re-extracts the same loop from a fresh meeting
  // transcript on day 3 and the reconciler obediently re-creates the
  // Google Task. Round O closes that loop.
  const loopById = new Map(loops.map((l) => [l.id, l]));
  const droppedDate = ymdLocal(now);
  for (const d of decision.drops) {
    appendClosureLine(maxosHome, now, formatDropLine(now, d.title, d.loopId));
    const orig = loopById.get(d.loopId);
    appendDroppedLoop(maxosHome, {
      topic: d.title,
      loopId: d.loopId,
      date: droppedDate,
      reason: 'Mark deleted Google Task from "Priority Bucket"',
      source: "google-task-deletion",
      person: orig?.person,
    });
  }

  // For closures, we DO want to remove the loop right now so the next
  // brief doesn't see it as still-open. (Drops will get cleaned up by
  // closures-to-loops on its next watcher cycle.)
  if (decision.closures.length > 0) {
    const closedIds = new Set(decision.closures.map((c) => c.loopId));
    const remaining = loops.filter((l) => !closedIds.has(l.id));
    saveOpenLoops(maxosHome, remaining);
  }

  // Creates → call API, add successful ids to state. Count what the API
  // actually did: a null return is a failure, and reporting it as a create
  // (which the old `creates: decision.creates.length` did) hid every
  // creation outage behind a healthy-looking number.
  const updatedState: ReconcilerState = { loopToTask: { ...decision.newState.loopToTask } };
  let created = 0;
  let createFailures = 0;
  for (const loop of decision.creates) {
    const title = formatTaskTitle(loop);
    const taskNotes = formatTaskNotes(loop);
    const taskId = await createFn(loop.id, title, {
      listId,
      notes: taskNotes,
      gws,
    });
    if (taskId) {
      updatedState.loopToTask[loop.id] = taskId;
      created++;
    } else {
      // Deliberately not recorded in state — the loop stays untracked so the
      // next cycle retries it rather than treating it as mirrored.
      createFailures++;
      console.error(
        `google-tasks-reconciler: create FAILED for loop ${loop.id} — will retry next cycle`,
      );
    }
  }

  saveState(maxosHome, updatedState);

  return {
    closures: decision.closures.length,
    drops: decision.drops.length,
    creates: created,
    createFailures,
  };
}

/**
 * Build the human-facing task title. Mark sees this in his Google Tasks
 * app — keep it scannable, mention the person if known.
 */
export function formatTaskTitle(loop: OpenLoop): string {
  if (loop.person) return `${loop.person}: ${loop.topic}`;
  return loop.topic;
}

export function formatTaskNotes(loop: OpenLoop): string {
  const lines: string[] = [];
  if (loop.notes) lines.push(loop.notes);
  lines.push(`First seen: ${loop.firstSeen}`);
  lines.push(``);
  lines.push(`Created by MaxOS. Delete this task to tell MaxOS the loop wasn't real.`);
  lines.push(`Mark complete when done — MaxOS will move it to wins on the next run.`);
  return lines.join("\n");
}

// CLI entry — `node dist/src/google-tasks-reconciler.js` (cron)
//
// Writes exactly one stamped summary line per run and exits non-zero on any
// failure, so the cron ticker's exit status and the log's freshness both mean
// what a reader assumes they mean.
const isCLI = process.argv[1]?.endsWith("google-tasks-reconciler.js");
if (isCLI) {
  runGoogleTasksReconciler().then((r) => {
    const summary = formatRunSummary(r);
    if (r.skippedReason || (r.createFailures ?? 0) > 0) {
      console.error(summary);
    } else {
      console.log(summary);
    }
    process.exitCode = exitCodeForResult(r);
  }).catch((err) => {
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    console.error(
      `${stamp} google-tasks-reconciler failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });
}
