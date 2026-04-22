import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AuthoritativeRule {
  /** Filename of the feedback_*.md — used as a stable key for dedup. */
  filename: string;
  /** Rule name (from YAML frontmatter `name:` or filename fallback). */
  name: string;
  /** Markdown body of the rule, frontmatter stripped. */
  body: string;
}

/**
 * Convert a filesystem path into the slug Claude Code uses for its
 * per-project auto-memory directory. `/` and `.` both become `-`, which
 * is why paths like `/Users/Max/.maxos/workspace` land at
 * `~/.claude/projects/-Users-Max--maxos-workspace/`.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

function stripFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!raw.startsWith("---\n")) return { fm, body: raw };
  const endIdx = raw.indexOf("\n---", 4);
  if (endIdx < 0) return { fm, body: raw };
  const block = raw.slice(4, endIdx);
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  // Skip past the closing "---" + newline after it
  const afterFm = raw.slice(endIdx + 4).replace(/^\n+/, "");
  return { fm, body: afterFm };
}

/**
 * Parse a single feedback file into a structured rule. Falls back to a
 * filename-derived name when frontmatter is missing or unnamed.
 */
export function parseFeedbackFile(filename: string, raw: string): AuthoritativeRule {
  const { fm, body } = stripFrontmatter(raw);
  const explicitName = (fm.name || "").trim();
  const fallbackName = filename.replace(/\.md$/, "");
  return {
    filename,
    name: explicitName || fallbackName,
    body: body.trim(),
  };
}

function readFeedbackDir(dir: string): AuthoritativeRule[] {
  if (!dir || !existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const rules: AuthoritativeRule[] = [];
  for (const name of entries) {
    if (!name.startsWith("feedback_") || !name.endsWith(".md")) continue;
    try {
      const raw = readFileSync(join(dir, name), "utf-8");
      rules.push(parseFeedbackFile(name, raw));
    } catch {
      // skip unreadable
    }
  }
  return rules;
}

/**
 * Load authoritative rules from the workspace's memory/ folder plus any
 * additional source directories (used to pick up Claude Code's
 * auto-memory files). Dedup by filename — workspace/ version wins.
 *
 * The daemon calls this to inject rules directly into task prompts so
 * the LLM cannot pattern-match its way past them. Previously these
 * lived only in ~/.claude/projects/<slug>/memory/ which the one-shot
 * `claude -p` spawn doesn't traverse, causing the Body-sync bug where
 * the agent followed CLAUDE.md's "(local only)" label and ignored the
 * explicit feedback rule saying Body/ IS synced.
 */
export function loadAuthoritativeRules(
  maxosHome: string,
  extraSourceDirs: string[] = [],
): AuthoritativeRule[] {
  const primaryDir = join(maxosHome, "workspace", "memory");
  const dirs = [primaryDir, ...extraSourceDirs];

  const seen = new Set<string>();
  const rules: AuthoritativeRule[] = [];
  for (const dir of dirs) {
    for (const rule of readFeedbackDir(dir)) {
      if (seen.has(rule.filename)) continue;
      seen.add(rule.filename);
      rules.push(rule);
    }
  }
  // Stable sort by filename for deterministic output
  rules.sort((a, b) => a.filename.localeCompare(b.filename));
  return rules;
}

/**
 * Resolve the default list of Claude-auto-memory source directories
 * to scan alongside the workspace/memory/ folder. Looks in
 * ~/.claude/projects/<slugified-workspace-path>/memory/.
 */
export function defaultExtraSourceDirs(maxosHome: string): string[] {
  const workspace = join(maxosHome, "workspace");
  const slug = claudeProjectSlug(workspace);
  const candidate = join(homedir(), ".claude", "projects", slug, "memory");
  return existsSync(candidate) ? [candidate] : [];
}

/**
 * Format rules into a markdown block to prepend to task prompts.
 * Directive language is deliberately strong — these rules have already
 * been violated multiple times by the LLM pattern-matching against
 * contradictory summaries.
 */
export function formatAuthoritativeRules(rules: AuthoritativeRule[]): string {
  if (rules.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Authoritative Rules (NON-NEGOTIABLE — override any other document if they conflict)");
  lines.push("");
  lines.push(
    "These are rules Mark has captured as feedback after previous mistakes. " +
    "If a CLAUDE.md table, SOUL.md paragraph, or task-file step conflicts with a rule below, " +
    "the rule wins. Do NOT pattern-match your way around them.",
  );
  lines.push("");
  for (const rule of rules) {
    lines.push(`### ${rule.name}`);
    lines.push(`_(source: \`memory/${rule.filename}\`)_`);
    lines.push("");
    lines.push(rule.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
