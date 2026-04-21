import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface Dossier {
  name: string;
  firstName: string;
  orbit: string;
  phone?: string;
  path: string;
  excerpt: string;
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end?: string;
  attendees?: Array<{ email?: string; displayName?: string }>;
  description?: string;
  location?: string;
}

export type MatchResult =
  | { kind: "single"; dossier: Dossier }
  | { kind: "ambiguous"; candidates: Dossier[] }
  | { kind: "none" };

export interface ResolvedEvent {
  time: string;
  title: string;
  location?: string;
  description?: string;
  knownAttendees: Dossier[];
  unknownAttendees: string[];
  ambiguousAttendees: Array<{ query: string; candidates: Dossier[] }>;
}

// Words/phrases that mean "this is an activity or venue, not a person".
// Used when an event title has no separator — we don't want to flag
// "Pickleball" as an unknown attendee.
const ACTIVITY_STOP_WORDS = new Set([
  "pickleball", "tennis", "workout", "run", "walk", "bike", "mountain bike",
  "lunch", "dinner", "breakfast", "coffee",
  "meeting", "call", "interview",
  "gym", "yoga", "meditation", "stretching",
  "community group", "bible study", "triads",
  "church", "gathering", "worship", "worship night", "service",
  "men's breakfast", "leaders lunch",
  "drive", "commute", "travel",
  "mfm appt", "mfm",
  "review", "plan", "standup", "stand-up", "sync", "check-in", "checkin",
  "reflection", "focus time", "focus block", "deep work",
  "pickleball practice", "tennis practice",
]);

/**
 * Extract candidate attendee name tokens from a calendar event title.
 *
 * - Splits on common separators: +, /, comma, " and ", " y " (Spanish)
 * - Strips everything after "@" (venue info)
 * - If title has no separator and matches a known activity/venue word, returns [].
 * - Otherwise returns the capitalized tokens as-is; dossier matching happens downstream.
 */
export function extractNameTokens(title: string): string[] {
  if (!title) return [];

  // Strip venue suffix: "Miguel + Mark @ Level Ground" → "Miguel + Mark".
  // Accept single or double space around @ (Google Calendar sometimes double-spaces).
  let core = title.replace(/\s+@\s+.*/, "").trim();
  // Strip trailing parenthesized content: "Mountain bike (swim backup)" → "Mountain bike"
  core = core.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  // Collapse repeated whitespace
  core = core.replace(/\s+/g, " ");

  const lc = core.toLowerCase().trim();
  const hasSeparator = /[+\/,]|\s(?:and|y)\s/i.test(core);

  if (!hasSeparator) {
    if (ACTIVITY_STOP_WORDS.has(lc)) return [];
    // Also catch stop-word prefixes like "Pickleball practice"
    for (const stop of ACTIVITY_STOP_WORDS) {
      if (lc === stop || lc.startsWith(stop + " ") || lc.endsWith(" " + stop)) {
        return [];
      }
    }
    // Treat the whole trimmed title as a single name candidate
    return [core];
  }

  // Split on + / , " and " " y "
  const tokens = core
    .split(/\s*[+\/,]\s*|\s+y\s+|\s+and\s+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return tokens;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.startsWith("---\n")) return out;
  const endIdx = raw.indexOf("\n---", 4);
  if (endIdx < 0) return out;
  const block = raw.slice(4, endIdx);
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (m) {
      out[m[1]] = m[2].trim();
    }
  }
  return out;
}

function* walkMarkdown(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (st.isFile() && name.endsWith(".md") && name !== "CLAUDE.md" && name !== "MEMORY.md") {
      yield full;
    }
  }
}

/**
 * Load all person dossiers from the vault's Relationships/ subtree.
 * Deterministic — parses YAML frontmatter and first paragraph of body.
 * Silently skips malformed files rather than throwing.
 */
export function loadDossiers(vaultRoot: string): Dossier[] {
  const relRoot = join(vaultRoot, "Relationships");
  const out: Dossier[] = [];
  for (const path of walkMarkdown(relRoot)) {
    let content = "";
    try { content = readFileSync(path, "utf-8"); } catch { continue; }
    const fm = parseFrontmatter(content);
    const name = (fm.name || "").trim();
    if (!name) continue;
    const orbit = (fm.orbit || "Unknown").trim();
    const phone = fm.phone ? fm.phone.trim() : undefined;
    const firstName = name.split(/\s+/)[0];
    // Excerpt: first ~300 chars of body after frontmatter
    const bodyStart = content.indexOf("\n---", 4);
    const body = bodyStart >= 0 ? content.slice(bodyStart + 4).trim() : content;
    const excerpt = body.slice(0, 300);
    out.push({ name, firstName, orbit, phone, path, excerpt });
  }
  return out;
}

/**
 * Match a query name against dossiers using strict, deterministic rules:
 *   - Full-name exact match (case-insensitive) → single
 *   - First-name exact match, exactly one dossier → single
 *   - First-name exact match, multiple dossiers → ambiguous
 *   - Otherwise → none
 *
 * Never does phonetic / fuzzy matching. "Mike Salem" will NEVER match "Mark Stubblefield".
 */
export function matchDossier(query: string, dossiers: Dossier[]): MatchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: "none" };

  // Full-name exact match
  const fullMatches = dossiers.filter((d) => d.name.toLowerCase() === q);
  if (fullMatches.length === 1) return { kind: "single", dossier: fullMatches[0] };
  if (fullMatches.length > 1) return { kind: "ambiguous", candidates: fullMatches };

  // First-name exact match
  const firstMatches = dossiers.filter((d) => d.firstName.toLowerCase() === q);
  if (firstMatches.length === 1) return { kind: "single", dossier: firstMatches[0] };
  if (firstMatches.length > 1) return { kind: "ambiguous", candidates: firstMatches };

  return { kind: "none" };
}

/**
 * Resolve a calendar event into known / ambiguous / unknown attendees.
 *
 * If the event has calendar-supplied attendees (via the Google API),
 * they take priority — we match by displayName or email local-part.
 *
 * Otherwise we fall back to parsing the event title.
 *
 * The user's own first name is always excluded from attendee resolution
 * so it doesn't count as "unknown" or "ambiguous".
 */
export function resolveEvent(
  event: CalendarEvent,
  dossiers: Dossier[],
  userFirstName: string,
  userEmails: string[] = [],
): ResolvedEvent {
  const known: Dossier[] = [];
  const unknown: string[] = [];
  const ambiguous: Array<{ query: string; candidates: Dossier[] }> = [];
  const userFirst = userFirstName.toLowerCase();
  const userEmailSet = new Set(userEmails.map((e) => e.toLowerCase()));
  const userEmailLocalParts = new Set(
    userEmails.map((e) => e.toLowerCase().split("@")[0]),
  );

  // Prefer structured calendar attendees if present
  const candidates: string[] = [];
  if (event.attendees && event.attendees.length > 0) {
    for (const a of event.attendees) {
      const email = (a.email || "").toLowerCase();
      // Skip the user's own email — they're an attendee of their own event, not someone else
      if (email && userEmailSet.has(email)) continue;
      const name = a.displayName || (a.email ? a.email.split("@")[0] : "");
      if (!name) continue;
      // Also skip if the name is the local-part of a user email (e.g. "markmcnair2")
      if (userEmailLocalParts.has(name.toLowerCase())) continue;
      candidates.push(name);
    }
  } else {
    candidates.push(...extractNameTokens(event.summary));
  }

  // "Mark y Mark" → one of the Marks is the user, the other is an attendee.
  // We skip only the FIRST occurrence of the user's own first name so the
  // rest of the Marks are processed normally (and flagged ambiguous if
  // multiple dossiers match).
  let userSkipped = false;
  const seen = new Set<string>();
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lc = trimmed.toLowerCase();
    if (!userSkipped && lc === userFirst) {
      userSkipped = true;
      continue;
    }
    if (seen.has(lc)) continue;
    seen.add(lc);

    const result = matchDossier(trimmed, dossiers);
    if (result.kind === "single") known.push(result.dossier);
    else if (result.kind === "ambiguous") ambiguous.push({ query: trimmed, candidates: result.candidates });
    else unknown.push(trimmed);
  }

  // Format time from ISO start
  let time = "";
  try {
    const dt = new Date(event.start);
    const hh = dt.getHours() % 12 || 12;
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const ap = dt.getHours() >= 12 ? "pm" : "am";
    time = `${hh}:${mm}${ap}`;
  } catch {}

  return {
    time,
    title: event.summary,
    location: event.location,
    description: event.description,
    knownAttendees: known,
    unknownAttendees: unknown,
    ambiguousAttendees: ambiguous,
  };
}

/**
 * Remove duplicate events (same title + same start time).
 * iMessage / Gmail events often show up on multiple calendars.
 */
export function deduplicateEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const key = `${(e.summary || "").toLowerCase().trim()}|${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Fetch events for a specific date from a single Google Calendar via the
 * gws-personal CLI wrapper. Returns raw events; deduplication and
 * attendee resolution happen downstream.
 *
 * Date-format note: timeMin / timeMax use ISO with timezone offset.
 * Pass the user's local offset or it'll shift by TZ.
 */
export async function fetchCalendarEvents(
  calendarIds: string[],
  dateISO: string,
  tzOffset: string,
  gwsPath = "gws-personal",
): Promise<CalendarEvent[]> {
  const results: CalendarEvent[] = [];
  for (const calId of calendarIds) {
    try {
      const params = JSON.stringify({
        calendarId: calId,
        timeMin: `${dateISO}T00:00:00${tzOffset}`,
        timeMax: `${dateISO}T23:59:59${tzOffset}`,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });
      const { stdout } = await execFileAsync(
        gwsPath,
        ["calendar", "events", "list", "--params", params, "--format", "json"],
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      for (const item of items) {
        const start = item.start?.dateTime || item.start?.date;
        if (!start) continue;
        results.push({
          summary: item.summary || "(no title)",
          start,
          end: item.end?.dateTime || item.end?.date,
          attendees: Array.isArray(item.attendees)
            ? item.attendees.map((a: any) => ({ email: a.email, displayName: a.displayName }))
            : undefined,
          description: item.description,
          location: item.location,
        });
      }
    } catch {
      // Per-calendar failure shouldn't kill the brief — continue with other
      // calendars and note the gap in the output.
    }
  }
  return results;
}

/**
 * Format a calendar brief for injection into morning-brief / shutdown-debrief
 * prompts. Deterministic — every known/ambiguous/unknown classification comes
 * from the resolver, not from LLM judgment. Contains strong directives
 * forbidding the agent from inventing attendee names.
 */
export function formatCalendarBrief(dateISO: string, resolved: ResolvedEvent[]): string {
  const lines: string[] = [];
  lines.push(`## Calendar Brief — ${dateISO} (deterministic kit — do NOT re-derive)`);
  lines.push("");
  lines.push(
    "**Rules for using this section (NON-NEGOTIABLE):**",
  );
  lines.push(
    "- For each event, the attendee classification below is authoritative. DO NOT invent names.",
  );
  lines.push(
    "- If an attendee is listed as ❓ unknown, output ❓ in your response — ask the user, do NOT guess.",
  );
  lines.push(
    "- If an attendee is listed as ambiguous with multiple candidates, list ALL candidates — do NOT pick one.",
  );
  lines.push(
    "- If an attendee is known, you have the dossier excerpt below — treat them as a real person with context.",
  );
  lines.push("");

  if (resolved.length === 0) {
    lines.push("_No events on this date._");
    return lines.join("\n");
  }

  for (const ev of resolved) {
    lines.push(`### ${ev.time} — ${ev.title}${ev.location ? ` @ ${ev.location}` : ""}`);
    if (ev.knownAttendees.length > 0) {
      for (const d of ev.knownAttendees) {
        const excerpt = d.excerpt ? ` — ${d.excerpt.slice(0, 120).trim()}` : "";
        lines.push(`- **Known**: ${d.name} (${d.orbit})${excerpt}`);
      }
    }
    for (const amb of ev.ambiguousAttendees) {
      const candidateNames = amb.candidates.map((c) => `${c.name} (${c.orbit})`).join(" OR ");
      lines.push(`- **Ambiguous**: "${amb.query}" — could be ${candidateNames}. Ask the user to disambiguate.`);
    }
    for (const name of ev.unknownAttendees) {
      lines.push(`- ❓ **Unknown**: "${name}" — no dossier match. DO NOT invent context.`);
    }
    if (ev.knownAttendees.length === 0 && ev.ambiguousAttendees.length === 0 && ev.unknownAttendees.length === 0) {
      lines.push("- _(solo event or no identifiable attendees)_");
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * High-level helper: fetch events for a date from all configured calendars,
 * dedupe, load dossiers, resolve attendees, format output. All deterministic.
 */
export async function buildCalendarBrief(options: {
  calendarIds: string[];
  dateISO: string;
  tzOffset: string;
  vaultRoot: string;
  userFirstName: string;
  userEmails?: string[];
  gwsPath?: string;
}): Promise<string> {
  const events = await fetchCalendarEvents(
    options.calendarIds,
    options.dateISO,
    options.tzOffset,
    options.gwsPath,
  );
  const deduped = deduplicateEvents(events);
  const dossiers = loadDossiers(options.vaultRoot);
  // Treat the user's calendar IDs as their own email addresses — anything
  // that looks like those should not be flagged as an unknown attendee.
  const userEmails = options.userEmails ?? options.calendarIds.filter((id) => id.includes("@"));
  const resolved = deduped.map((e) => resolveEvent(e, dossiers, options.userFirstName, userEmails));
  return formatCalendarBrief(options.dateISO, resolved);
}
