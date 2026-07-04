import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reader for the outgoing-DMs cache written every 15 minutes by the
 * FDA-granted LaunchAgent (ai.hermes.imsg-ghosted).
 *
 * Why it exists: the gateway — and every cron job it spawns — loses macOS
 * Full Disk Access on each weekly update, so spawning imessage-scan from a
 * scheduled context fails with "sqlite-open(rc=23): authorization denied"
 * (430+ closure-watcher failures since 2026-06-28). The LaunchAgent keeps
 * FDA and dumps `imessage-scan --outgoing-dms` (trailing 168h, DMs only,
 * group chats excluded) to workspace/memory/outgoing-dms-cache.json.
 * Consumers read the cache first and only spawn as a fallback — interactive
 * contexts have FDA, and queries older than the cache window need the real
 * scan.
 *
 * Cache shape:
 *   { "generated_at": "<UTC ISO, Z>", "ok": true, "exit": 0, "hours": 168,
 *     "lines": ["YYYY-MM-DD HH:MM:SS|recipient_handle|text", ...],
 *     "error": "" }
 *
 * Line timestamps are LOCAL time; generated_at is UTC. Multi-line message
 * bodies appear as extra array entries without the `ts|recipient|` prefix —
 * exactly as they would on raw imessage-scan stdout.
 */

export interface OutgoingDmsCache {
  /** True when the agent's scan exited 0. False means fall back to spawn. */
  ok: boolean;
  /** Instant the agent generated the dump (parsed from UTC generated_at). */
  generatedAt: Date;
  /** Trailing window, in hours before generatedAt, the scan covered. */
  hours: number;
  /** Raw `imessage-scan --outgoing-dms` output lines. */
  lines: string[];
}

/**
 * A cache older than this is treated as absent. The agent runs every
 * 15 minutes, so 45 minutes = three consecutive misses — at that point the
 * agent is presumed broken and consumers spawn the real scan instead.
 */
export const OUTGOING_DMS_CACHE_MAX_AGE_MS = 45 * 60 * 1000;

export function outgoingDmsCachePath(maxosHome: string): string {
  return join(maxosHome, "workspace", "memory", "outgoing-dms-cache.json");
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
 * Load the outgoing-DMs cache. Returns null when the file is missing,
 * unparseable, or stale (generated_at older than 45 minutes) — callers then
 * fall back to spawning imessage-scan directly. A parseable-but-`ok:false`
 * cache is returned as-is so callers can log the reason and fall back.
 */
export function loadOutgoingDmsCache(
  maxosHome: string,
  now: Date = new Date(),
): OutgoingDmsCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(outgoingDmsCachePath(maxosHome), "utf-8"));
  } catch {
    return null;  // missing or unparseable
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const generatedAt = new Date(String(o.generated_at ?? ""));  // UTC ISO with Z
  if (Number.isNaN(generatedAt.getTime())) return null;
  if (now.getTime() - generatedAt.getTime() > OUTGOING_DMS_CACHE_MAX_AGE_MS) return null;
  const hours = typeof o.hours === "number" && o.hours > 0 ? o.hours : 168;
  const lines = Array.isArray(o.lines)
    ? o.lines.filter((l): l is string => typeof l === "string")
    : [];
  return { ok: o.ok === true, generatedAt, hours, lines };
}
