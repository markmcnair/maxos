import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GhostedEntry {
  timestamp: string;
  phone: string;
  name?: string;
  text: string;
}

/**
 * Parse output of `imessage-scan --ghosted --resolve-names /path/to/vault`.
 *
 * Format per line: `timestamp|phone|optional_name_prefix + text`
 * Name prefix (if --resolve-names matched a dossier): `Name — text`
 */
export function parseAuthoritativeGhosted(raw: string): GhostedEntry[] {
  if (!raw) return [];
  const out: GhostedEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstPipe = trimmed.indexOf("|");
    if (firstPipe < 0) continue;
    const secondPipe = trimmed.indexOf("|", firstPipe + 1);
    if (secondPipe < 0) continue;
    const timestamp = trimmed.slice(0, firstPipe);
    const phone = trimmed.slice(firstPipe + 1, secondPipe);
    const rest = trimmed.slice(secondPipe + 1);

    let name: string | undefined;
    let text = rest;
    // --resolve-names format: "Name — text"
    const dashIdx = rest.indexOf(" — ");
    if (dashIdx > 0 && dashIdx < 80) {
      const possibleName = rest.slice(0, dashIdx).trim();
      // Heuristic: a name is 1-4 words, starts with a capital letter
      if (/^[A-Z][a-zA-Z'’\- ]{1,50}$/.test(possibleName) && possibleName.split(/\s+/).length <= 4) {
        name = possibleName;
        text = rest.slice(dashIdx + 3);
      }
    }
    if (!timestamp || !phone) continue;
    out.push({ timestamp, phone, name, text });
  }
  return out;
}

/**
 * Fetch the authoritative ghosted list by shelling out to imessage-scan.
 */
export async function fetchAuthoritativeGhosted(options: {
  maxosHome?: string;
  hours?: number;
  since?: string;
}): Promise<GhostedEntry[]> {
  const maxosHome = options.maxosHome ?? process.env.MAXOS_HOME ?? join(homedir(), ".maxos");
  const scan = join(maxosHome, "workspace", "tools", "imessage-scan");
  const vault = join(maxosHome, "vault");
  const args = ["--ghosted", "--resolve-names", vault];
  if (options.since) args.push("--since", options.since);
  else args.push("--hours", String(options.hours ?? 24));
  try {
    const { stdout } = await execFileAsync(scan, args, {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseAuthoritativeGhosted(stdout);
  } catch {
    return [];
  }
}

/**
 * Heading patterns recognized as the "Ghosted" section across morning
 * brief + shutdown debrief output formats. Case-insensitive; allows the
 * 👻 emoji and various punctuation.
 */
const GHOSTED_HEADER_RE = /^##[^\n]*👻[^\n]*ghosted/i;

function isSectionHeader(line: string): boolean {
  return /^##\s/.test(line.trim());
}

function isGhostedHeader(line: string): boolean {
  return GHOSTED_HEADER_RE.test(line);
}

function canonicalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function entryMatchesLine(line: string, entry: GhostedEntry): boolean {
  const lower = line.toLowerCase();
  const phoneCanonical = canonicalPhone(entry.phone);
  // Phone match: check for canonical 10-digit substring in line
  if (phoneCanonical.length === 10) {
    const lineDigits = line.replace(/\D/g, "");
    if (lineDigits.includes(phoneCanonical)) return true;
  }
  // Name match (if resolved): case-insensitive substring.
  if (entry.name) {
    const firstName = entry.name.split(/\s+/)[0].toLowerCase();
    if (firstName.length >= 3 && lower.includes(firstName)) return true;
    if (lower.includes(entry.name.toLowerCase())) return true;
  }
  return false;
}

/**
 * Strip any bullet under the "Ghosted" section whose identifying name
 * or phone doesn't appear in the authoritative list. Continuation lines
 * (indented / non-bullet) under a stripped bullet are also removed.
 *
 * Other sections are untouched — we only enforce the one section where
 * the LLM has repeatedly ignored the authoritative source.
 */
export function stripInvalidGhosted(output: string, authoritative: GhostedEntry[]): string {
  const lines = output.split("\n");
  const result: string[] = [];
  let inGhostedSection = false;
  let currentBulletStart = -1;
  let currentBulletValid = true;

  const flushBullet = () => {
    if (!currentBulletValid && currentBulletStart >= 0) {
      result.length = currentBulletStart;
    }
    currentBulletStart = -1;
    currentBulletValid = true;
  };

  for (const line of lines) {
    if (isSectionHeader(line)) {
      flushBullet();
      inGhostedSection = isGhostedHeader(line);
      result.push(line);
      continue;
    }

    if (!inGhostedSection) {
      result.push(line);
      continue;
    }

    const trimmed = line.trim();
    const isBullet = /^(\d+\.|[-*•])\s/.test(trimmed);

    if (isBullet) {
      flushBullet();
      const matchesAny = authoritative.some((e) => entryMatchesLine(line, e));
      currentBulletStart = result.length;
      currentBulletValid = matchesAny;
      result.push(line);
    } else {
      // Continuation: indented prose or blank. Blank lines are OK to keep.
      // If the current bullet is being dropped, drop continuation text too.
      if (!currentBulletValid && trimmed && !isBullet) continue;
      result.push(line);
    }
  }
  flushBullet();

  return result.join("\n");
}
