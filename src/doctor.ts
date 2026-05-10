import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { request as requestHttps } from "node:https";
import { smokeOpenRouter } from "./openrouter-smoke.js";

const execFileAsync = promisify(execFile);

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  durationMs?: number;
}

export interface DoctorOptions {
  maxosHome?: string;
  repoRoot?: string;
  /** Skip slow network-dependent checks (OpenRouter, Notion). */
  fast?: boolean;
}

function ms(start: number): number {
  return Date.now() - start;
}

function ageHours(mtime: number, now: number = Date.now()): number {
  return (now - mtime) / (1000 * 60 * 60);
}

// ───── Individual checks ──────────────────────────────────────────────────

async function checkDaemonHealth(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port: 18790, path: "/health", method: "GET", timeout: 3000 },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
    const parsed = JSON.parse(body) as {
      status: string;
      uptime: number;
      channels: Array<{ name: string; healthy: boolean }>;
    };
    const tg = parsed.channels.find((c) => c.name === "telegram");
    if (parsed.status !== "ok") {
      return {
        name: "daemon",
        status: "FAIL",
        detail: `health endpoint returned status: ${parsed.status}`,
        durationMs: ms(start),
      };
    }
    if (!tg?.healthy) {
      return {
        name: "daemon",
        status: "WARN",
        detail: `daemon up ${Math.round(parsed.uptime)}s but telegram channel is unhealthy`,
        durationMs: ms(start),
      };
    }
    return {
      name: "daemon",
      status: "PASS",
      detail: `up ${Math.round(parsed.uptime)}s, telegram healthy`,
      durationMs: ms(start),
    };
  } catch (err) {
    return {
      name: "daemon",
      status: "FAIL",
      detail: `health endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
}

async function checkDistBuilt(repoRoot: string): Promise<CheckResult> {
  const start = Date.now();
  const distPath = join(repoRoot, "dist", "src", "gateway.js");
  if (!existsSync(distPath)) {
    return {
      name: "dist-built",
      status: "FAIL",
      detail: `${distPath} missing — run \`npm run build\``,
      durationMs: ms(start),
    };
  }
  const srcPath = join(repoRoot, "src", "gateway.ts");
  if (!existsSync(srcPath)) {
    return { name: "dist-built", status: "WARN", detail: "src/gateway.ts missing", durationMs: ms(start) };
  }
  const distMtime = statSync(distPath).mtimeMs;
  const srcMtime = statSync(srcPath).mtimeMs;
  if (srcMtime > distMtime + 5000) {
    return {
      name: "dist-built",
      status: "WARN",
      detail: `src/gateway.ts is newer than dist (${Math.round((srcMtime - distMtime) / 1000)}s) — needs rebuild`,
      durationMs: ms(start),
    };
  }
  return {
    name: "dist-built",
    status: "PASS",
    detail: `dist current (built ${Math.round(ageHours(distMtime) * 60)}m ago)`,
    durationMs: ms(start),
  };
}

async function checkWorkspaceFiles(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();
  const required = [
    join(maxosHome, "maxos.json"),
    join(maxosHome, ".env"),
    join(maxosHome, "workspace", "HEARTBEAT.md"),
    join(maxosHome, "workspace", "SOUL.md"),
    join(maxosHome, "workspace", "MEMORY.md"),
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return {
      name: "workspace-files",
      status: "FAIL",
      detail: `missing: ${missing.map((p) => p.replace(maxosHome, "$MAXOS_HOME")).join(", ")}`,
      durationMs: ms(start),
    };
  }
  return {
    name: "workspace-files",
    status: "PASS",
    detail: `${required.length} required files present`,
    durationMs: ms(start),
  };
}

async function checkOpenLoopsValid(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();
  const path = join(maxosHome, "workspace", "memory", "open-loops.json");
  if (!existsSync(path)) {
    return { name: "open-loops", status: "PASS", detail: "no open-loops.json (treated as empty)", durationMs: ms(start) };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(raw)) {
      return { name: "open-loops", status: "FAIL", detail: "not an array", durationMs: ms(start) };
    }
    const invalid = raw.filter((l) => typeof l !== "object" || !l.id || !l.topic);
    if (invalid.length > 0) {
      return {
        name: "open-loops",
        status: "WARN",
        detail: `${raw.length} entries, ${invalid.length} malformed`,
        durationMs: ms(start),
      };
    }
    return {
      name: "open-loops",
      status: "PASS",
      detail: `${raw.length} valid entries`,
      durationMs: ms(start),
    };
  } catch (err) {
    return {
      name: "open-loops",
      status: "FAIL",
      detail: `corrupt JSON: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
}

async function checkSchedulerState(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();
  const path = join(maxosHome, "state.json");
  if (!existsSync(path)) {
    return { name: "scheduler-state", status: "WARN", detail: "state.json missing", durationMs: ms(start) };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const sched = raw.scheduler ?? {};
    const failuresCount = Object.values<number>(sched.failures ?? {}).filter((n) => n > 0).length;
    const disabledCount = (sched.disabled ?? []).length;
    if (disabledCount > 0) {
      return {
        name: "scheduler-state",
        status: "WARN",
        detail: `${disabledCount} task(s) disabled by circuit breaker; ${failuresCount} with active failures`,
        durationMs: ms(start),
      };
    }
    if (failuresCount > 0) {
      return {
        name: "scheduler-state",
        status: "WARN",
        detail: `${failuresCount} task(s) have active failure counts`,
        durationMs: ms(start),
      };
    }
    return {
      name: "scheduler-state",
      status: "PASS",
      detail: `clean: 0 disabled, 0 active failures`,
      durationMs: ms(start),
    };
  } catch (err) {
    return {
      name: "scheduler-state",
      status: "FAIL",
      detail: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
}

async function checkGwsAuth(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync("gws-personal", ["auth", "status"], {
      timeout: 8000,
    });
    const idx = stdout.indexOf("{");
    if (idx < 0) {
      return { name: "gws-personal-auth", status: "WARN", detail: "no JSON in auth status output", durationMs: ms(start) };
    }
    const parsed = JSON.parse(stdout.slice(idx)) as { token_valid?: boolean };
    if (parsed.token_valid === true) {
      return { name: "gws-personal-auth", status: "PASS", detail: "token valid", durationMs: ms(start) };
    }
    return { name: "gws-personal-auth", status: "FAIL", detail: "token NOT valid — re-auth needed", durationMs: ms(start) };
  } catch (err) {
    return {
      name: "gws-personal-auth",
      status: "FAIL",
      detail: `gws-personal not callable: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
}

async function checkGranola(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();

  // Round U: prefer "do we have fresh meeting notes?" over "is the CLI auth
  // working?" The CLI auth has a separate keychain entry from the desktop
  // app and can rot silently for weeks. The granola-sync task uses the MCP
  // first now (not the CLI), so the freshness of the produced notes file
  // is the ACTUAL health signal.
  const today = new Date();
  const dayOfWeek = today.getDay();  // 0 Sun, 6 Sat
  const isSaturday = dayOfWeek === 6;
  const isSunday = dayOfWeek === 0;

  const ymdLocal = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  // Saturday + early Sunday: granola-sync doesn't run, so freshness is N/A
  if (isSaturday) {
    return {
      name: "granola",
      status: "PASS",
      detail: "Saturday — granola-sync intentionally skips (Sabbath)",
      durationMs: ms(start),
    };
  }

  // Find the most-recent meeting-notes file in vault/Work/Daily/
  const { existsSync, readdirSync, statSync } = await import("node:fs");
  const dailyDir = `${maxosHome}/vault/Work/Daily`;
  if (!existsSync(dailyDir)) {
    return {
      name: "granola",
      status: "WARN",
      detail: "vault/Work/Daily missing — first run?",
      durationMs: ms(start),
    };
  }

  let mostRecentMtime = 0;
  let mostRecentName = "";
  for (const name of readdirSync(dailyDir)) {
    if (!name.match(/^\d{4}-\d{2}-\d{2}-meeting-notes\.md$/)) continue;
    const stat = statSync(`${dailyDir}/${name}`);
    if (stat.mtimeMs > mostRecentMtime) {
      mostRecentMtime = stat.mtimeMs;
      mostRecentName = name;
    }
  }

  if (mostRecentMtime === 0) {
    return {
      name: "granola",
      status: "WARN",
      detail: "no meeting-notes files found yet",
      durationMs: ms(start),
    };
  }

  const ageHours = (Date.now() - mostRecentMtime) / 3600_000;

  // Sunday: notes from Friday (~48h old) are still fine. Tolerance bumps.
  const staleThreshold = isSunday ? 60 : 28;

  if (ageHours > staleThreshold) {
    // Stale — surface CLI status as supplemental detail
    let cliDetail = "";
    try {
      const { stdout } = await execFileAsync("bash", [
        "-c",
        'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && granola meeting list --limit 1 2>&1',
      ], { timeout: 5000 });
      if (/authentication required/i.test(stdout)) {
        cliDetail = " | CLI: auth required (use Granola MCP — see tasks/granola-sync.md)";
      } else {
        cliDetail = " | CLI: working (problem may be elsewhere)";
      }
    } catch {
      cliDetail = " | CLI: not callable";
    }
    return {
      name: "granola",
      status: "FAIL",
      detail: `latest meeting notes ${Math.round(ageHours)}h old (${mostRecentName})${cliDetail}`,
      durationMs: ms(start),
    };
  }

  return {
    name: "granola",
    status: "PASS",
    detail: `latest meeting notes ${Math.round(ageHours)}h old (${mostRecentName})`,
    durationMs: ms(start),
  };
}

async function checkOpenRouter(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();
  const envPath = join(maxosHome, ".env");
  if (!existsSync(envPath)) {
    return { name: "openrouter", status: "FAIL", detail: ".env missing", durationMs: ms(start) };
  }
  const env = readFileSync(envPath, "utf-8");
  const keyMatch = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
  const modelMatch = env.match(/^OPENROUTER_MODEL=(.+)$/m);
  if (!keyMatch || !keyMatch[1].trim()) {
    return { name: "openrouter", status: "WARN", detail: "OPENROUTER_API_KEY not set", durationMs: ms(start) };
  }
  const key = keyMatch[1].trim();
  const model = modelMatch?.[1].trim() || "z-ai/glm-4.5-air:free";
  // Full chat-completions smoke — validates the path tonight's scout uses.
  // Slower (~2s) than a key-only check but catches reasoning-model gotchas
  // and rate-limit / model-deprecation issues before the scout hits them.
  const result = await smokeOpenRouter(key, model);
  if (result.ok) {
    return {
      name: "openrouter",
      status: "PASS",
      detail: `chat-completions OK (model=${model}, "${result.responseSnippet}")`,
      durationMs: ms(start),
    };
  }
  return {
    name: "openrouter",
    status: "FAIL",
    detail: `chat-completions FAIL: ${result.error}`,
    durationMs: ms(start),
  };
}

async function checkWorkspaceGit(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();
  const wsDir = join(maxosHome, "workspace");
  const gitDir = join(wsDir, ".git");
  if (!existsSync(gitDir)) {
    return { name: "workspace-git", status: "WARN", detail: "workspace not a git repo (first daily snapshot will init)", durationMs: ms(start) };
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", wsDir, "log", "-1", "--format=%ct %s"], {
      timeout: 3000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { name: "workspace-git", status: "WARN", detail: "repo exists but no commits yet", durationMs: ms(start) };
    }
    const [tsStr, ...rest] = trimmed.split(" ");
    const lastCommitMs = Number(tsStr) * 1000;
    const ageHrs = ageHours(lastCommitMs);
    if (ageHrs > 30) {
      return {
        name: "workspace-git",
        status: "WARN",
        detail: `last commit ${Math.round(ageHrs)}h ago — daily snapshot may be failing (msg: ${rest.join(" ").slice(0, 60)})`,
        durationMs: ms(start),
      };
    }
    return {
      name: "workspace-git",
      status: "PASS",
      detail: `last commit ${Math.round(ageHrs)}h ago`,
      durationMs: ms(start),
    };
  } catch (err) {
    return {
      name: "workspace-git",
      status: "WARN",
      detail: `git query failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
}

async function checkRecentTaskActivity(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();
  const path = join(maxosHome, "state.json");
  if (!existsSync(path)) {
    return { name: "recent-task-activity", status: "WARN", detail: "no state.json", durationMs: ms(start) };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const lastRun: Record<string, number> = raw.scheduler?.lastRun ?? {};
    const now = Date.now();
    const recent = Object.entries(lastRun).filter(([, ts]) => now - ts < 6 * 3600_000).length;
    if (recent === 0) {
      return {
        name: "recent-task-activity",
        status: "FAIL",
        detail: "NO scheduled tasks have fired in the last 6 hours — scheduler may be hung",
        durationMs: ms(start),
      };
    }
    return {
      name: "recent-task-activity",
      status: "PASS",
      detail: `${recent} task(s) fired in last 6h`,
      durationMs: ms(start),
    };
  } catch (err) {
    return {
      name: "recent-task-activity",
      status: "WARN",
      detail: `state read failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
}

// Round Q: passive auth-failure detection. The 2026-05-04 token-storm
// went undiagnosed for ~14 hours because the daemon log had no string
// pointing at the auth error. With err.message now in scheduler:task_failed
// (Round Q observability fix), we can grep for auth-shaped failures and
// surface them as a doctor FAIL with an actionable detail message.
// Recognized auth-failure tells across the lifecycle:
//   - 401 / "Invalid authentication credentials" — token rejected by API
//   - "Authentication credentials missing" / "Authentication required" — no creds
//   - "Not logged in" / "Please run /login" — CLI logged out (post-logout state)
//   - Anthropic refresh / OAuth-flow phrases — token-exchange failures
//
// Regex stays conservative on punctuation so a legitimate task output
// containing an unrelated word like "authenticated" only flags if the
// surrounding context is auth-error-shaped.
const AUTH_PATTERN =
  /\b(401|authenticat\w*|unauthor[iz]ed|invalid (?:auth|credentials)|not logged in|please run \/login|run \/login)\b/i;

export interface AuthFailureMatch {
  task: string;
  errorSnippet: string;
  timestampMs: number;
}

/**
 * Parse a single daemon.log line. Returns the auth-failure metadata if
 * this is a `scheduler:task_failed` entry whose `error` field signals an
 * auth issue. Returns null for any other line, including non-auth task
 * failures.
 */
export function parseLoglineForAuthFailure(line: string): AuthFailureMatch | null {
  if (!line) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.message !== "scheduler:task_failed") return null;
  const error = typeof parsed.error === "string" ? parsed.error : "";
  if (!AUTH_PATTERN.test(error)) return null;
  const task = typeof parsed.task === "string" ? parsed.task : "unknown";
  const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  return {
    task,
    errorSnippet: error.slice(0, 200),
    timestampMs: Number.isNaN(ts) ? 0 : ts,
  };
}

/**
 * Walk daemon.log content, find all auth-shaped failures whose timestamp
 * is on or after `cutoffMs`. Returns the count, the unique task names,
 * and the most recent error snippet for the doctor's detail message.
 */
export function findRecentAuthFailures(
  content: string,
  cutoffMs: number,
): { count: number; tasks: string[]; lastErrorSnippet: string } {
  const matches: AuthFailureMatch[] = [];
  for (const line of content.split("\n")) {
    const m = parseLoglineForAuthFailure(line);
    if (m && m.timestampMs >= cutoffMs) matches.push(m);
  }
  if (matches.length === 0) {
    return { count: 0, tasks: [], lastErrorSnippet: "" };
  }
  matches.sort((a, b) => b.timestampMs - a.timestampMs);
  const tasks = [...new Set(matches.map((m) => m.task))];
  return {
    count: matches.length,
    tasks,
    lastErrorSnippet: matches[0].errorSnippet,
  };
}

/**
 * Doctor check: scan the last 24 hours of daemon.log for claude-CLI
 * auth failures. If any are present, return FAIL with an actionable
 * detail string telling the user to re-auth or refresh tokens.
 *
 * Passive only — does NOT spend tokens probing the API. Relies on the
 * task_failed log lines that the scheduler now emits with err.message.
 */
export async function checkClaudeAuthFromRecentFailures(
  maxosHome: string,
): Promise<CheckResult> {
  const start = Date.now();
  const path = join(maxosHome, "daemon.log");
  if (!existsSync(path)) {
    return {
      name: "claude-auth",
      status: "PASS",
      detail: "no daemon.log yet (fresh install or rotated)",
      durationMs: ms(start),
    };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    return {
      name: "claude-auth",
      status: "WARN",
      detail: `daemon.log read failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
  const cutoff = Date.now() - 24 * 3600_000;
  const r = findRecentAuthFailures(content, cutoff);
  if (r.count === 0) {
    return {
      name: "claude-auth",
      status: "PASS",
      detail: "no auth-shaped task failures in last 24h",
      durationMs: ms(start),
    };
  }
  // Recovery check: if an LLM task SUCCEEDED after the most recent auth
  // failure, auth is back. Avoids the FAIL-stuck-for-24h state Mark hit
  // immediately after re-authing on 2026-05-05.
  const lastSuccessMs = findLatestLlmSuccess(content);
  const lastFailMs = findLatestAuthFailureTimestamp(content);
  if (lastSuccessMs > 0 && lastSuccessMs > lastFailMs) {
    const minutesSince = Math.floor((Date.now() - lastSuccessMs) / 60_000);
    return {
      name: "claude-auth",
      status: "PASS",
      detail: `recovered — last LLM task succeeded ${minutesSince}m ago (after ${r.count} earlier failure(s) since ${new Date(cutoff).toISOString().slice(0, 10)})`,
      durationMs: ms(start),
    };
  }
  return {
    name: "claude-auth",
    status: "FAIL",
    detail:
      `${r.count} task failure(s) with auth-shaped errors in last 24h across ${r.tasks.length} task(s) ` +
      `(${r.tasks.slice(0, 3).join(", ")}${r.tasks.length > 3 ? "…" : ""}). ` +
      `Run \`claude /login\` to re-auth, or check tokens.`,
    durationMs: ms(start),
  };
}

// LLM-task slug patterns: HEARTBEAT-driven LLM tasks start with `run-`
// (the standard "Run X" prompt prefix) or `if-there-has-been-`
// (the journal checkpoint). Script tasks start with `cd-` or have
// hardcoded slugs like `critical-task-watchdog`, `maxos-digest`,
// `closure-watcher`. We match the LLM patterns so the recovery
// signal only fires on a real Claude-CLI success — not a script.
const LLM_TASK_SLUG_RE = /^(run-|if-there-has-been-)/;

/**
 * Walk daemon.log content for the most recent successful LLM task —
 * either:
 *   - `gateway:deliver_task` with an LLM slug (non-silent task)
 *   - `scheduler:silent_complete` with an LLM slug AND non-zero result
 *     (silent task, e.g. notion-sync, journal-checkpoint)
 *
 * Used as the recovery signal so the auth check doesn't stay FAIL for
 * 24h after re-login. A `scheduler:silent_complete` with resultLength=0
 * doesn't count — that's how the daemon logs an empty/timed-out result.
 */
function findLatestLlmSuccess(content: string): number {
  let latest = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = parsed.message;
    const task = typeof parsed.task === "string" ? parsed.task : "";
    if (!LLM_TASK_SLUG_RE.test(task)) continue;

    let isSuccess = false;
    if (msg === "gateway:deliver_task") {
      isSuccess = true;
    } else if (msg === "scheduler:silent_complete") {
      const len = typeof parsed.resultLength === "number" ? parsed.resultLength : 0;
      isSuccess = len > 0;
    }
    if (!isSuccess) continue;

    const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    if (Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest;
}

function findLatestAuthFailureTimestamp(content: string): number {
  let latest = 0;
  for (const line of content.split("\n")) {
    const m = parseLoglineForAuthFailure(line);
    if (m && m.timestampMs > latest) latest = m.timestampMs;
  }
  return latest;
}

/**
 * Parse the JSON payload that `security find-generic-password -s
 * "Claude Code-credentials" -w` writes to stdout. Returns the OAuth
 * access-token expiry timestamp, subscription type, and whether a
 * refresh token is present. Null if the payload is malformed.
 *
 * Why hasRefreshToken matters: Claude Code uses ~8h access tokens with
 * a long-lived refresh token. If refresh is present, the CLI auto-
 * refreshes and the access expiry is invisible to the user. Without
 * it, near-expiry is actionable.
 */
export function parseClaudeKeychainExpiry(
  raw: string,
): { expiresAtMs: number; subscriptionType?: string; hasRefreshToken: boolean } | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const expiresAt = (oauth as Record<string, unknown>).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  const subscriptionType = (oauth as Record<string, unknown>).subscriptionType;
  const refreshToken = (oauth as Record<string, unknown>).refreshToken;
  return {
    expiresAtMs: expiresAt,
    subscriptionType: typeof subscriptionType === "string" ? subscriptionType : undefined,
    hasRefreshToken: typeof refreshToken === "string" && refreshToken.length > 0,
  };
}

const ONE_HOUR_MS = 3600_000;
const ONE_DAY_MS = 86400_000;

/**
 * Pure classifier — given a parsed keychain entry (or null for
 * "logged out"), produce the doctor check result.
 *
 * Decision tree:
 *   - null → PASS (not logged in; the auth-from-recent-failures check
 *     handles "logged out but tasks try" separately)
 *   - hasRefreshToken=true → always PASS (CLI auto-refreshes; access
 *     expiry is invisible to user). 2026-05-05 false-alarm regression.
 *   - hasRefreshToken=false + expired → FAIL
 *   - hasRefreshToken=false + within 1 day → WARN
 *   - otherwise → PASS
 */
export function classifyKeychainExpiry(
  parsed: { expiresAtMs: number; subscriptionType?: string; hasRefreshToken: boolean } | null,
  nowMs: number,
): CheckResult {
  if (parsed === null) {
    return {
      name: "claude-token-expiry",
      status: "PASS",
      detail: "no keychain entry (not logged in or fresh install)",
    };
  }
  if (parsed.hasRefreshToken) {
    return {
      name: "claude-token-expiry",
      status: "PASS",
      detail: "refresh token present — CLI auto-refreshes access tokens",
    };
  }
  // No refresh token — access expiry is the only thing keeping auth alive.
  const remainingMs = parsed.expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return {
      name: "claude-token-expiry",
      status: "FAIL",
      detail: `access token expired and no refresh token — run \`claude auth logout && claude auth login\``,
    };
  }
  if (remainingMs < ONE_DAY_MS) {
    const hours = Math.max(1, Math.floor(remainingMs / ONE_HOUR_MS));
    return {
      name: "claude-token-expiry",
      status: "WARN",
      detail: `access token expires in ${hours} hour(s) and no refresh token — re-auth before then`,
    };
  }
  return {
    name: "claude-token-expiry",
    status: "PASS",
    detail: `access token has ${Math.floor(remainingMs / ONE_DAY_MS)} day(s) until expiry`,
  };
}

/**
 * Doctor check: read the OAuth token from the macOS keychain (no
 * interactive prompt — `security find-generic-password -w` is a
 * read-only access that's already authorized by the daemon's user
 * session). Surface impending expiry as a WARN before it becomes the
 * 14-hour silent failure of 2026-05-04.
 *
 * On non-macOS or when the security command isn't available, returns
 * SKIP — keeps the check non-flaky on CI.
 */
async function checkClaudeTokenExpiry(): Promise<CheckResult> {
  const start = Date.now();
  if (process.platform !== "darwin") {
    return {
      name: "claude-token-expiry",
      status: "SKIP",
      detail: "non-macOS — keychain read N/A",
      durationMs: ms(start),
    };
  }
  let raw = "";
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5000 },
    );
    raw = stdout.trim();
  } catch {
    // Item not found = logged out. That's a PASS — the auth-from-recent-
    // failures check is what catches "logged out but tasks still try."
    return {
      name: "claude-token-expiry",
      status: "PASS",
      detail: "keychain entry not found (logged out)",
      durationMs: ms(start),
    };
  }
  const parsed = parseClaudeKeychainExpiry(raw);
  const result = classifyKeychainExpiry(parsed, Date.now());
  return { ...result, durationMs: ms(start) };
}

async function checkVoiceViolations24h(maxosHome: string): Promise<CheckResult> {
  const start = Date.now();
  const path = join(maxosHome, "workspace", "memory", "voice-violations.jsonl");
  if (!existsSync(path)) {
    return { name: "voice-violations-24h", status: "PASS", detail: "no log yet (clean or fresh install)", durationMs: ms(start) };
  }
  try {
    const content = readFileSync(path, "utf-8");
    const cutoff = Date.now() - 24 * 3600_000;
    let total = 0;
    let entries = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { ts: number; violationCount: number };
        if (e.ts >= cutoff) {
          entries++;
          total += e.violationCount;
        }
      } catch { continue; }
    }
    if (entries === 0) {
      return { name: "voice-violations-24h", status: "PASS", detail: "0 violations in last 24h", durationMs: ms(start) };
    }
    if (total > 20) {
      return {
        name: "voice-violations-24h",
        status: "WARN",
        detail: `${total} violations across ${entries} outbound(s) in 24h — deslop instruction may not be sticking`,
        durationMs: ms(start),
      };
    }
    return {
      name: "voice-violations-24h",
      status: "PASS",
      detail: `${total} violations across ${entries} outbound(s) in 24h`,
      durationMs: ms(start),
    };
  } catch (err) {
    return {
      name: "voice-violations-24h",
      status: "WARN",
      detail: `log read failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: ms(start),
    };
  }
}

// ───── Orchestration ──────────────────────────────────────────────────────

export async function runAllChecks(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const maxosHome = options.maxosHome ?? process.env.MAXOS_HOME ?? `${process.env.HOME}/.maxos`;
  const repoRoot = options.repoRoot ?? `${process.env.HOME}/Projects/maxos`;
  const fast = options.fast ?? false;

  const checks: Promise<CheckResult>[] = [
    checkDaemonHealth(),
    checkDistBuilt(repoRoot),
    checkWorkspaceFiles(maxosHome),
    checkOpenLoopsValid(maxosHome),
    checkSchedulerState(maxosHome),
    checkRecentTaskActivity(maxosHome),
    checkWorkspaceGit(maxosHome),
    checkVoiceViolations24h(maxosHome),
    checkClaudeAuthFromRecentFailures(maxosHome),
    checkClaudeTokenExpiry(),
  ];

  if (!fast) {
    checks.push(
      checkGwsAuth(),
      checkGranola(maxosHome),
      checkOpenRouter(maxosHome),
    );
  }

  return Promise.all(checks);
}

const ICON: Record<CheckStatus, string> = {
  PASS: "✓",
  WARN: "⚠",
  FAIL: "✗",
  SKIP: "·",
};

export function formatReport(results: CheckResult[]): string {
  const lines: string[] = [];
  lines.push("MaxOS doctor:");
  lines.push("");
  for (const r of results) {
    const dur = r.durationMs !== undefined ? ` (${r.durationMs}ms)` : "";
    lines.push(`  ${ICON[r.status]} ${r.status.padEnd(4)} ${r.name.padEnd(24)} — ${r.detail}${dur}`);
  }
  lines.push("");
  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) counts[r.status]++;
  lines.push(
    `Summary: ${counts.PASS} pass, ${counts.WARN} warn, ${counts.FAIL} fail, ${counts.SKIP} skipped`,
  );
  return lines.join("\n");
}

const isCLI = process.argv[1]?.endsWith("doctor.js");
if (isCLI) {
  const fast = process.argv.includes("--fast");
  runAllChecks({ fast }).then((results) => {
    console.log(formatReport(results));
    const failed = results.filter((r) => r.status === "FAIL").length;
    process.exit(failed > 0 ? 1 : 0);
  }).catch((err) => {
    console.error("doctor failed:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
