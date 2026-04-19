import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RestartMarker {
  ts: number;
  reason: string;
}

const MARKER_FILENAME = "restart.marker";

/**
 * Write a marker file signaling that the daemon is being intentionally restarted.
 * Called by `maxos restart` / `maxos stop` *before* killing the daemon, so the next
 * boot can distinguish "user asked for this" from "the process died unexpectedly."
 */
export function writeRestartMarker(dir: string, reason: string): void {
  mkdirSync(dir, { recursive: true });
  const marker: RestartMarker = { ts: Date.now(), reason };
  writeFileSync(join(dir, MARKER_FILENAME), JSON.stringify(marker));
}

/**
 * Read and delete the restart marker. Returns null if no marker exists
 * or if the marker file is corrupt (in which case the corrupt file is removed).
 */
export function consumeRestartMarker(dir: string): RestartMarker | null {
  const path = join(dir, MARKER_FILENAME);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  // Always clean up the marker, even if parsing fails — stale corrupt markers
  // would otherwise trigger a bogus "restart complete" message on every boot.
  rmSync(path, { force: true });

  try {
    const parsed = JSON.parse(raw) as RestartMarker;
    if (typeof parsed.ts !== "number" || typeof parsed.reason !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
