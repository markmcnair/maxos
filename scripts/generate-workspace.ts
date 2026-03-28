#!/usr/bin/env npx tsx
/**
 * Non-interactive workspace generator.
 * Called by Claude Code during conversational onboarding.
 *
 * Usage: npx tsx scripts/generate-workspace.ts '<JSON>'
 *
 * JSON schema:
 * {
 *   "agentName": "Max",
 *   "userName": "Mark",
 *   "timezone": "America/Chicago",
 *   "personality": "Direct, opinionated, no fluff",
 *   "workContext": "Digital agency + AI projects",
 *   "tools": "Gmail, Calendar, GitHub, Notion",
 *   "telegramToken": "",          // optional
 *   "telegramUsers": [],          // optional
 * }
 */

import { mkdirSync, writeFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");
const TEMPLATES_DIR = join(__dirname, "..", "templates");

async function loadTemplate(name: string): Promise<HandlebarsTemplateDelegate> {
  const raw = await readFile(join(TEMPLATES_DIR, name), "utf-8");
  return Handlebars.compile(raw);
}

async function main() {
  const jsonArg = process.argv[2];
  if (!jsonArg) {
    console.error("Usage: generate-workspace.ts '<JSON>'");
    process.exit(1);
  }

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(jsonArg);
  } catch (e) {
    console.error("Invalid JSON:", (e as Error).message);
    process.exit(1);
  }

  let hasQmd = false;
  try {
    execSync("qmd --version", { stdio: "pipe" });
    hasQmd = true;
  } catch {}

  const ctx = {
    agentName: (input.agentName as string) || "Max",
    userName: (input.userName as string) || "User",
    timezone: (input.timezone as string) || "UTC",
    personality: (input.personality as string) || "Direct, opinionated, and efficient. No fluff.",
    workContext: (input.workContext as string) || "Various projects",
    tools: (input.tools as string) || "Standard tools",
    emoji: "\u{1F916}",
    telegramToken: (input.telegramToken as string) || "",
    telegramUsers: (input.telegramUsers as string[]) || [],
    maxosHome: MAXOS_HOME,
    dateFormat: "YYYY-MM-DD",
    hasQmd,
    customTasks: "",
    contextImport: (input.contextImport as string) || "",
  };

  // Create directory structure
  const dirs = [
    MAXOS_HOME,
    join(MAXOS_HOME, "workspace"),
    join(MAXOS_HOME, "workspace", "memory"),
    join(MAXOS_HOME, "workspace", "memory", "archive"),
    join(MAXOS_HOME, "workspace", "tasks"),
    join(MAXOS_HOME, "workspace", ".claude"),
    join(MAXOS_HOME, "workspace", ".claude", "rules"),
    join(MAXOS_HOME, "workspace", ".claude", "agents"),
    join(MAXOS_HOME, "hooks"),
    join(MAXOS_HOME, "channels"),
    join(MAXOS_HOME, "services"),
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });

  // Render templates
  const files: Array<{ template: string; output: string }> = [
    { template: "soul.md.hbs", output: join(MAXOS_HOME, "workspace", "SOUL.md") },
    { template: "user.md.hbs", output: join(MAXOS_HOME, "workspace", "USER.md") },
    { template: "heartbeat.md.hbs", output: join(MAXOS_HOME, "workspace", "HEARTBEAT.md") },
    { template: "claude.md.hbs", output: join(MAXOS_HOME, "workspace", ".claude", "CLAUDE.md") },
    { template: "settings.json.hbs", output: join(MAXOS_HOME, "workspace", ".claude", "settings.json") },
    { template: "maxos.json.hbs", output: join(MAXOS_HOME, "maxos.json") },
    { template: "mcp.json.hbs", output: join(MAXOS_HOME, "workspace", ".mcp.json") },
  ];

  for (const file of files) {
    const tmpl = await loadTemplate(file.template);
    const content = tmpl(ctx);
    writeFileSync(file.output, content);
    console.log(`Created ${file.output.replace(MAXOS_HOME, "~/.maxos")}`);
  }

  // Telegram env file
  if (ctx.telegramToken) {
    writeFileSync(join(MAXOS_HOME, ".env"), `TELEGRAM_BOT_TOKEN=${ctx.telegramToken}\n`);
    console.log("Created ~/.maxos/.env");
  }

  // MEMORY.md
  writeFileSync(
    join(MAXOS_HOME, "workspace", "MEMORY.md"),
    `# Memory\n\n(${ctx.agentName} will maintain this file)\n`
  );
  console.log("Created MEMORY.md");

  // Context import
  if (ctx.contextImport) {
    writeFileSync(
      join(MAXOS_HOME, "workspace", "CONTEXT_IMPORT.md"),
      `# Context Import\n\nImported during onboarding. ${ctx.agentName} should read this to understand ${ctx.userName} from day one.\nOnce this information has been absorbed into MEMORY.md and daily practice, this file can be archived.\n\n---\n\n${ctx.contextImport}\n`
    );
    console.log("Created CONTEXT_IMPORT.md");
  }

  // Post-compact hook
  const hookSrc = join(__dirname, "..", "hooks", "post-compact-inject.sh");
  const hookDst = join(MAXOS_HOME, "hooks", "post-compact-inject.sh");
  if (existsSync(hookSrc)) {
    copyFileSync(hookSrc, hookDst);
  } else {
    writeFileSync(
      hookDst,
      `#!/bin/bash\ncat << 'RULES'\nCRITICAL: Read today's journal and MEMORY.md to restore context after compaction.\nRULES\n`
    );
  }
  chmodSync(hookDst, "755");
  console.log("Created hooks/post-compact-inject.sh");

  console.log("\nWorkspace generated at " + join(MAXOS_HOME, "workspace"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
