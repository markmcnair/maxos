import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdirSync, writeFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");
const TEMPLATES_DIR = join(__dirname, "..", "templates");

async function loadTemplate(name: string): Promise<HandlebarsTemplateDelegate> {
  const raw = await readFile(join(TEMPLATES_DIR, name), "utf-8");
  return Handlebars.compile(raw);
}

export async function runOnboard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log("");
  console.log("Welcome to MaxOS \u2014 let\u2019s set up your personal AI agent.");
  console.log("I'll ask a few questions. You can change everything later by editing files.");
  console.log("\u2501".repeat(60));
  console.log("");

  const agentName = await rl.question("What should your agent be called? (e.g., Max, Jarvis, Friday) > ");
  const userName = await rl.question("What's your name? > ");
  const timezone = await rl.question("Timezone? (e.g., America/Chicago, Europe/London) > ");
  const personality = await rl.question("Describe your ideal AI assistant's personality in a sentence > ");
  const workContext = await rl.question("What kind of work do you do? > ");
  const tools = await rl.question("Daily tools/services? (e.g., Gmail, Calendar, Notion, GitHub) > ");

  // Context import — the secret weapon for day-one usefulness
  console.log("");
  console.log("\u2501".repeat(60));
  console.log("");
  console.log("One more thing — and this is optional but powerful.");
  console.log("");
  console.log("If you have any existing context that would help your agent");
  console.log("understand you from day one, you can paste it below. This could be:");
  console.log("");
  console.log("  - Your AI preferences from Claude/ChatGPT settings");
  console.log("  - A journal entry or personal README");
  console.log("  - Notes from Notion, Obsidian, Google Docs — anything");
  console.log("  - How you like to work, what frustrates you, what energizes you");
  console.log("  - Context about your projects, team, or goals");
  console.log("");
  console.log("The more your agent knows on day one, the less it has to learn");
  console.log("the hard way. Paste as much as you want (even multiple pages),");
  console.log("then type END on its own line when you're done.");
  console.log("Or just press Enter to skip.");
  console.log("");

  let contextImport = "";
  const firstLine = await rl.question("Paste context (or Enter to skip) > ");
  if (firstLine.trim() && firstLine.trim().toUpperCase() !== "END") {
    const contextLines = [firstLine];
    console.log("(Keep pasting. Type END on its own line when done.)");
    let line: string;
    while (true) {
      line = await rl.question("");
      if (line.trim().toUpperCase() === "END") break;
      contextLines.push(line);
    }
    contextImport = contextLines.join("\n").trim();
    console.log(`\n Got it — ${contextImport.split("\n").length} lines of context captured.`);
  }

  console.log("");
  const connectTelegram = (await rl.question("Connect Telegram? (y/n) > ")).toLowerCase().startsWith("y");
  let telegramToken = "";
  let telegramUsers: string[] = [];

  if (connectTelegram) {
    console.log("\nGo to @BotFather on Telegram, create a bot, and paste the token:");
    telegramToken = await rl.question("> ");
    console.log("\nYour Telegram user ID (send /start to @userinfobot to find it):");
    const userId = await rl.question("> ");
    telegramUsers = [userId.trim()];
  }

  rl.close();

  console.log("\n" + "\u2501".repeat(60));
  console.log("Generating your workspace...\n");

  let hasQmd = false;
  try {
    const { execSync } = await import("node:child_process");
    execSync("qmd --version", { stdio: "pipe" });
    hasQmd = true;
  } catch {}

  const ctx = {
    agentName: agentName || "Max",
    userName: userName || "User",
    timezone: timezone || "UTC",
    personality: personality || "Direct, opinionated, and efficient. No fluff.",
    workContext: workContext || "Various projects",
    tools: tools || "Standard tools",
    emoji: "\u{1F916}",
    telegramToken,
    telegramUsers,
    maxosHome: MAXOS_HOME,
    dateFormat: "YYYY-MM-DD",
    hasQmd,
    customTasks: "",
    contextImport: contextImport,
  };

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
    console.log(`\u2705 Generated ${file.output.replace(MAXOS_HOME, "~/.maxos")}`);
  }

  if (telegramToken) {
    writeFileSync(join(MAXOS_HOME, ".env"), `TELEGRAM_BOT_TOKEN=${telegramToken}\n`);
    console.log("\u2705 Generated ~/.maxos/.env");
  }

  writeFileSync(join(MAXOS_HOME, "workspace", "MEMORY.md"), `# Memory\n\n(${ctx.agentName} will maintain this file)\n`);
  console.log("\u2705 Generated MEMORY.md");

  // Write context import if provided
  if (contextImport) {
    writeFileSync(
      join(MAXOS_HOME, "workspace", "CONTEXT_IMPORT.md"),
      `# Context Import\n\nImported during onboarding. ${ctx.agentName} should read this to understand ${ctx.userName} from day one.\nOnce this information has been absorbed into MEMORY.md and daily practice, this file can be archived.\n\n---\n\n${contextImport}\n`
    );
    console.log("\u2705 Generated CONTEXT_IMPORT.md");
  }

  const hookSrc = join(__dirname, "..", "hooks", "post-compact-inject.sh");
  const hookDst = join(MAXOS_HOME, "hooks", "post-compact-inject.sh");
  if (existsSync(hookSrc)) {
    copyFileSync(hookSrc, hookDst);
  } else {
    writeFileSync(hookDst, `#!/bin/bash\ncat << 'RULES'\nCRITICAL: Read today's journal and MEMORY.md to restore context after compaction.\nRULES\n`);
  }
  chmodSync(hookDst, "755");
  console.log("\u2705 Generated hooks/post-compact-inject.sh");

  console.log("\n" + "\u2501".repeat(60));
  console.log("\nYour agent is ready! Start it with:\n");
  console.log("  npx maxos start --foreground\n");
  console.log("Or install as a system service:\n");
  console.log("  npx maxos install-service\n");
  if (connectTelegram) {
    console.log("Then open Telegram and message your bot to say hello!\n");
  }
}
