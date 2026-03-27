import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import { EventEmitter } from "node:events";
import { logger } from "./utils/logger.js";

const execFileAsync = promisify(execFile);

export interface OneShotOptions {
  prompt: string;
  cwd: string;
  model: string;
  outputFormat: string;
  timeout: number;
  permissionMode: string;
  allowedTools: string[];
}

export interface InteractiveOptions {
  sessionName: string;
  cwd: string;
  model: string;
  permissionMode: string;
  allowedTools: string[];
  resume: boolean;
}

export function buildOneShotArgs(opts: OneShotOptions): string[] {
  return [
    "-p", opts.prompt,
    "--model", opts.model,
    "--output-format", opts.outputFormat,
    "--permission-mode", opts.permissionMode,
    "--allowed-tools", opts.allowedTools.join(","),
  ];
}

export function buildInteractiveArgs(opts: InteractiveOptions): string[] {
  const args: string[] = [];
  if (opts.resume) {
    args.push("--resume", opts.sessionName);
  } else {
    args.push("-n", opts.sessionName);
  }
  args.push(
    "--model", opts.model,
    "--permission-mode", opts.permissionMode,
    "--allowed-tools", opts.allowedTools.join(","),
  );
  return args;
}

export async function oneShot(opts: OneShotOptions): Promise<string> {
  const args = buildOneShotArgs(opts);
  logger.info("engine:oneShot", { prompt: opts.prompt.slice(0, 100) });

  try {
    const { stdout } = await execFileAsync("claude", args, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, TERM: "dumb" },
    });
    return stdout.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("engine:oneShot:error", { error: msg });
    throw err;
  }
}

export class InteractiveSession extends EventEmitter {
  private process: pty.IPty | null = null;
  private buffer = "";
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private _alive = false;

  constructor(
    private readonly opts: InteractiveOptions & { watchdogTimeout: number; cwd: string }
  ) {
    super();
  }

  get alive(): boolean {
    return this._alive;
  }

  start(): void {
    const args = buildInteractiveArgs(this.opts);
    logger.info("engine:interactive:start", { session: this.opts.sessionName, resume: this.opts.resume });

    this.process = pty.spawn("claude", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: this.opts.cwd,
      env: { ...process.env } as Record<string, string>,
    });

    this._alive = true;
    this.resetWatchdog();

    this.process.onData((data: string) => {
      this.buffer += data;
      this.resetWatchdog();
      this.emit("data", data);
    });

    this.process.onExit(({ exitCode }) => {
      this._alive = false;
      this.clearWatchdog();
      logger.info("engine:interactive:exit", { session: this.opts.sessionName, exitCode });
      this.emit("exit", exitCode);
    });
  }

  send(message: string): void {
    if (!this.process || !this._alive) {
      throw new Error("Session not alive");
    }
    logger.info("engine:interactive:send", { session: this.opts.sessionName, length: message.length });
    this.process.write(message + "\n");
    this.resetWatchdog();
  }

  kill(): void {
    this.clearWatchdog();
    if (this.process) {
      this.process.kill();
      this._alive = false;
    }
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      logger.warn("engine:interactive:watchdog", { session: this.opts.sessionName });
      this.emit("watchdog");
      this.kill();
    }, this.opts.watchdogTimeout);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
