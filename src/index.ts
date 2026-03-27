#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("maxos")
  .description("Personal AI agent runtime powered by Claude Code")
  .version("0.1.0");

program
  .command("start")
  .description("Start the MaxOS daemon")
  .option("--foreground", "Run in foreground instead of as service")
  .action((opts) => {
    console.log("MaxOS daemon starting...", opts.foreground ? "(foreground)" : "");
  });

program
  .command("status")
  .description("Show daemon status")
  .action(() => {
    console.log("MaxOS status: not implemented yet");
  });

program.parse();
