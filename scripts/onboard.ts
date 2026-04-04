import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");

async function verifyTelegramToken(token: string): Promise<{ ok: boolean; botName?: string }> {
  try {
    const result = execSync(`curl -s "https://api.telegram.org/bot${token}/getMe"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    const data = JSON.parse(result);
    if (data.ok && data.result?.username) {
      return { ok: true, botName: `@${data.result.username}` };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function runOnboard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log("");
  console.log("Welcome to MaxOS \u2014 let\u2019s set up your personal AI agent.");
  console.log("I'll ask a few questions. You can change everything later by editing files.");
  console.log("\u2501".repeat(60));
  console.log("");

  // Phase 1: Identity
  const agentName = (await rl.question("What should your agent be called? (e.g., Max, Jarvis, Friday) > ")).trim() || "Max";
  const userName = (await rl.question("What's your name? > ")).trim() || "User";
  const timezone = (await rl.question("Timezone? (e.g., America/Chicago, Europe/London) > ")).trim() || "UTC";
  const personality = (await rl.question("Describe your ideal AI assistant's personality in a sentence > ")).trim() || "Direct, opinionated, and efficient. No fluff.";
  const workContext = (await rl.question("What kind of work do you do? > ")).trim() || "Various projects";
  const tools = (await rl.question("Daily tools/services? (e.g., Gmail, Calendar, Notion, GitHub) > ")).trim() || "Standard tools";

  // Context import
  console.log("");
  console.log("\u2501".repeat(60));
  console.log("");
  console.log("One more thing \u2014 optional but powerful.");
  console.log("");
  console.log("If you have existing context that would help your agent understand you");
  console.log("from day one, paste it below. This could be AI preferences, journal entries,");
  console.log("notes from Notion/Obsidian, how you like to work, your projects and goals.");
  console.log("");
  console.log("Paste as much as you want, then type END on its own line when done.");
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
    console.log(`\n\u2705 Got it \u2014 ${contextImport.split("\n").length} lines of context captured.`);
  }

  // Telegram setup
  console.log("");
  const connectTelegram = (await rl.question("Connect Telegram? (y/n) > ")).toLowerCase().startsWith("y");
  let telegramToken = "";
  let telegramUsers: string[] = [];

  if (connectTelegram) {
    console.log("\nGo to @BotFather on Telegram, create a bot, and paste the token:");

    let verified = false;
    while (!verified) {
      telegramToken = (await rl.question("> ")).trim();
      if (!telegramToken) {
        console.log("Skipping Telegram.");
        break;
      }
      console.log("Verifying token...");
      const result = await verifyTelegramToken(telegramToken);
      if (result.ok) {
        console.log(`\u2705 Verified: ${result.botName}`);
        verified = true;
      } else {
        console.log("\u274c Token verification failed. Try again (or press Enter to skip):");
      }
    }

    if (verified) {
      console.log("\nYour Telegram user ID (send /start to @userinfobot to find it):");
      const userId = (await rl.question("> ")).trim();
      if (userId) telegramUsers = [userId];
    }
  }

  // Primary channel
  console.log("");
  console.log("When you say 'send me something' or the agent needs to reach you proactively,");
  console.log("what's the default channel?");
  const primaryChannel = (await rl.question("(telegram/imessage/email) > ")).trim().toLowerCase() || (connectTelegram ? "telegram" : "");

  rl.close();

  // Generate workspace via generate-workspace.ts (single source of truth)
  console.log("\n" + "\u2501".repeat(60));
  console.log("Generating your workspace...\n");

  const generatorInput = JSON.stringify({
    agentName,
    userName,
    timezone,
    personality,
    workContext,
    tools,
    telegramToken,
    telegramUsers,
    primaryChannel,
    contextImport,
  });

  try {
    const output = execSync(
      `npx tsx scripts/generate-workspace.ts '${generatorInput.replace(/'/g, "'\\''")}'`,
      { cwd: join(homedir(), "Projects/maxos"), encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    // Print each line with a checkmark
    for (const line of output.trim().split("\n")) {
      if (line.startsWith("Created ")) {
        console.log(`\u2705 ${line}`);
      } else {
        console.log(line);
      }
    }
  } catch (err) {
    console.error("Workspace generation failed:", (err as Error).message);
    process.exit(1);
  }

  // Summary and next steps
  console.log("\n" + "\u2501".repeat(60));
  console.log("\n\u2705 Workspace generated at ~/.maxos/workspace\n");
  console.log("Next: connect your tools and set up automations.\n");

  if (existsSync(join(homedir(), ".claude"))) {
    console.log("  cd ~/.maxos/workspace && claude\n");
    console.log("Then tell your agent: \"set up my tools\"\n");
    console.log("It will discover what's on your machine, verify connections,");
    console.log("port existing automations, and get everything wired up.\n");
  } else {
    console.log("Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code");
    console.log("Then: cd ~/.maxos/workspace && claude\n");
  }

  if (connectTelegram && telegramToken) {
    console.log("Or skip setup and go straight to starting the daemon:\n");
    console.log("  npx maxos start --foreground\n");
    console.log("Then message your bot on Telegram to say hello!\n");
  }
}
