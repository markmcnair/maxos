import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAndSummarize, type OutboundSummary } from "./outbound-log.js";

export interface HealthSummaryInput {
  maxosHome: string;
  /** Daemon start time (ms since epoch). */
  daemonStartTime: number;
  /** Override "now" for tests. */
  now?: number;
}

interface SchedulerState {
  failures?: Record<string, number>;
  disabled?: string[];
  lastRun?: Record<string, number>;
}

interface PersistedState {
  scheduler?: SchedulerState;
  sessions?: Record<string, { messageCount?: number; lastActivity?: number }>;
}

function safeReadJSON<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function safeReadText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return `${h}h${m > 0 ? `${m}m` : ""}`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.round((ms % 86_400_000) / 3_600_000);
  return `${d}d${h > 0 ? `${h}h` : ""}`;
}

function formatRelative(then: number, now: number): string {
  const ago = now - then;
  if (ago < 0) return "in the future?";
  if (ago < 60_000) return "just now";
  return `${formatDuration(ago)} ago`;
}

/** Cleaner display name for a slug-style task ID. */
export function prettyTaskName(slug: string): string {
  // Recognize known script-task slugs by content (the cd-...-node-dist-... pattern
  // produces unreadable names that the generic stripper can't fix).
  if (slug.includes("googletasksre")) return "google-tasks-reconciler";
  if (slug.includes("closurewatche")) return "closure-watcher";
  if (slug.includes("journalarchiv")) return "journal-archiver";
  if (slug.includes("criticaltaskwatchdo")) return "critical-task-watchdog";
  if (slug.includes("maxosdigest")) return "maxos-digest";
  if (slug.includes("openroutersmoke")) return "openrouter-smoke";
  if (slug.includes("heartbeatdoc")) return "heartbeat-doc";
  if (slug.startsWith("if-there-has-been-any-substantive-work")) return "journal-checkpoint";
  if (slug.includes("notion-sync") || slug.includes("notionsync")) return "notion-sync";
  if (slug.includes("qmd-maintenance") || slug.includes("qmdmaintenance")) return "qmd-maintenance";
  if (slug.startsWith("cp-usersmaxmaxosstatejson") || slug.includes("statejson")) return "state-json-rotation";
  if (slug.includes("git-rev-parse") || slug.includes("git-init") || slug.startsWith("cd-usersmaxmaxosworkspace-git-rev")) return "workspace-git-backup";

  // Generic: strip leading "run-(the-)?" + tail like "-read-tasks..." / "-execute..." / "-md-and..."
  let s = slug.replace(/^run-(the-)?/, "");
  s = s.replace(/-read-tasks.*$/, "");
  s = s.replace(/-execute-.*$/, "");
  s = s.replace(/-md-and.*$/, "");
  return s || slug;
}

export interface HealthSummaryParts {
  daemon: {
    uptimeMs: number;
    startedAt: number;
    sessionCount: number;
    sessionMessageTotal: number;
  };
  loops: {
    openCount: number;
    googleTasksTracked: number;
  };
  schedulerHighlights: {
    disabled: string[];
    failingNow: Array<{ task: string; failures: number }>;
    recentRuns: Array<{ task: string; lastRunMs: number }>;
  };
  todayActivity: {
    journalChars: number;
    closureCount: number;
  };
  outbound24h: OutboundSummary;
}

/**
 * Compose the dashboard data structure. Pure-ish — all reads are bounded and
 * tolerant of missing files. Tests can construct fixtures and assert shape.
 */
export function buildHealthSummaryParts(input: HealthSummaryInput): HealthSummaryParts {
  const { maxosHome } = input;
  const now = input.now ?? Date.now();
  const uptimeMs = now - input.daemonStartTime;

  const state = safeReadJSON<PersistedState>(join(maxosHome, "state.json")) ?? {};
  const scheduler = state.scheduler ?? {};
  const failures = scheduler.failures ?? {};
  const disabled = scheduler.disabled ?? [];
  const lastRun = scheduler.lastRun ?? {};

  // Open loops
  const openLoopsRaw = safeReadJSON<unknown[]>(
    join(maxosHome, "workspace", "memory", "open-loops.json"),
  );
  const openCount = Array.isArray(openLoopsRaw) ? openLoopsRaw.length : 0;

  // Google Tasks tracked count
  const gtState = safeReadJSON<{ loopToTask?: Record<string, string> }>(
    join(maxosHome, "workspace", "memory", "google-tasks-state.json"),
  );
  const googleTasksTracked = gtState?.loopToTask
    ? Object.keys(gtState.loopToTask).length
    : 0;

  // Today's activity
  const today = new Date(now);
  const ymd = ymdLocal(today);
  const journalContent = safeReadText(join(maxosHome, "workspace", "memory", `${ymd}.md`));
  const closuresContent = safeReadText(join(maxosHome, "workspace", "memory", `closures-${ymd}.md`));
  const closureCount = closuresContent
    .split("\n")
    .filter((l) => l.trim().startsWith("- ["))
    .length;

  // Scheduler highlights — filter to ACTIVE entries only (lastRun in last 48h).
  // Without this, slug-truncation changes leave stale entries with old slugs
  // in state.json that show up forever as "failing" / "disabled". Real ongoing
  // issues have a recent lastRun; orphan slugs do not.
  const ACTIVE_WINDOW_MS = 48 * 3_600_000;
  const recencyCutoff = now - ACTIVE_WINDOW_MS;
  const isActive = (taskKey: string): boolean => {
    const last = lastRun[taskKey];
    return typeof last === "number" && last >= recencyCutoff;
  };

  const failingNow = Object.entries(failures)
    .filter(([task, n]) => n > 0 && isActive(task))
    .map(([task, n]) => ({ task: prettyTaskName(task), failures: n }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 5);

  const activeDisabled = disabled.filter(isActive).map(prettyTaskName);

  const recentRuns = Object.entries(lastRun)
    .filter(([, ts]) => typeof ts === "number" && ts > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 6)
    .map(([task, ts]) => ({ task: prettyTaskName(task), lastRunMs: ts as number }));

  // Outbound 24h
  const outbound = readAndSummarize(
    join(maxosHome, "workspace", "memory", "outbound-events.jsonl"),
    now - 24 * 3_600_000,
    now,
  );

  return {
    daemon: {
      uptimeMs,
      startedAt: input.daemonStartTime,
      sessionCount: Object.keys(state.sessions ?? {}).length,
      sessionMessageTotal: Object.values(state.sessions ?? {}).reduce(
        (a, s) => a + (s.messageCount ?? 0),
        0,
      ),
    },
    loops: { openCount, googleTasksTracked },
    schedulerHighlights: {
      disabled: activeDisabled,
      failingNow,
      recentRuns,
    },
    todayActivity: {
      journalChars: journalContent.length,
      closureCount,
    },
    outbound24h: outbound,
  };
}

/**
 * Render the dashboard data into a Telegram-friendly Markdown block. Kept
 * compact — the goal is "glance from your phone, get the picture in 5
 * seconds." If you need depth, ask follow-ups.
 */
export function formatHealthSummary(parts: HealthSummaryParts, now: number = Date.now()): string {
  const lines: string[] = [];
  lines.push(`📊 *MaxOS status* — ${new Date(now).toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false })} CT`);
  lines.push("");

  // Daemon
  lines.push(
    `🟢 Daemon up ${formatDuration(parts.daemon.uptimeMs)}, ` +
      `${parts.daemon.sessionCount} session${parts.daemon.sessionCount === 1 ? "" : "s"}, ` +
      `${parts.daemon.sessionMessageTotal} message${parts.daemon.sessionMessageTotal === 1 ? "" : "s"} today`,
  );

  // Loops
  lines.push(
    `🔄 ${parts.loops.openCount} open loop${parts.loops.openCount === 1 ? "" : "s"}` +
      ` · ${parts.loops.googleTasksTracked} mirrored to Google Tasks`,
  );

  // Today activity
  lines.push(
    `📝 today: ${parts.todayActivity.journalChars}c journal, ` +
      `${parts.todayActivity.closureCount} closure${parts.todayActivity.closureCount === 1 ? "" : "s"}`,
  );

  // Outbound 24h
  const o = parts.outbound24h;
  if (o.total === 0) {
    lines.push(`📤 outbound (24h): silent`);
  } else {
    const pct = Math.round(o.successRate * 100);
    const failNote = o.failed > 0 ? ` · ⚠️ ${o.failed} failed` : "";
    lines.push(
      `📤 outbound (24h): ${o.total} sent, ${pct}% ok, avg ${o.averageDurationMs}ms${failNote}`,
    );
    if (o.lastFailure) {
      lines.push(
        `   last fail: ${o.lastFailure.error?.slice(0, 80) ?? "unknown"}` +
          ` (${formatRelative(o.lastFailure.ts, now)})`,
      );
    }
  }

  // Failing tasks
  if (parts.schedulerHighlights.failingNow.length > 0) {
    const items = parts.schedulerHighlights.failingNow
      .map((f) => `${f.task} (${f.failures})`)
      .join(", ");
    lines.push(`⚠️ failing scheduled tasks: ${items}`);
  }

  // Disabled tasks
  if (parts.schedulerHighlights.disabled.length > 0) {
    lines.push(`🚫 disabled by circuit breaker: ${parts.schedulerHighlights.disabled.join(", ")}`);
  }

  // Recent runs
  if (parts.schedulerHighlights.recentRuns.length > 0) {
    lines.push("");
    lines.push("*Last 6 scheduled runs:*");
    for (const r of parts.schedulerHighlights.recentRuns) {
      lines.push(`• ${r.task} — ${formatRelative(r.lastRunMs, now)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Convenience: read + format in one shot. Used by the gateway's /status
 * Telegram command path.
 */
export function buildHealthSummary(input: HealthSummaryInput): string {
  const parts = buildHealthSummaryParts(input);
  return formatHealthSummary(parts, input.now);
}

/**
 * Render the same data as `formatHealthSummary` but with significantly more
 * detail. Used by `/status detail` — full slug names, full task list with
 * timestamps, and inline failure messages. Closer to what /status would say
 * if size weren't a concern.
 */
export function formatHealthDetail(parts: HealthSummaryParts, now: number = Date.now()): string {
  const lines: string[] = [];
  lines.push(`📊 *MaxOS detailed status* — ${new Date(now).toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false })} CT`);
  lines.push("");

  // Daemon
  lines.push("*Daemon*");
  lines.push(`  uptime: ${formatDuration(parts.daemon.uptimeMs)} (started ${new Date(parts.daemon.startedAt).toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false })} CT)`);
  lines.push(`  sessions: ${parts.daemon.sessionCount}`);
  lines.push(`  messages today: ${parts.daemon.sessionMessageTotal}`);
  lines.push("");

  // Loops
  lines.push("*Loops*");
  lines.push(`  open: ${parts.loops.openCount}`);
  lines.push(`  mirrored to Google Tasks: ${parts.loops.googleTasksTracked}`);
  lines.push("");

  // Today
  lines.push("*Today's activity*");
  lines.push(`  daily journal: ${parts.todayActivity.journalChars} chars`);
  lines.push(`  closures logged: ${parts.todayActivity.closureCount}`);
  lines.push("");

  // Outbound
  const o = parts.outbound24h;
  lines.push("*Outbound (24h)*");
  if (o.total === 0) {
    lines.push(`  silent (no messages sent in last 24h)`);
  } else {
    lines.push(`  total: ${o.total}, ok: ${o.ok}, failed: ${o.failed}, retried: ${o.retried}`);
    lines.push(`  success rate: ${Math.round(o.successRate * 100)}%`);
    lines.push(`  total chars: ${o.totalChars}, avg duration: ${o.averageDurationMs}ms`);
    if (o.lastFailure) {
      lines.push(`  last failure: "${o.lastFailure.error?.slice(0, 100) ?? "unknown"}" (${formatRelative(o.lastFailure.ts, now)})`);
    }
  }
  lines.push("");

  // Scheduler
  if (parts.schedulerHighlights.failingNow.length > 0) {
    lines.push("*Failing scheduled tasks*");
    for (const f of parts.schedulerHighlights.failingNow) {
      lines.push(`  ${f.task} — ${f.failures} consecutive failure(s)`);
    }
    lines.push("");
  }

  if (parts.schedulerHighlights.disabled.length > 0) {
    lines.push("*Disabled by circuit breaker*");
    for (const d of parts.schedulerHighlights.disabled) {
      lines.push(`  ${d}`);
    }
    lines.push("");
  }

  if (parts.schedulerHighlights.recentRuns.length > 0) {
    lines.push("*Last 6 scheduled runs*");
    for (const r of parts.schedulerHighlights.recentRuns) {
      const isoLocal = new Date(r.lastRunMs).toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false });
      lines.push(`  ${r.task} — ${formatRelative(r.lastRunMs, now)} (${isoLocal} CT)`);
    }
  }

  return lines.join("\n");
}

export function buildHealthDetail(input: HealthSummaryInput): string {
  const parts = buildHealthSummaryParts(input);
  return formatHealthDetail(parts, input.now);
}

/**
 * Stat the daemon's state.json mtime as a fallback start time when the
 * caller doesn't have the actual daemon start timestamp. The mtime is the
 * last state-snapshot, not the actual start, so this is approximate but
 * good enough for the dashboard.
 */
export function approxDaemonStartFromState(maxosHome: string): number {
  const path = join(maxosHome, "state.json");
  if (!existsSync(path)) return Date.now();
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}
