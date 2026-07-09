import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Readers for the iMessage scan caches written every 15 minutes by the
 * FDA-granted LaunchAgent (ai.hermes.imsg-ghosted).
 *
 * Why they exist: the gateway — and every cron job it spawns — loses macOS
 * Full Disk Access on each weekly update, so spawning imessage-scan from a
 * scheduled context fails with "sqlite-open(rc=23): authorization denied"
 * (430+ closure-watcher failures since 2026-06-28). The LaunchAgent keeps
 * FDA and dumps scan output to workspace/memory/. Consumers read the cache
 * first and only spawn as a fallback — interactive contexts have FDA, and
 * queries older than a cache's window need the real scan.
 *
 * Three caches, same JSON shape (modulo the lines-array key):
 *   - outgoing-dms-cache.json — `imessage-scan --outgoing-dms`, trailing
 *     168h, Mark's outgoing DMs only, group chats excluded. Lines:
 *     "YYYY-MM-DD HH:MM:SS|recipient_handle|text".
 *   - recent-messages-cache.json — plain `imessage-scan`, trailing 48h,
 *     BOTH directions (sender field is "Mark" for outgoing, the handle or
 *     resolved name for incoming). Lines: "YYYY-MM-DD HH:MM:SS|sender|text".
 *   - ghosted-cache.json — `imessage-scan --ghosted --hours 24
 *     --resolve-names <vault>`, and the array key is `rows` (not `lines`,
 *     an imsg-ghosted-cache.py historical accident). Lines:
 *     "YYYY-MM-DD HH:MM:SS|phone|[Name — ]text".
 *
 * Shape: { "generated_at": "<UTC ISO, Z>", "ok": true, "exit": 0,
 *          "hours": N, "lines": [...], "error": "" }
 *
 * Line timestamps are LOCAL time; generated_at is UTC. Multi-line message
 * bodies appear as extra array entries without the `ts|sender|` prefix —
 * exactly as they would on raw imessage-scan stdout.
 */

export interface ImessageScanCache {
  /** True when the agent's scan exited 0. False means fall back to spawn. */
  ok: boolean;
  /** Instant the agent generated the dump (parsed from UTC generated_at). */
  generatedAt: Date;
  /** Trailing window, in hours before generatedAt, the scan covered. */
  hours: number;
  /** Raw imessage-scan output lines. */
  lines: string[];
}

/** Alias from before the module grew a second cache; same shape. */
export type OutgoingDmsCache = ImessageScanCache;

/**
 * A cache older than this is treated as absent. The agent runs every
 * 15 minutes, so 45 minutes = three consecutive misses — at that point the
 * agent is presumed broken and consumers spawn the real scan instead.
 */
export const OUTGOING_DMS_CACHE_MAX_AGE_MS = 45 * 60 * 1000;

export function outgoingDmsCachePath(maxosHome: string): string {
  return join(maxosHome, "workspace", "memory", "outgoing-dms-cache.json");
}

export function recentMessagesCachePath(maxosHome: string): string {
  return join(maxosHome, "workspace", "memory", "recent-messages-cache.json");
}

export function ghostedCachePath(maxosHome: string): string {
  return join(maxosHome, "workspace", "memory", "ghosted-cache.json");
}

/**
 * First non-empty line of an error, trimmed. Spawn failures from a python
 * imessage-scan carry the whole traceback in err.message — logging that
 * wholesale is what used to flood the cron log and keep healthcheck alarming
 * for hours. One line is enough to diagnose; the rest stays out of the log.
 */
export function firstErrorLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  for (const line of msg.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "unknown error";
}

/**
 * Format an instant as local "YYYY-MM-DD HH:MM:SS" — the format imessage-scan
 * emits per line. Strings in this format compare lexicographically in
 * chronological order, so consumers can filter cache lines with plain `>=`.
 */
export function localScanTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Shared loader core. Returns null when the file is missing, unparseable,
 * or stale (generated_at older than 45 minutes) — callers then fall back to
 * spawning imessage-scan directly. A parseable-but-`ok:false` cache is
 * returned as-is so callers can log the reason and fall back.
 */
function loadScanCache(
  path: string,
  defaultHours: number,
  now: Date,
  linesKey: "lines" | "rows" = "lines",
): ImessageScanCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;  // missing or unparseable
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const generatedAt = new Date(String(o.generated_at ?? ""));  // UTC ISO with Z
  if (Number.isNaN(generatedAt.getTime())) return null;
  if (now.getTime() - generatedAt.getTime() > OUTGOING_DMS_CACHE_MAX_AGE_MS) return null;
  const hours = typeof o.hours === "number" && o.hours > 0 ? o.hours : defaultHours;
  const rawLines = o[linesKey];
  const lines = Array.isArray(rawLines)
    ? rawLines.filter((l): l is string => typeof l === "string")
    : [];
  return { ok: o.ok === true, generatedAt, hours, lines };
}

/** Load the outgoing-DMs cache (168h of Mark's outgoing DMs). */
export function loadOutgoingDmsCache(
  maxosHome: string,
  now: Date = new Date(),
): ImessageScanCache | null {
  return loadScanCache(outgoingDmsCachePath(maxosHome), 168, now);
}

/** Load the recent-messages cache (48h, both directions, plain scan format). */
export function loadRecentMessagesCache(
  maxosHome: string,
  now: Date = new Date(),
): ImessageScanCache | null {
  return loadScanCache(recentMessagesCachePath(maxosHome), 48, now);
}

/**
 * Load the ghosted cache (24h of unanswered inbound DMs, names resolved
 * against the vault). Note the `rows` array key.
 */
export function loadGhostedCache(
  maxosHome: string,
  now: Date = new Date(),
): ImessageScanCache | null {
  return loadScanCache(ghostedCachePath(maxosHome), 24, now, "rows");
}
