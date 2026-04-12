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
    "--allow-dangerously-skip-permissions",
    "--allowed-tools", opts.allowedTools.join(","),
  ];
}

export async function oneShot(opts: OneShotOptions): Promise<string> {
  const args = buildOneShotArgs(opts);
  logger.info("engine:oneShot", { prompt: opts.prompt.slice(0, 100) });

  return new Promise<string>((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, args, {
      cwd: opts.cwd,
      env: { ...process.env, TERM: "dumb", PATH: ENGINE_PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    // Graceful termination: SIGTERM first (allows bash cleanup traps to fire),
    // then SIGKILL after 10s grace period.
    const timer = setTimeout(() => {
      killed = true;
      logger.warn("engine:oneShot:timeout", { prompt: opts.prompt.slice(0, 50) });
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 10_000);
    }, opts.timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        const partial = stdout.trim();
        if (partial) {
          logger.info("engine:oneShot:partial", { length: partial.length });
          resolve(partial);
        } else {
          reject(new Error(`oneShot timed out after ${opts.timeout}ms`));
        }
      } else if (code !== 0) {
        reject(new Error(`oneShot exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
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
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private _alive = false;
  private sessionId: string | null = null;
  private busy = false;
  private queue: QueuedMessage[] = [];
  private currentResolve: ((text: string) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;
  private accumulatedText = "";

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
      "--allow-dangerously-skip-permissions",
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
    this.startProcessHeartbeat();

    let buffer = "";
    let resultText = "";
    this.accumulatedText = "";
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
              this.accumulatedText += text;
            }
          });
        } catch {
          // Partial JSON, skip
        }
      }
    });

    this.currentProcess.stderr!.on("data", (chunk: Buffer) => {
      this.resetWatchdog(); // stderr activity means process is alive (tool progress, MCP connections)
      logger.warn("engine:interactive:stderr", { session: this.opts.sessionName, data: chunk.toString().slice(0, 200) });
    });

    this.currentProcess.on("close", (code) => {
      this.clearWatchdog();
      this.stopProcessHeartbeat();
      this.busy = false;
      this.currentProcess = null;

      const responseText = (gotResult ? resultText : this.accumulatedText).trim();
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
      this.stopProcessHeartbeat();
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
            this.emit("text", block.text); // Stream text to gateway for early ack delivery
          }
        }
      }
    }
  }

  kill(): void {
    this.clearWatchdog();
    this.stopProcessHeartbeat();
    this._alive = false;

    // Deliver accumulated partial response instead of discarding it
    if (this.currentResolve) {
      const partial = this.accumulatedText.trim();
      if (partial) {
        logger.info("engine:interactive:partial_delivery", { session: this.opts.sessionName, length: partial.length });
        this.currentResolve(partial);
      } else {
        this.currentReject?.(new Error("Session killed"));
      }
      this.currentResolve = null;
      this.currentReject = null;
    }
    // Queued messages get rejected — no partial response exists for them
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

  /** Periodically check if the child process is still alive (covers silent tool execution). */
  private startProcessHeartbeat(): void {
    this.stopProcessHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.currentProcess?.pid) {
        try {
          process.kill(this.currentProcess.pid, 0); // signal 0 = existence check
          this.resetWatchdog();
        } catch {
          // Process dead — watchdog will handle cleanup
        }
      }
    }, 60_000);
  }

  private stopProcessHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}
