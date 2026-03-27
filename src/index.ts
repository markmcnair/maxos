#!/usr/bin/env node

import { Command } from "commander";
import { Gateway } from "./gateway.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");
const program = new Command();

program
  .name("maxos")
  .description("Personal AI agent runtime powered by Claude Code")
  .version("0.1.0");

program
  .command("start")
  .description("Start the MaxOS daemon")
  .option("--foreground", "Run in foreground")
  .action(async (opts) => {
    const gateway = new Gateway(opts.foreground ?? false);
    await gateway.start();
  });

program
  .command("status")
  .description("Show daemon status")
  .action(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:18790/health`);
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
      const statePath = join(MAXOS_HOME, "state.json");
      if (existsSync(statePath)) {
        console.log("Sending stop signal...");
      }
    } catch (err) {
      console.error("Failed to stop:", err);
    }
  });

program
  .command("logs")
  .description("Tail daemon logs")
  .option("--crash", "Show crash journal instead")
  .action((opts) => {
    const file = opts.crash ? join(MAXOS_HOME, "crash.log") : join(MAXOS_HOME, "daemon.log");
    if (existsSync(file)) {
      console.log(readFileSync(file, "utf-8"));
    } else {
      console.log("No logs found.");
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
  .description("Interactive onboarding wizard")
  .action(async () => {
    const { runOnboard } = await import("../scripts/onboard.js");
    await runOnboard();
  });

program.parse();
