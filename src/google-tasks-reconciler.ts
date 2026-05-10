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
  return `- [${hhmm(now)}] [DECISION] dropped${idTag} — Google Task deleted (Mark removed it from "🤖 MaxOS Loops"), so ${title} was never real`;
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
): Promise<{ closures: number; drops: number; creates: number; skippedReason?: string }> {
  const maxosHome = options.maxosHome ?? process.env.MAXOS_HOME ?? `${process.env.HOME}/.maxos`;
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
  if (!stateResult.ok) {
    console.error(`google-tasks-reconciler: skipped — ${stateResult.error}`);
    return { closures: 0, drops: 0, creates: 0, skippedReason: stateResult.error };
  }
  const state = stateResult.state;

  const tasksResult = await listFn(listId, gws);

  // CRITICAL: bail out without mutating state when the API call fails.
  // Without this guard, a transient auth refresh, network blip, or gws
  // format change would mass-drop every tracked loop because reconcileTasks
  // can't tell "list is empty" from "list lookup failed".
  if (!tasksResult.ok) {
    console.error(`google-tasks-reconciler: skipped — listTasks failed: ${tasksResult.error}`);
    return { closures: 0, drops: 0, creates: 0, skippedReason: tasksResult.error };
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
      reason: 'Mark deleted Google Task from "🤖 MaxOS Loops"',
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

  // Creates → call API, add successful ids to state
  const updatedState: ReconcilerState = { loopToTask: { ...decision.newState.loopToTask } };
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
    }
  }

  saveState(maxosHome, updatedState);

  return {
    closures: decision.closures.length,
    drops: decision.drops.length,
    creates: decision.creates.length,
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
const isCLI = process.argv[1]?.endsWith("google-tasks-reconciler.js");
if (isCLI) {
  runGoogleTasksReconciler().then((r) => {
    if (process.env.MAXOS_GTASKS_VERBOSE || r.closures + r.drops + r.creates > 0) {
      console.log(
        `google-tasks-reconciler: closures=${r.closures}, drops=${r.drops}, creates=${r.creates}`,
      );
    }
  }).catch((err) => {
    console.error("google-tasks-reconciler failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
