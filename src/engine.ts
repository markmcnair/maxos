import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "./utils/logger.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve the claude CLI path. Priority:
 * 1. CLAUDE_PATH env var (explicit override)
 * 2. claude in the same bin/ directory as the running node binary (nvm/homebrew)
 * 3. Bare "claude" (fall back to PATH lookup)
 */
function resolveClaudePath(): string {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  // Check sibling of the node binary (handles nvm, homebrew, etc.)
  const siblingPath = join(dirname(process.execPath), "claude");
  if (existsSync(siblingPath)) {
    logger.info("engine:claude_path", { resolved: siblingPath });
    return siblingPath;
  }

  return "claude";
}

const CLAUDE_PATH = resolveClaudePath();

/**
 * Build a rich PATH for Claude subprocess environments.
 * The daemon may not inherit interactive shell PATH (no .zshrc sourcing),
 * so we explicitly include common user binary locations.
 */
function buildEnginePath(): string {
  const home = process.env.HOME || "";
  const existing = process.env.PATH || "";
  const extras = [
    join(home, "bin"),                          // User scripts (gws-personal, gws-emprise)
    join(home, ".local", "bin"),                // pipx, user installs
    dirname(process.execPath),                  // nvm node bin dir (contains claude, npx, etc.)
    "/opt/homebrew/bin",                        // Homebrew on Apple Silicon
    "/usr/local/bin",                           // Homebrew on Intel / system installs
  ];
  // Prepend extras that aren't already in PATH
  const parts = existing.split(":");
  const toAdd = extras.filter(p => p && !parts.includes(p));
  return [...toAdd, ...parts].join(":");
}

const ENGINE_PATH = buildEnginePath();

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
      env: { ...process.env, TERM: "dumb", PATH: ENGINE_PATH },
    });
    return stdout.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("engine:oneShot:error", { error: msg });
    throw err;
  }
}

/** Queued message with its promise resolver */
interface QueuedMessage {
  message: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/**
 * Interactive session using claude --print with stream-json.
 * Each send() spawns a new claude process with --resume to maintain conversation.
 *
 * send() returns a Promise<string> that resolves when THIS message's response
 * is complete. No shared event listeners — each message gets its own promise.
 * The gateway just awaits the promise. No listener stacking, no race conditions.
 *
 * Still extends EventEmitter for lifecycle events (watchdog, exit) that the
 * gateway uses for session management — but NOT for response delivery.
 */
export class InteractiveSession extends EventEmitter {
  private currentProcess: ChildProcess | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private _alive = false;
  private sessionId: string | null = null;
  private busy = false;
  private queue: QueuedMessage[] = [];
  private currentResolve: ((text: string) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;

  constructor(
    private readonly opts: InteractiveOptions & { cwd: string }
  ) {
    super();
  }

  get alive(): boolean {
    return this._alive;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** The Claude CLI session ID, if captured. */
  get claudeSessionId(): string | null {
    return this.sessionId;
  }

  start(): void {
    logger.info("engine:interactive:start", { session: this.opts.sessionName });
    this._alive = true;
  }

  /**
   * Send a message and get the response. Returns a Promise that resolves
   * when THIS message's Claude process finishes — not when any other
   * message finishes. If the session is busy, the message is queued and
   * the promise resolves when it's this message's turn.
   */
  send(message: string): Promise<string> {
    if (!this._alive) {
      return Promise.reject(new Error("Session not alive"));
    }

    return new Promise<string>((resolve, reject) => {
      if (this.busy) {
        this.queue.push({ message, resolve, reject });
        logger.info("engine:interactive:queued", {
          session: this.opts.sessionName,
          queueSize: this.queue.length,
        });
        return;
      }

      this.currentResolve = resolve;
      this.currentReject = reject;
      this.processMessage(message);
    });
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
      env: { ...process.env, TERM: "dumb", PATH: ENGINE_PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.resetWatchdog();

    let buffer = "";
    let resultText = "";
    let assistantText = "";
    let gotResult = false;

    this.currentProcess.stdout!.on("data", (chunk: Buffer) => {
      this.resetWatchdog();
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          this.handleStreamEvent(event, (text, isResult) => {
            if (isResult) {
              resultText = text;
              gotResult = true;
            } else {
              assistantText += text;
            }
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
      this.currentProcess = null;

      const responseText = (gotResult ? resultText : assistantText).trim();
      logger.info("engine:interactive:process_exit", { session: this.opts.sessionName, code, responseLen: responseText.length });

      // Resolve THIS message's promise
      if (this.currentResolve) {
        this.currentResolve(responseText);
        this.currentResolve = null;
        this.currentReject = null;
      }

      // Process next queued message
      this.processNext();
    });

    this.currentProcess.on("error", (err) => {
      this.clearWatchdog();
      this.busy = false;
      this.currentProcess = null;
      logger.error("engine:interactive:error", { session: this.opts.sessionName, error: err.message });

      if (this.currentReject) {
        this.currentReject(err);
        this.currentResolve = null;
        this.currentReject = null;
      }

      this.emit("exit", 1);
    });
  }

  /** Shift the next queued message and process it. */
  private processNext(): void {
    if (this.queue.length === 0) return;

    const next = this.queue.shift()!;
    this.currentResolve = next.resolve;
    this.currentReject = next.reject;
    this.processMessage(next.message);
  }

  private handleStreamEvent(
    event: Record<string, unknown>,
    collectText: (text: string, isResult: boolean) => void,
  ): void {
    const type = event.type as string;

    // Capture session ID from system events
    if (type === "system" && event.session_id && !this.sessionId) {
      this.sessionId = event.session_id as string;
      logger.info("engine:interactive:session_id", { session: this.opts.sessionName, id: this.sessionId });
      this.emit("sessionId", this.sessionId);
    }

    // The "result" event is the final, authoritative response
    if (type === "result") {
      if (event.session_id && typeof event.session_id === "string") {
        if (this.sessionId !== event.session_id) {
          this.sessionId = event.session_id;
          this.emit("sessionId", this.sessionId);
        }
      }
      if (typeof event.result === "string" && event.result.trim()) {
        collectText(event.result, true);
      }
      return;
    }

    // Collect assistant text as fallback (in case result event is missing)
    if (type === "assistant" && event.message) {
      const msg = event.message as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>>;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            collectText(block.text, false);
          }
        }
      }
    }
  }

  kill(): void {
    this.clearWatchdog();
    this._alive = false;

    // Reject all pending promises
    if (this.currentReject) {
      this.currentReject(new Error("Session killed"));
      this.currentResolve = null;
      this.currentReject = null;
    }
    for (const queued of this.queue) {
      queued.reject(new Error("Session killed"));
    }
    this.queue = [];

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
