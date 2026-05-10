import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Dedicated Google Tasks list MaxOS owns. Mark sees it under "🤖 MaxOS Loops". */
export const MAXOS_LOOPS_LIST_ID = "V2p5LUtsRlFtRkcyb0xyYQ";

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: "needsAction" | "completed";
  updated: string;
}

interface GoogleTasksListResponse {
  items?: GoogleTask[];
}

/**
 * Discriminated result for listTasks. Distinguishes "API call succeeded
 * and returned an empty list" (ok: true, tasks: []) from "API call failed
 * and we have no idea what's actually there" (ok: false). The reconciler
 * MUST use this discriminator — without it, an auth refresh, network
 * timeout, or gws format change drops every tracked loop on the floor.
 */
export type ListTasksResult =
  | { ok: true; tasks: GoogleTask[] }
  | { ok: false; error: string };

const LOOP_MARKER_RE = /\[loop:([a-z0-9._\-]+)\]/i;

/**
 * Extract the loop id stamped into a task's notes by createTaskForLoop.
 * Returns null if the marker is missing — that's how we distinguish
 * MaxOS-managed tasks from anything Mark created manually in the same list.
 */
export function extractLoopId(notes: string | undefined): string | null {
  if (!notes) return null;
  const m = notes.match(LOOP_MARKER_RE);
  return m ? m[1] : null;
}

/** Build a notes string with the canonical [loop:ID] marker prepended. */
export function notesWithLoopMarker(loopId: string, freeText = ""): string {
  const head = `[loop:${loopId}]`;
  if (!freeText.trim()) return head;
  return `${head}\n\n${freeText.trim()}`;
}

async function gwsCall(args: string[], gws: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(gws, args, { timeout: timeoutMs });
  return stdout;
}

/**
 * List every task in the given list — active AND completed (last 30 days
 * for the completed window per Google Tasks API default). Caller filters.
 *
 * Returns a discriminated result so callers can distinguish "empty list"
 * from "API failure." Anything that goes wrong (auth, network, parse, gws
 * binary missing) becomes ok:false with the error message — the reconciler
 * uses this to bail without mutating state.
 */
export async function listTasks(
  listId: string = MAXOS_LOOPS_LIST_ID,
  gws = "gws-personal",
  timeoutMs = 10_000,
): Promise<ListTasksResult> {
  const params = JSON.stringify({
    tasklist: listId,
    showCompleted: true,
    showHidden: true,
    maxResults: 100,
  });
  try {
    const stdout = await gwsCall(
      ["tasks", "tasks", "list", "--params", params, "--format", "json"],
      gws,
      timeoutMs,
    );
    const trimmed = stripGwsHeaderNoise(stdout);
    if (!trimmed) {
      return { ok: false, error: "empty stdout (no JSON found)" };
    }
    const parsed = JSON.parse(trimmed) as GoogleTasksListResponse;
    return { ok: true, tasks: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Create a task tied to an open-loop. Notes carry the canonical [loop:ID]
 * marker so the reconciler can map the task back to the loop on every run.
 *
 * Returns the created task id, or null on failure (logged but not thrown —
 * scheduler-side reconciliation must be tolerant of transient API errors).
 */
export async function createTaskForLoop(
  loopId: string,
  title: string,
  options: {
    listId?: string;
    notes?: string;
    due?: string;
    gws?: string;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const listId = options.listId ?? MAXOS_LOOPS_LIST_ID;
  const gws = options.gws ?? "gws-personal";
  const timeoutMs = options.timeoutMs ?? 10_000;

  const notes = notesWithLoopMarker(loopId, options.notes ?? "");
  const body: Record<string, unknown> = { title, notes };
  if (options.due) body.due = options.due;

  try {
    const stdout = await gwsCall(
      [
        "tasks", "tasks", "insert",
        "--params", JSON.stringify({ tasklist: listId }),
        "--json", JSON.stringify(body),
        "--format", "json",
      ],
      gws,
      timeoutMs,
    );
    const trimmed = stripGwsHeaderNoise(stdout);
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as GoogleTask;
    return parsed.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Strip leading non-JSON noise (e.g., "Using keyring backend: keyring")
 * from gws-personal stdout. Walks lines, returns from the first line that
 * starts with "{" or "[" AND parses as valid JSON. Skipping the parse
 * verification would mis-pick a "[WARN] credentials expire..." preamble
 * as the start of JSON content; the parse-verify guards against that.
 */
export function stripGwsHeaderNoise(stdout: string): string {
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    const candidate = lines.slice(i).join("\n").trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}
