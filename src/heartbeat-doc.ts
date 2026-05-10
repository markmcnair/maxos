import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHeartbeat, type HeartbeatTask } from "./scheduler.js";
import { CronExpressionParser } from "cron-parser";
import { prettyTaskName } from "./health-summary.js";

interface DocRow {
  prettyName: string;
  cron: string;
  nextFire: string;
  silent: boolean;
  script: boolean;
  timeoutMs?: number;
  prompt: string;
}

function nextFireForCron(cron: string, now: Date): string {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: now });
    const next = it.next().toDate();
    return next.toLocaleString("en-US", {
      timeZone: "America/Chicago",
      hour12: false,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "(invalid cron)";
  }
}

function summarizePrompt(prompt: string): string {
  // Trim to ~100 chars on a word boundary so the table stays scannable
  if (prompt.length <= 100) return prompt;
  const trimmed = prompt.slice(0, 100);
  const lastSpace = trimmed.lastIndexOf(" ");
  return (lastSpace > 60 ? trimmed.slice(0, lastSpace) : trimmed) + "…";
}

export function buildHeartbeatDoc(tasks: HeartbeatTask[], now: Date = new Date()): string {
  const rows: DocRow[] = tasks.map((t) => ({
    prettyName: prettyTaskName(t.name),
    cron: t.cron,
    nextFire: nextFireForCron(t.cron, now),
    silent: t.silent ?? false,
    script: !!t.script,
    timeoutMs: t.timeout,
    prompt: summarizePrompt(t.prompt),
  }));

  const lines: string[] = [];
  lines.push("# MaxOS scheduled tasks");
  lines.push("");
  lines.push(`Auto-generated from \`HEARTBEAT.md\` at ${now.toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false })} CT.`);
  lines.push("");
  lines.push(`**${rows.length} tasks scheduled.**`);
  lines.push("");
  lines.push("Sorted by next-fire-time ascending — top of the list is what fires next.");
  lines.push("");

  // Sort by parsed next-fire timestamp
  const sorted = [...rows].sort((a, b) => {
    try {
      const ax = CronExpressionParser.parse(a.cron, { currentDate: now }).next().getTime();
      const bx = CronExpressionParser.parse(b.cron, { currentDate: now }).next().getTime();
      return ax - bx;
    } catch {
      return 0;
    }
  });

  lines.push("| When (next fire) | Cron | Task | Type | Timeout |");
  lines.push("|---|---|---|---|---|");
  for (const r of sorted) {
    const tags: string[] = [];
    if (r.script) tags.push("script");
    else tags.push("LLM one-shot");
    if (r.silent) tags.push("silent");
    const typeLabel = tags.join(", ");
    const timeoutLabel = r.timeoutMs
      ? `${Math.round(r.timeoutMs / 60_000)}m`
      : "default";
    lines.push(`| ${r.nextFire} | \`${r.cron}\` | **${r.prettyName}** | ${typeLabel} | ${timeoutLabel} |`);
  }
  lines.push("");

  // Detailed prompt list
  lines.push("## Task prompts");
  lines.push("");
  for (const r of sorted) {
    lines.push(`### ${r.prettyName}`);
    lines.push("");
    lines.push(`- **Cron:** \`${r.cron}\` (next: ${r.nextFire})`);
    lines.push(`- **Type:** ${r.script ? "shell script" : "LLM one-shot"}${r.silent ? " (silent)" : ""}`);
    if (r.timeoutMs) lines.push(`- **Timeout:** ${Math.round(r.timeoutMs / 60_000)} minutes`);
    lines.push(`- **Prompt:** ${r.prompt}`);
    lines.push("");
  }
  return lines.join("\n");
}

const isCLI = process.argv[1]?.endsWith("heartbeat-doc.js");
if (isCLI) {
  const maxosHome = process.env.MAXOS_HOME || `${process.env.HOME}/.maxos`;
  const heartbeatPath = join(maxosHome, "workspace", "HEARTBEAT.md");
  if (!existsSync(heartbeatPath)) {
    console.error("HEARTBEAT.md not found at", heartbeatPath);
    process.exit(1);
  }
  const md = readFileSync(heartbeatPath, "utf-8");
  const tasks = parseHeartbeat(md);
  console.log(buildHeartbeatDoc(tasks, new Date()));
}
