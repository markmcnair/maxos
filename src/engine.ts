import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { logger } from "./utils/logger.js";

const execFileAsync = promisify(execFile);

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/Users/Max/.local/bin/claude";

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
  watchdogTimeout: number;
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

export async function oneShot(opts: OneShotOptions): Promise<string> {
  const args = buildOneShotArgs(opts);
  logger.info("engine:oneShot", { prompt: opts.prompt.slice(0, 100) });

  try {
    const { stdout } = await execFileAsync(CLAUDE_PATH, args, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, TERM: "dumb" },
    });
    return stdout.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("engine:oneShot:error", { error: msg });
    throw err;
  }
}

/**
 * Interactive session using claude --print with stream-json.
 * Each send() spawns a new claude process with --resume to maintain conversation.
 * Emits "data" with assistant text, "done" when complete, "exit" on process end.
 */
export class InteractiveSession extends EventEmitter {
  private currentProcess: ChildProcess | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private _alive = false;
  private sessionId: string | null = null;
  private busy = false;
  private messageQueue: string[] = [];

  constructor(
    private readonly opts: InteractiveOptions & { cwd: string }
  ) {
    super();
  }

  get alive(): boolean {
    return this._alive;
  }

  start(): void {
    logger.info("engine:interactive:start", { session: this.opts.sessionName });
    this._alive = true;
  }

  send(message: string): void {
    if (!this._alive) {
      throw new Error("Session not alive");
    }

    if (this.busy) {
      this.messageQueue.push(message);
      logger.info("engine:interactive:queued", { session: this.opts.sessionName, queueSize: this.messageQueue.length });
      return;
    }

    this.processMessage(message);
  }

  private processMessage(message: string): void {
    this.busy = true;
    logger.info("engine:interactive:send", { session: this.opts.sessionName, length: message.length });

    const args = [
      "-p", message,
      "--model", this.opts.model,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", this.opts.permissionMode,
      "--allowed-tools", this.opts.allowedTools.join(","),
    ];

    // Resume existing session to maintain conversation history
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    } else {
      args.push("-n", this.opts.sessionName);
    }

    this.currentProcess = spawn(CLAUDE_PATH, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.resetWatchdog();

    let buffer = "";
    let responseText = "";

    this.currentProcess.stdout!.on("data", (chunk: Buffer) => {
      this.resetWatchdog();
      buffer += chunk.toString();

      // Parse newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          this.handleStreamEvent(event, (text) => {
            responseText += text;
          });
        } catch {
          // Partial JSON, skip
        }
      }
    });

    this.currentProcess.stderr!.on("data", (chunk: Buffer) => {
      logger.warn("engine:interactive:stderr", { session: this.opts.sessionName, data: chunk.toString().slice(0, 200) });
    });

    this.currentProcess.on("close", (code) => {
      this.clearWatchdog();
      this.busy = false;

      if (responseText.trim()) {
        this.emit("data", responseText);
        this.emit("done");
      }

      logger.info("engine:interactive:process_exit", { session: this.opts.sessionName, code });

      // Process queued messages
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift()!;
        this.processMessage(next);
      }
    });

    this.currentProcess.on("error", (err) => {
      this.clearWatchdog();
      this.busy = false;
      logger.error("engine:interactive:error", { session: this.opts.sessionName, error: err.message });
      this.emit("exit", 1);
    });
  }

  private handleStreamEvent(event: Record<string, unknown>, collectText: (text: string) => void): void {
    const type = event.type as string;

    // Capture session ID from the first message
    if (type === "system" && event.session_id) {
      this.sessionId = event.session_id as string;
      logger.info("engine:interactive:session_id", { session: this.opts.sessionName, id: this.sessionId });
    }

    // Collect assistant text
    if (type === "assistant" && event.message) {
      const msg = event.message as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>>;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            collectText(block.text);
          }
        }
      }
    }

    // Content block deltas (streaming text)
    if (type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        collectText(delta.text);
      }
    }
  }

  kill(): void {
    this.clearWatchdog();
    this._alive = false;
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
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
