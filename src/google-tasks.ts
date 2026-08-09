import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Google Tasks list the reconciler targets. The old dedicated "🤖 MaxOS Loops"
 * list (V2p5LUtsRlFtRkcyb0xyYQ) was deleted ~2026-06-06; loops now live in
 * Mark's main Priority Bucket list, which the Tasks API addresses as
 * "@default". Wrapper script google-tasks-reconciler.sh exports
 * MAXOS_TASKS_LIST_ID to override.
 */
export const MAXOS_LOOPS_LIST_ID = process.env.MAXOS_TASKS_LIST_ID ?? "@default";

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
  nextPageToken?: string;
}

/**
 * Injectable gws invoker. Production uses the real execFile; tests substitute
 * a fake so pagination can be exercised without shelling out.
 */
export type GwsExec = (args: string[], gws: string, timeoutMs: number) => Promise<string>;

/**
 * Hard ceiling on pages walked per listTasks call (100 tasks/page → 5000).
 * Hitting it means we cannot prove we saw the whole list, which is reported
 * as ok:false rather than as a short list — see the note on MAX_PAGES use.
 */
const MAX_PAGES = 50;

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
 *
 * PAGINATES. The Tasks API caps a page at 100 items and hands back a
 * nextPageToken; ignoring it used to silently return the first 100 of Mark's
 * 255-task Priority Bucket as ok:true. reconcileTasks reads "tracked task not
 * in the list" as "Mark deleted it" and DROPS the loop with a permanent
 * tombstone, so a truncated list is a data-loss bug, not a display bug — five
 * real loops died that way on 2026-07-07, five days after loops moved from the
 * small dedicated list into the main bucket.
 *
 * Any doubt about completeness (a page failing, an unparseable page, a
 * repeated token, or blowing MAX_PAGES) returns ok:false. Skipping a cycle is
 * always cheaper than dropping live commitments.
 */
export async function listTasks(
  listId: string = MAXOS_LOOPS_LIST_ID,
  gws = "gws-personal",
  timeoutMs = 10_000,
  exec: GwsExec = gwsCall,
): Promise<ListTasksResult> {
  const tasks: GoogleTask[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let pageNum = 1; ; pageNum++) {
    if (pageNum > MAX_PAGES) {
      return {
        ok: false,
        error: `pagination exceeded ${MAX_PAGES} pages — refusing to treat a truncated list as complete`,
      };
    }

    const params: Record<string, unknown> = {
      tasklist: listId,
      showCompleted: true,
      showHidden: true,
      maxResults: 100,
    };
    if (pageToken) params.pageToken = pageToken;

    let parsed: GoogleTasksListResponse;
    try {
      const stdout = await exec(
        ["tasks", "tasks", "list", "--params", JSON.stringify(params), "--format", "json"],
        gws,
        timeoutMs,
      );
      const trimmed = stripGwsHeaderNoise(stdout);
      if (!trimmed) {
        return { ok: false, error: `empty stdout (no JSON found) on page ${pageNum}` };
      }
      parsed = JSON.parse(trimmed) as GoogleTasksListResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: pageNum === 1 ? msg : `page ${pageNum} failed: ${msg}` };
    }

    if (Array.isArray(parsed.items)) tasks.push(...parsed.items);

    const next = parsed.nextPageToken;
    if (!next) return { ok: true, tasks };

    // A token we have already followed means the API is looping us. Without
    // this guard the loop would spin until MAX_PAGES burning API quota.
    if (seenTokens.has(next)) {
      return {
        ok: false,
        error: `pagination stalled — API repeated pageToken after page ${pageNum}`,
      };
    }
    seenTokens.add(next);
    pageToken = next;
  }
}

/**
 * Create a task tied to an open-loop. Notes carry the canonical [loop:ID]
 * marker so the reconciler can map the task back to the loop on every run.
 *
 * Returns the created task id, or null on failure. Reconciliation must be
 * tolerant of transient API errors, so failures do not throw — but they are
 * no longer silent: every failure path calls onError (default: stderr). The
 * old bare `catch {}` meant a run could report "creates=2" having created
 * nothing at all, with no trace anywhere.
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
    exec?: GwsExec;
    onError?: (message: string) => void;
  } = {},
): Promise<string | null> {
  const listId = options.listId ?? MAXOS_LOOPS_LIST_ID;
  const gws = options.gws ?? "gws-personal";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const exec = options.exec ?? gwsCall;
  const onError =
    options.onError ??
    ((message: string) => console.error(`google-tasks: create failed — ${message}`));

  const notes = notesWithLoopMarker(loopId, options.notes ?? "");
  const body: Record<string, unknown> = { title, notes };
  if (options.due) body.due = options.due;

  try {
    const stdout = await exec(
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
    if (!trimmed) {
      onError(`loop ${loopId}: empty stdout (no JSON found)`);
      return null;
    }
    const parsed = JSON.parse(trimmed) as GoogleTask;
    if (!parsed.id) {
      onError(`loop ${loopId}: response carried no task id`);
      return null;
    }
    return parsed.id;
  } catch (err) {
    onError(`loop ${loopId}: ${err instanceof Error ? err.message : String(err)}`);
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
