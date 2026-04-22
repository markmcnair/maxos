#!/usr/bin/env node

import { config as loadDotenv } from "dotenv";
import { Command } from "commander";
import { Gateway } from "./gateway.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { parseHeartbeat } from "./scheduler.js";
import { oneShot } from "./engine.js";
import { loadConfig } from "./config.js";
import { parseTimeToTimestamp } from "./utils/time.js";
import { writeRestartMarker } from "./restart-marker.js";
import { buildMemoryContext } from "./memory.js";

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");
const HEALTH_URL = "http://127.0.0.1:18790/health";
const API_BASE = "http://127.0.0.1:18790/api";

// Auto-load .env from MAXOS_HOME
loadDotenv({ path: join(MAXOS_HOME, ".env") });

/**
 * Deterministic pre-flight: kill competing pollers, disable conflicting plugins.
 * This is scripted (not LLM) because it's 100% deterministic and must never vary.
 */
async function runPreflight(): Promise<void> {
  const { execSync } = await import("node:child_process");
  const { platform } = await import("node:os");

  console.log("Pre-flight checks...");

  // 1. Kill anything holding the health check port (previous daemon, zombie, etc.)
  try {
    const portHolder = execSync(`lsof -ti :18790 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (portHolder) {
      console.log(`  Killing process on port 18790 (PID ${portHolder})...`);
      try { execSync(`kill ${portHolder}`, { stdio: "pipe" }); } catch {}
      // Wait for port to actually free
      await new Promise(r => setTimeout(r, 2000));
      // Force-kill if still hanging
      try {
        const stillThere = execSync(`lsof -ti :18790 2>/dev/null`, { encoding: "utf-8" }).trim();
        if (stillThere) {
          execSync(`kill -9 ${stillThere}`, { stdio: "pipe" });
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch {}
    }
  } catch {
    // Port is free — good
  }

  // 2. Kill competing Telegram pollers (CCBot, Claude plugins, old MaxOS)
  const killPatterns = ["ccbot", "plugin.*telegram"];
  for (const pat of killPatterns) {
    try { execSync(`pkill -f "${pat}" 2>/dev/null`, { stdio: "pipe" }); } catch {}
  }

  // Kill tmux sessions used by old bridges
  for (const sess of ["ccbot", "ccbot-2", "claude-channels"]) {
    try { execSync(`tmux kill-session -t ${sess} 2>/dev/null`, { stdio: "pipe" }); } catch {}
  }

  // 3. Disable Claude Code's Telegram plugin (prevents future sessions from auto-polling)
  const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(claudeSettingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
      let changed = false;

      // Disable telegram plugin
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (settings.enabledPlugins["telegram@claude-plugins-official"] !== false) {
        settings.enabledPlugins["telegram@claude-plugins-official"] = false;
        changed = true;
      }

      // Remove CCBot SessionStart hooks
      const startHooks = settings.hooks?.SessionStart;
      if (Array.isArray(startHooks)) {
        const filtered = startHooks.filter((h: any) =>
          !h.hooks?.some((hk: any) => (hk.command || "").includes("ccbot"))
        );
        if (filtered.length !== startHooks.length) {
          settings.hooks.SessionStart = filtered;
          changed = true;
        }
      }

      if (changed) {
        const { writeFileSync: writeSync } = await import("node:fs");
        writeSync(claudeSettingsPath, JSON.stringify(settings, null, 2));
        console.log("  Disabled conflicting Telegram plugin/hooks.");
      }
    } catch {
      // Non-fatal — settings file may be malformed
    }
  }

  // 4. Unload old launchd scheduled tasks (macOS only)
  // NOTE: Excludes com.maxos.daemon.plist — that's OUR launch agent, don't unload it.
  // Only kill OLD/legacy ccbot agents and any other stale com.maxos.* entries.
  if (platform() === "darwin") {
    try {
      const agents = execSync("ls ~/Library/LaunchAgents/ 2>/dev/null", { encoding: "utf-8" });
      for (const line of agents.split("\n")) {
        const name = line.trim();
        if (name === "com.maxos.daemon.plist") continue; // Never unload self
        if (/^com\.(maxos|ccbot)\./.test(name)) {
          try {
            execSync(`launchctl unload ~/Library/LaunchAgents/${name} 2>/dev/null`, { stdio: "pipe" });
          } catch {}
        }
      }
    } catch {}
  }

  // 5. Wait for Telegram API to release the polling lock
  await new Promise(r => setTimeout(r, 2000));
  console.log("  Pre-flight complete.");
}
const program = new Command();

program
  .name("maxos")
  .description("Personal AI agent runtime powered by Claude Code")
  .version("0.1.0");

program
  .command("start")
  .description("Start the MaxOS daemon")
  .option("--foreground", "Run in foreground")
  .option("--skip-preflight", "Skip pre-flight checks (kill pollers, disable plugins)")
  .action(async (opts) => {
    if (!opts.skipPreflight) {
      await runPreflight();
    }
    const gateway = new Gateway(opts.foreground ?? false);
    await gateway.start();
  });

program
  .command("run-task <name>")
  .description("Manually run a scheduled HEARTBEAT task WITH full deterministic Kit injection (recovers from missed cron runs without bypassing Kit)")
  .option("--dry-run", "Print the full injected prompt without spawning Claude")
  .option("--no-deliver", "Print result to stdout only, skip Telegram delivery")
  .action(async (nameArg: string, opts) => {
    const { readFileSync } = await import("node:fs");
    const heartbeatPath = join(MAXOS_HOME, "workspace", "HEARTBEAT.md");
    if (!existsSync(heartbeatPath)) {
      console.error(`HEARTBEAT.md not found at ${heartbeatPath}`);
      process.exit(1);
    }
    const tasks = parseHeartbeat(readFileSync(heartbeatPath, "utf-8"));
    const needle = nameArg.toLowerCase().replace(/[-_\s]/g, "");
    const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
    const matches = tasks.filter((t) =>
      normalize(t.prompt).includes(needle) || normalize(t.name ?? "").includes(needle),
    );
    if (matches.length === 0) {
      console.error(`No task matched "${nameArg}". Known tasks:`);
      for (const t of tasks) console.error(`  - ${t.name ?? "(unnamed)"}: ${t.prompt.slice(0, 60)}...`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Multiple tasks matched "${nameArg}":`);
      for (const t of matches) console.error(`  - ${t.name ?? "(unnamed)"}: ${t.prompt.slice(0, 60)}...`);
      process.exit(1);
    }
    const task = matches[0];
    const taskName = task.name ?? `manual-${nameArg}`;
    console.error(`Running task: ${taskName}`);

    const memoryContext = await buildMemoryContext(task.prompt, { taskName }).catch(() => "");
    const fullPrompt = memoryContext
      ? `${memoryContext}\n\n---\n\n${task.prompt}`
      : task.prompt;

    if (opts.dryRun) {
      console.log(fullPrompt);
      return;
    }

    const config = loadConfig(join(MAXOS_HOME, "maxos.json"));
    const result = await oneShot({
      prompt: fullPrompt,
      cwd: join(MAXOS_HOME, "workspace"),
      model: config.engine.model,
      outputFormat: "text",
      timeout: config.engine.maxOneShotTimeout,
      permissionMode: config.engine.permissionMode,
      allowedTools: config.engine.allowedTools,
    });

    console.log(result);

    if (opts.deliver !== false) {
      // Best-effort Telegram delivery — only if daemon is up and can route
      try {
        await fetch(`${API_BASE}/deliver-task`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskName, result }),
        });
      } catch {
        console.error("(Delivery to Telegram failed — daemon may be down. Result printed above.)");
      }
    }
  });

program
  .command("status")
  .description("Show daemon status")
  .action(async () => {
    try {
      const res = await fetch(HEALTH_URL);
      const data = await res.json();
      console.log("MaxOS Status:", JSON.stringify(data, null, 2));
    } catch {
      console.log("MaxOS is not running.");
    }
  });

program
  .command("stop")
  .description("Stop the MaxOS daemon")
  .action(async () => {
    try {
      // Check if it's actually running first
      let running = false;
      try {
        const res = await fetch(HEALTH_URL);
        running = res.ok;
      } catch {
        // Not running
      }

      if (!running) {
        console.log("MaxOS is not running.");
        return;
      }

      // Kill by port — works regardless of how the daemon was started
      const { execSync } = await import("node:child_process");
      try {
        const pid = execSync("lsof -ti :18790 2>/dev/null", { encoding: "utf-8" }).trim();
        if (pid) {
          execSync(`kill ${pid}`, { stdio: "pipe" });
          // Wait briefly for graceful shutdown
          await new Promise(r => setTimeout(r, 2000));
          // Force-kill if still hanging
          try {
            const stillThere = execSync("lsof -ti :18790 2>/dev/null", { encoding: "utf-8" }).trim();
            if (stillThere) execSync(`kill -9 ${stillThere}`, { stdio: "pipe" });
          } catch {}
        }
      } catch {}
      console.log("MaxOS stopped.");
    } catch (err) {
      console.error("Failed to stop:", err instanceof Error ? err.message : err);
    }
  });

program
  .command("restart")
  .description("Stop and restart the MaxOS daemon")
  .action(async () => {
    try {
      // Drop a marker before killing so the next boot knows this restart was
      // intentional and can tell the user "Restart complete" instead of
      // reporting a crash (shutdowns that time out the drain get SIGKILL'd
      // and look identical to a crash in the journal).
      writeRestartMarker(MAXOS_HOME, "user-requested");

      const { execSync } = await import("node:child_process");
      // Kill existing daemon by port
      try {
        const pid = execSync("lsof -ti :18790 2>/dev/null", { encoding: "utf-8" }).trim();
        if (pid) {
          execSync(`kill ${pid}`, { stdio: "pipe" });
          await new Promise(r => setTimeout(r, 2000));
          try {
            const stillThere = execSync("lsof -ti :18790 2>/dev/null", { encoding: "utf-8" }).trim();
            if (stillThere) execSync(`kill -9 ${stillThere}`, { stdio: "pipe" });
          } catch {}
        }
      } catch {}

      // Start fresh
      await runPreflight();
      const gateway = new Gateway(false);
      await gateway.start();
      console.log("MaxOS restarted.");
    } catch (err) {
      console.error("Failed to restart:", err instanceof Error ? err.message : err);
    }
  });

program
  .command("logs")
  .description("Tail daemon logs")
  .option("--crash", "Show crash journal instead")
  .option("-n, --lines <count>", "Number of lines to show (default: all)", parseInt)
  .option("-f, --follow", "Follow log output in real-time")
  .action(async (opts) => {
    const file = opts.crash ? join(MAXOS_HOME, "crash.log") : join(MAXOS_HOME, "daemon.log");
    if (!existsSync(file)) {
      console.log("No logs found.");
      return;
    }

    if (opts.follow) {
      const { execSync } = await import("node:child_process");
      const n = opts.lines ?? 20;
      try {
        // Use tail -f for real-time following — inherits stdio so user sees output live
        const { spawn } = await import("node:child_process");
        const tail = spawn("tail", ["-n", String(n), "-f", file], { stdio: "inherit" });
        tail.on("exit", () => process.exit(0));
        process.on("SIGINT", () => { tail.kill(); process.exit(0); });
      } catch {
        console.error("Failed to follow logs.");
      }
      return;
    }

    const content = readFileSync(file, "utf-8");
    if (opts.lines) {
      const lines = content.trimEnd().split("\n");
      console.log(lines.slice(-opts.lines).join("\n"));
    } else {
      console.log(content);
    }
  });

program
  .command("doctor")
  .description("Check system health")
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    try {
      const { execSync } = await import("node:child_process");
      execSync("claude --version", { stdio: "pipe" });
      checks.push({ name: "Claude CLI", ok: true, detail: "installed" });
    } catch {
      checks.push({ name: "Claude CLI", ok: false, detail: "not found — install from https://claude.ai/code" });
    }

    const nodeVersion = process.versions.node;
    const major = parseInt(nodeVersion.split(".")[0]);
    checks.push({ name: "Node.js", ok: major >= 22, detail: `v${nodeVersion}` });

    checks.push({ name: "Config", ok: existsSync(join(MAXOS_HOME, "maxos.json")), detail: join(MAXOS_HOME, "maxos.json") });

    checks.push({ name: "Workspace", ok: existsSync(join(MAXOS_HOME, "workspace", "SOUL.md")), detail: join(MAXOS_HOME, "workspace") });

    try {
      const { execSync } = await import("node:child_process");
      execSync("qmd --version", { stdio: "pipe" });
      checks.push({ name: "QMD", ok: true, detail: "installed (Tier 3 memory)" });
    } catch {
      checks.push({ name: "QMD", ok: false, detail: "not found — optional, install from https://github.com/tobi/qmd" });
    }

    for (const check of checks) {
      const icon = check.ok ? "\u2705" : "\u274C";
      console.log(`${icon} ${check.name}: ${check.detail}`);
    }
  });

program
  .command("init")
  .description("Set up identity and generate workspace (step 1 of onboarding)")
  .action(async () => {
    const { runOnboard } = await import("../scripts/onboard.js");
    await runOnboard();
  });

program
  .command("setup")
  .description("Connect tools and automations via Claude Code (step 2 of onboarding)")
  .action(async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");
    const workspace = join(MAXOS_HOME, "workspace");

    if (!existsSync(join(workspace, "SOUL.md"))) {
      console.error("No workspace found. Run `npx maxos init` first.");
      process.exit(1);
    }

    console.log("Opening Claude Code in your workspace for tool setup...\n");
    const { execSync } = await import("node:child_process");
    try {
      execSync("claude", { cwd: workspace, stdio: "inherit" });
    } catch {
      console.log("\nClaude Code not found. Install it from: https://docs.anthropic.com/en/docs/claude-code");
      console.log(`Then run: cd ${workspace} && claude`);
      console.log('Tell your agent: "set up my tools"');
    }
  });

program
  .command("run-at <time> <prompt...>")
  .description("Schedule a one-time task (e.g., maxos run-at \"9:57pm\" \"Find the best AI post\")")
  .option("--silent", "Run but don't deliver output")
  .action(async (time: string, promptParts: string[], opts: { silent?: boolean }) => {
    const prompt = promptParts.join(" ");
    const fireAt = parseTimeToTimestamp(time);
    if (!fireAt) {
      console.error(`Could not parse time: "${time}". Use formats like "9:57pm", "21:57", "14:30".`);
      process.exit(1);
    }

    const port = 18790; // default health check port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/oneshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fireAt, prompt, silent: opts.silent ?? false }),
      });
      const data = await res.json() as { ok: boolean; id?: string; fireAt?: string; error?: string };
      if (data.ok) {
        const fireDate = new Date(fireAt);
        console.log(`✅ Scheduled one-shot ${data.id} for ${fireDate.toLocaleTimeString()}`);
        console.log(`   Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);
      } else {
        console.error(`Failed: ${data.error}`);
        process.exit(1);
      }
    } catch {
      console.error("Could not reach MaxOS daemon. Is it running? (maxos start)");
      process.exit(1);
    }
  });

// Re-export for backward compatibility
export { parseTimeToTimestamp } from "./utils/time.js";

program
  .command("install-service")
  .description("Install MaxOS as a system service (launchd/systemd)")
  .action(async () => {
    const { installService } = await import("../scripts/service.js");
    installService();
  });

program
  .command("uninstall-service")
  .description("Remove MaxOS system service")
  .action(async () => {
    const { uninstallService } = await import("../scripts/service.js");
    uninstallService();
  });

// --- cron subcommands ---

const cronCmd = program
  .command("cron")
  .description("Manage scheduled heartbeat tasks");

cronCmd
  .command("list")
  .description("Show all heartbeat tasks and their status")
  .action(async () => {
    // Try to get live status from the daemon first
    try {
      const res = await fetch(`${API_BASE}/cron/list`);
      if (res.ok) {
        const tasks = (await res.json()) as Array<{
          name: string;
          cron: string;
          disabled: boolean;
          failures: number;
          lastRun: number | null;
        }>;
        if (tasks.length === 0) {
          console.log("No tasks registered in the daemon.");
          return;
        }
        console.log(
          "Name".padEnd(45) + "Schedule".padEnd(25) + "Status"
        );
        console.log("-".repeat(80));
        for (const task of tasks) {
          const status = task.disabled
            ? `disabled (${task.failures} failures)`
            : "enabled";
          console.log(
            task.name.padEnd(45) +
            task.cron.padEnd(25) +
            status
          );
        }
        return;
      }
    } catch {
      // Daemon not running — fall back to HEARTBEAT.md parsing
    }

    // Fallback: parse HEARTBEAT.md directly
    const heartbeatPath = join(MAXOS_HOME, "workspace", "HEARTBEAT.md");
    if (!existsSync(heartbeatPath)) {
      console.log("No HEARTBEAT.md found at", heartbeatPath);
      return;
    }
    const md = readFileSync(heartbeatPath, "utf-8");
    const tasks = parseHeartbeat(md);
    if (tasks.length === 0) {
      console.log("No tasks found in HEARTBEAT.md.");
      return;
    }
    console.log(
      "Name".padEnd(45) + "Schedule".padEnd(25) + "Status"
    );
    console.log("-".repeat(80));
    for (const task of tasks) {
      console.log(
        task.name.padEnd(45) +
        task.cron.padEnd(25) +
        "unknown (daemon not running)"
      );
    }
  });

cronCmd
  .command("run <task>")
  .description("Run a specific task immediately by name")
  .action(async (taskName: string) => {
    const heartbeatPath = join(MAXOS_HOME, "workspace", "HEARTBEAT.md");
    if (!existsSync(heartbeatPath)) {
      console.error("No HEARTBEAT.md found at", heartbeatPath);
      process.exit(1);
    }
    const md = readFileSync(heartbeatPath, "utf-8");
    const tasks = parseHeartbeat(md);
    const task = tasks.find((t) => t.name === taskName);
    if (!task) {
      console.error(`Task "${taskName}" not found. Available tasks:`);
      for (const t of tasks) {
        console.error(`  ${t.name}`);
      }
      process.exit(1);
    }

    console.log(`Running task "${task.name}"...`);
    const configPath = join(MAXOS_HOME, "maxos.json");
    const config = loadConfig(configPath);
    try {
      const result = await oneShot({
        prompt: task.prompt,
        cwd: join(MAXOS_HOME, "workspace"),
        model: config.engine.model,
        outputFormat: "text",
        timeout: config.engine.maxOneShotTimeout,
        permissionMode: config.engine.permissionMode,
        allowedTools: config.engine.allowedTools,
      });
      if (result.trim()) {
        console.log(result);
      } else {
        console.log("Task completed (no output).");
      }
    } catch (err) {
      console.error("Task failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

cronCmd
  .command("enable <task>")
  .description("Re-enable a disabled task")
  .action(async (taskName: string) => {
    try {
      const res = await fetch(`${API_BASE}/cron/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: taskName }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        console.log(`Task "${taskName}" enabled.`);
      } else {
        console.error(`Failed to enable: ${data.error}`);
        process.exit(1);
      }
    } catch {
      console.error("MaxOS daemon is not running. Start it first: maxos start");
      process.exit(1);
    }
  });

cronCmd
  .command("disable <task>")
  .description("Disable a task")
  .action(async (taskName: string) => {
    try {
      const res = await fetch(`${API_BASE}/cron/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: taskName }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        console.log(`Task "${taskName}" disabled.`);
      } else {
        console.error(`Failed to disable: ${data.error}`);
        process.exit(1);
      }
    } catch {
      console.error("MaxOS daemon is not running. Start it first: maxos start");
      process.exit(1);
    }
  });

// --- sessions subcommands ---

const sessionsCmd = program
  .command("sessions")
  .description("Manage active Claude sessions");

sessionsCmd
  .command("list")
  .description("List active sessions")
  .action(async () => {
    try {
      const res = await fetch(HEALTH_URL);
      const data = (await res.json()) as { sessions: string[]; uptime: number };
      if (!data.sessions || data.sessions.length === 0) {
        console.log("No active sessions.");
        return;
      }
      console.log("Active sessions:");
      for (const name of data.sessions) {
        console.log(`  - ${name}`);
      }
    } catch {
      console.log("MaxOS is not running.");
    }
  });

sessionsCmd
  .command("reset")
  .description("Reset all sessions")
  .action(() => {
    console.log("Restart MaxOS to reset all sessions: maxos restart");
  });

// --- config subcommands ---

const configCmd = program
  .command("config")
  .description("View and manage configuration");

configCmd
  .command("show")
  .description("Display current configuration")
  .action(() => {
    const configPath = join(MAXOS_HOME, "maxos.json");
    if (!existsSync(configPath)) {
      console.log("No config file found at", configPath);
      console.log("Run 'maxos init' to create one.");
      return;
    }
    const raw = readFileSync(configPath, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      // Might be JSON5, just print raw
      console.log(raw);
    }
  });

configCmd
  .command("set <path> <value>")
  .description("Set a config value (dot-notation path, e.g. engine.model sonnet)")
  .action(async (path: string, value: string) => {
    const configPath = join(MAXOS_HOME, "maxos.json");
    const { writeFileSync: writeFile } = await import("node:fs");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const JSON5 = (await import("json5")).default;
        config = JSON5.parse(readFileSync(configPath, "utf-8"));
      } catch {
        console.error("Failed to parse config file.");
        process.exit(1);
      }
    }

    // Parse value: booleans, numbers, or string
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);
    else if (/^\d+\.\d+$/.test(value)) parsed = parseFloat(value);

    // Set nested path
    const keys = path.split(".");
    let obj: Record<string, unknown> = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in obj) || typeof obj[keys[i]] !== "object") {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]] as Record<string, unknown>;
    }
    obj[keys[keys.length - 1]] = parsed;

    writeFile(configPath, JSON.stringify(config, null, 2));
    console.log(`Set ${path} = ${JSON.stringify(parsed)}`);
  });

configCmd
  .command("edit")
  .description("Open config in $EDITOR")
  .action(async () => {
    const configPath = join(MAXOS_HOME, "maxos.json");
    if (!existsSync(configPath)) {
      console.log("No config file found. Run 'maxos init' first.");
      return;
    }
    const editor = process.env.EDITOR || "nano";
    const { execSync } = await import("node:child_process");
    try {
      execSync(`${editor} "${configPath}"`, { stdio: "inherit" });
    } catch (err) {
      console.error("Editor exited with error:", err instanceof Error ? err.message : err);
    }
  });

program.parse();
