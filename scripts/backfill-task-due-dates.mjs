// One-off backfill: give every already-created MaxOS loop task a due date.
//
// Mark, 2026-08-12: "add a date to them because these were all lost for me
// without scrolling all the way down." The reconciler now sets `due` on
// CREATE, but tasks it created before that fix are already in his Priority
// Bucket under "No date" and it will never touch them again (they're in
// google-tasks-state.json, so they're not re-created).
//
// Only touches tasks that (a) carry a [loop:ID] marker MaxOS wrote and
// (b) have no due date already. Never edits a task Mark created himself,
// never overwrites a date he set by hand.
//
// Run: node scripts/backfill-task-due-dates.mjs [--apply]
// Default is a dry run.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APPLY = process.argv.includes("--apply");
const LIST_ID = process.env.MAXOS_TASKS_LIST_ID ?? "@default";
const GWS = process.env.MAXOS_GWS ?? "gws-personal";
const HOME_DIR = process.env.MAXOS_HOME ?? "/Users/Max/.hermes";

const gws = async (args) => {
  const { stdout } = await execFileAsync(`/Users/Max/bin/${GWS}`, args, { timeout: 20_000 });
  // gws prints "Using keyring backend: ..." before the JSON body.
  const start = stdout.search(/^[[{]/m);
  return start === -1 ? null : JSON.parse(stdout.slice(start));
};

const loopIdOf = (notes) => (notes ?? "").match(/\[loop:([A-Za-z0-9._-]+)\]/)?.[1] ?? null;

const loops = JSON.parse(readFileSync(`${HOME_DIR}/workspace/memory/open-loops.json`, "utf-8"));
const firstSeenById = new Map(loops.map((l) => [l.id, l.firstSeen]));

// Same rule as formatTaskDue in the reconciler: date-only, pinned to midnight
// UTC, because Google reads `due` as a calendar date and throws away the time.
const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const todayLocal = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const dueFor = (loopId) => {
  const raw = firstSeenById.get(loopId);
  const date = /^\d{4}-\d{2}-\d{2}/.test(raw ?? "") ? raw.slice(0, 10) : todayLocal;
  return `${date}T00:00:00.000Z`;
};

const page = await gws(["tasks", "tasks", "list", "--params",
  JSON.stringify({ tasklist: LIST_ID, maxResults: 100, showCompleted: false }),
  "--format", "json"]);

const tasks = page?.items ?? [];
const targets = tasks.filter((t) => loopIdOf(t.notes) && !t.due);

console.log(`${tasks.length} open tasks in ${LIST_ID}; ${targets.length} MaxOS loop tasks missing a due date.\n`);

let patched = 0;
let failed = 0;
for (const t of targets) {
  const loopId = loopIdOf(t.notes);
  const due = dueFor(loopId);
  const label = `${due.slice(0, 10)}  ${t.title.split("\n")[0].slice(0, 70)}`;
  if (!APPLY) {
    console.log(`  would set ${label}`);
    continue;
  }
  try {
    await gws(["tasks", "tasks", "patch", "--params",
      JSON.stringify({ tasklist: LIST_ID, task: t.id }),
      "--json", JSON.stringify({ due }), "--format", "json"]);
    console.log(`  set ${label}`);
    patched++;
  } catch (err) {
    console.error(`  FAILED ${t.id} (${loopId}): ${err.message}`);
    failed++;
  }
}

if (!APPLY) console.log(`\nDry run. Re-run with --apply to write these.`);
else console.log(`\npatched=${patched} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
