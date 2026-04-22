import { join } from "node:path";
import { loadDossiers, matchDossier, type Dossier } from "./calendar-brief.js";

export interface MeetingContext {
  title: string;
  time: string;
  location?: string;
  /** Raw attendee references — names, emails, names-with-parens, etc. */
  attendees: string[];
  purpose?: string;
}

/**
 * Parse the `MEETING CONTEXT: Title: X, Time: Y, Location: Z, Attendees: ...,
 * Purpose: ...` block that shutdown-debrief injects when it schedules a
 * meeting-prep one-shot. Tolerant of missing optional fields.
 */
export function parseMeetingContext(prompt: string): MeetingContext | null {
  const idx = prompt.search(/MEETING CONTEXT\s*:/i);
  if (idx < 0) return null;
  const body = prompt.slice(idx);

  const pick = (key: string): string | undefined => {
    const re = new RegExp(`\\b${key}\\s*:\\s*([^\\n]+?)(?:(?=,\\s*(?:Title|Time|Location|Attendees|Purpose)\\s*:)|\\n|$)`, "i");
    const m = body.match(re);
    return m?.[1]?.trim();
  };

  const title = pick("Title") ?? "";
  const time = pick("Time") ?? "";
  const location = pick("Location");
  const attendeesRaw = pick("Attendees");
  const purpose = pick("Purpose");

  // Attendees can be comma- or semicolon-separated; respect parens as grouping
  const attendees: string[] = [];
  if (attendeesRaw) {
    let depth = 0;
    let buf = "";
    for (const ch of attendeesRaw) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if ((ch === "," || ch === ";") && depth === 0) {
        if (buf.trim()) attendees.push(buf.trim());
        buf = "";
      } else {
        buf += ch;
      }
    }
    if (buf.trim()) attendees.push(buf.trim());
  }

  if (!title && attendees.length === 0) return null;

  return { title, time, location, attendees, purpose };
}

/**
 * Strip a parenthesized suffix like "(email@x.com)" or "(555-1234)" from
 * an attendee reference before matching. Then delegate to matchDossier
 * (full-name or first-name unambiguous match; returns null on ambiguity
 * so the LLM is forced to ask rather than guess).
 */
export function matchAttendeeToDossier(raw: string, dossiers: Dossier[]): Dossier | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!cleaned) return null;
  const result = matchDossier(cleaned, dossiers);
  if (result.kind === "single") return result.dossier;
  return null; // none OR ambiguous — both require human clarification
}

/**
 * Format the meeting-prep kit as markdown. Known attendees get their
 * dossier excerpt. Unknown attendees get a ❓ flag with a hard "DO NOT
 * invent" directive to prevent the Mike-Salem-for-Mark-y-Mark class of
 * hallucination.
 */
export function formatMeetingPrepKit(
  ctx: MeetingContext,
  known: Dossier[],
  unknown: string[],
): string {
  const lines: string[] = [];
  lines.push("## Meeting Prep Kit (deterministic — trust, do not re-derive)");
  lines.push("");
  lines.push("**Rules (NON-NEGOTIABLE):**");
  lines.push("- Attendee classifications below are authoritative. DO NOT invent context.");
  lines.push("- If an attendee is flagged ❓ unknown, emit ❓ in the prep output and ASK Mark — do not guess.");
  lines.push("- Use the dossier excerpts for Known attendees as your primary context source. You do not need to re-scan the vault for their info.");
  lines.push("");
  lines.push("### Event");
  lines.push(`- **Title:** ${ctx.title}`);
  lines.push(`- **Time:** ${ctx.time}`);
  if (ctx.location) lines.push(`- **Location:** ${ctx.location}`);
  if (ctx.purpose) lines.push(`- **Purpose:** ${ctx.purpose}`);
  lines.push("");

  if (known.length > 0) {
    lines.push(`### Known Attendees (${known.length})`);
    for (const d of known) {
      const phone = d.phone ? ` — phone: ${d.phone}` : "";
      lines.push(`- **${d.name}** (${d.orbit})${phone}`);
      if (d.excerpt) {
        const trimmed = d.excerpt.replace(/\s+/g, " ").trim().slice(0, 300);
        lines.push(`  _Dossier excerpt:_ ${trimmed}`);
      }
    }
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push(`### ❓ Unknown Attendees (${unknown.length}) — DO NOT invent`);
    for (const u of unknown) {
      lines.push(`- ❓ "${u}" — no dossier match. ASK Mark before inferring anything about this person.`);
    }
    lines.push("");
  }

  if (known.length === 0 && unknown.length === 0) {
    lines.push("_(no attendees listed — prep with general context only)_");
  }

  return lines.join("\n").trimEnd();
}

/**
 * High-level helper: parse the prompt, match each attendee, produce
 * the kit markdown. Returns empty string if the prompt has no
 * MEETING CONTEXT section (not a meeting-prep task).
 */
export function buildMeetingPrepKit(options: {
  maxosHome: string;
  prompt: string;
}): string {
  const ctx = parseMeetingContext(options.prompt);
  if (!ctx) return "";
  const vaultRoot = join(options.maxosHome, "vault");
  const dossiers = loadDossiers(vaultRoot);
  const known: Dossier[] = [];
  const unknown: string[] = [];
  for (const raw of ctx.attendees) {
    const matched = matchAttendeeToDossier(raw, dossiers);
    if (matched && !known.some((d) => d.name === matched.name)) {
      known.push(matched);
    } else if (!matched) {
      unknown.push(raw);
    }
  }
  return formatMeetingPrepKit(ctx, known, unknown);
}
