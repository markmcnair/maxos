#!/usr/bin/env node
/**
 * CLI: pull today's Granola meetings + AI summaries.
 *
 * Usage:
 *   node dist/src/cli/granola-fetch.js [YYYY-MM-DD]
 *
 * Defaults to today (local timezone). Outputs JSON to stdout:
 *   {
 *     "source": "granola-desktop-app",
 *     "date": "2026-05-10",
 *     "meetings": [<full Granola document objects>],
 *     "fetchedAt": "2026-05-10T17:30:00Z"
 *   }
 *
 * Exit codes:
 *   0 — success (any meeting count, including 0)
 *   2 — Granola not authenticated (desktop app likely closed/signed out)
 *   3 — Granola API error
 */

import { listMeetingsForDate, getMeetingDetails } from "../granola.js";

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const arg = process.argv[2];
  const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : ymdLocal(new Date());
  try {
    const todayDocs = await listMeetingsForDate(date);
    const ids = todayDocs
      .map((d) => (d.document_id ?? d.id) as unknown)
      .filter((x): x is string => typeof x === "string");
    const details = ids.length > 0 ? await getMeetingDetails(ids) : [];
    // Unwrap batch responses: `getDocumentsBatch` returns { docs: [...] } per call.
    const detailDocs: unknown[] = [];
    if (Array.isArray(details)) {
      for (const batch of details) {
        const b = batch as { docs?: unknown[] };
        if (Array.isArray(b?.docs)) detailDocs.push(...b.docs);
        else if (batch && (batch as { error?: unknown }).error) detailDocs.push(batch);
      }
    }
    const output = {
      source: "granola-desktop-app",
      date,
      meetingCount: ids.length,
      meetings: detailDocs.length > 0 ? detailDocs : todayDocs,
      fetchedAt: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/keychain|not authenticated|desktop app/i.test(msg) || /MAC check|EACCES|ENOENT.*supabase/.test(msg)) {
      process.stderr.write(`GRANOLA_AUTH_UNAVAILABLE: ${msg}\n`);
      process.exit(2);
    }
    process.stderr.write(`GRANOLA_API_ERROR: ${msg}\n`);
    process.exit(3);
  }
}

main().catch((err) => {
  process.stderr.write(`UNHANDLED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(99);
});
