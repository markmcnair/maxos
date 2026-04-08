import { schedule, validate, type ScheduledTask } from "node-cron";
import { randomBytes } from "node:crypto";
import { logger } from "./utils/logger.js";
import type { PendingOneShot } from "./state.js";

export interface HeartbeatTask {
  name: string;
  cron: string;
  prompt: string;
  timeout?: number;
  /** If true, task runs but output is NOT delivered to user channels */
  silent?: boolean;
}

export interface ProtectedWindow {
  name: string;
  day?: string;
  start?: string;
  end?: string;
}

type TaskRunner = (prompt: string, taskName: string, timeout?: number) => Promise<string>;
type ResultDeliverer = (result: string, taskName: string) => Promise<void>;
type AlertSender = (message: string) => Promise<void>;

export function parseHeartbeat(markdown: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  const lines = markdown.split("\n");
  let currentCron: string | null = null;

  let isSilent = false;
  let customTimeout: number | undefined;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      let heading = headingMatch[1].trim();

      // Check for [silent] tag — task runs but output is not delivered to user
      isSilent = /\[silent\]/i.test(heading);
      heading = heading.replace(/\[silent\]/gi, "").trim();

      // Check for [timeout:Nm] tag — custom timeout in minutes
      const timeoutMatch = heading.match(/\[timeout:(\d+)m\]/i);
      customTimeout = timeoutMatch ? parseInt(timeoutMatch[1]) * 60_000 : undefined;
      heading = heading.replace(/\[timeout:\d+m\]/gi, "").trim();

      // "Every N minutes"
      const everyMinMatch = heading.match(/^Every\s+(\d+)\s+minutes?$/i);
      if (everyMinMatch) {
        currentCron = `*/${everyMinMatch[1]} * * * *`;
        continue;
      }

      // "Every N hours"
      const everyHourMatch = heading.match(/^Every\s+(\d+)\s+hours?$/i);
      if (everyHourMatch) {
        currentCron = `0 */${everyHourMatch[1]} * * *`;
        continue;
      }

      // Raw cron: "0 6 * * 0-5 (description)"
      const cronMatch = heading.match(
        /^([\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+)\s*(\(.*\))?$/,
      );
      if (cronMatch) {
        currentCron = cronMatch[1].trim();
        continue;
      }

      currentCron = null;
      continue;
    }

    // Bullet point under a heading with a cron
    const bulletMatch = line.match(/^-\s+(.+)/);
    if (bulletMatch && currentCron) {
      const prompt = bulletMatch[1].trim();
      const name = prompt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 50);
      tasks.push({ name, cron: currentCron, prompt, silent: isSilent, timeout: customTimeout });
    }
  }

  return tasks;
}

export function isInProtectedWindow(
  now: Date,
  windows: ProtectedWindow[],
): boolean {
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const currentDay = days[now.getDay()];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  for (const win of windows) {
    if (win.day && win.day.toLowerCase() !== currentDay) continue;

    if (win.start && win.end) {
      const startMin = parseTime(win.start);
      const endMin = parseTime(win.end);
      if (startMin > endMin) {
        // Overnight window (e.g., 22:00-06:00)
        if (currentMinutes >= startMin || currentMinutes < endMin) return true;
      } else {
        if (currentMinutes >= startMin && currentMinutes < endMin) return true;
      }
    } else if (win.start && !win.end) {
      // From start until end of day
      const startMin = parseTime(win.start);
      if (currentMinutes >= startMin) return true;
    } else if (win.day && !win.start) {
      // Whole day
      return true;
    }
  }
  return false;
}

function parseTime(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export class Scheduler {
  private jobs: Map<string, ScheduledTask> = new Map();
  private failures: Map<string, number> = new Map();
  private disabled: Set<string> = new Set();
  private lastRun: Map<string, number> = new Map();
  private taskCrons: Map<string, string> = new Map();
  private runningCount = 0;
  private pendingOneShots: PendingOneShot[] = [];
  private oneShotInterval: ReturnType<typeof setInterval> | null = null;
  private oneShotStateCallback: ((shots: PendingOneShot[]) => void) | null = null;

  constructor(
    private readonly maxConcurrent: number,
    private readonly circuitBreakerThreshold: number,
    private readonly protectedWindows: ProtectedWindow[],
    private readonly runner: TaskRunner,
    private readonly deliverer: ResultDeliverer,
    private readonly alerter: AlertSender,
  ) {}

  loadState(state: {
    failures: Record<string, number>;
    disabled: string[];
    lastRun: Record<string, number>;
  }): void {
    for (const [k, v] of Object.entries(state.failures))
      this.failures.set(k, v);
    for (const name of state.disabled) this.disabled.add(name);
    for (const [k, v] of Object.entries(state.lastRun))
      this.lastRun.set(k, v);
  }

  getState(): {
    failures: Record<string, number>;
    disabled: string[];
    lastRun: Record<string, number>;
  } {
    return {
      failures: Object.fromEntries(this.failures),
      disabled: [...this.disabled],
      lastRun: Object.fromEntries(this.lastRun),
    };
  }

  schedule(tasks: HeartbeatTask[]): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    this.taskCrons.clear();

    for (const task of tasks) {
      if (!validate(task.cron)) {
        logger.warn("scheduler:invalid_cron", {
          task: task.name,
          cron: task.cron,
        });
        continue;
      }

      const job = schedule(task.cron, () => {
        void this.executeTask(task);
      });
      this.jobs.set(task.name, job);
      this.taskCrons.set(task.name, task.cron);
      logger.info("scheduler:registered", {
        task: task.name,
        cron: task.cron,
      });
    }
  }

  private async executeTask(task: HeartbeatTask): Promise<void> {
    // Protected windows are NOT enforced here. Every scheduled task was set up
    // by the user — they chose the time, we honor it. Protected windows exist
    // as context for the LLM (don't proactively message during these hours),
    // not as a hard infrastructure block.

    if (this.disabled.has(task.name)) {
      return;
    }

    if (this.runningCount >= this.maxConcurrent) {
      logger.info("scheduler:skipped_concurrency", { task: task.name });
      return;
    }

    this.runningCount++;
    try {
      const result = await this.runner(task.prompt, task.name, task.timeout);
      this.failures.set(task.name, 0);
      this.lastRun.set(task.name, Date.now());

      if (result.trim() && !task.silent) {
        await this.deliverer(result, task.name).catch((err) => {
          logger.error("scheduler:deliver_failed", { task: task.name, error: err instanceof Error ? err.message : String(err) });
        });
      } else if (task.silent) {
        logger.info("scheduler:silent_complete", { task: task.name, resultLength: result.length });
      }
    } catch (err) {
      const count = (this.failures.get(task.name) ?? 0) + 1;
      this.failures.set(task.name, count);
      logger.error("scheduler:task_failed", {
        task: task.name,
        failures: count,
      });

      if (count >= this.circuitBreakerThreshold) {
        this.disabled.add(task.name);
        const msg = `Task "${task.name}" disabled after ${count} consecutive failures. Last error: ${err instanceof Error ? err.message : String(err)}`;
        logger.error("scheduler:circuit_breaker", { task: task.name });
        await this.alerter(msg).catch(() => {});
      }
    } finally {
      this.runningCount--;
    }
  }

  enableTask(name: string): boolean {
    if (this.disabled.has(name)) {
      this.disabled.delete(name);
      this.failures.set(name, 0);
      return true;
    }
    return false;
  }

  disableTask(name: string): void {
    this.disabled.add(name);
  }

  listTasks(): Array<{
    name: string;
    cron: string;
    disabled: boolean;
    failures: number;
    lastRun: number | null;
  }> {
    const result: Array<{
      name: string;
      cron: string;
      disabled: boolean;
      failures: number;
      lastRun: number | null;
    }> = [];
    for (const [name] of this.jobs) {
      result.push({
        name,
        cron: this.taskCrons.get(name) ?? "",
        disabled: this.disabled.has(name),
        failures: this.failures.get(name) ?? 0,
        lastRun: this.lastRun.get(name) ?? null,
      });
    }
    return result;
  }

  // --- One-shot scheduling ---

  /** Load pending one-shots from persisted state */
  loadOneShots(shots: PendingOneShot[]): void {
    this.pendingOneShots = [...shots];
  }

  /** Register a callback so the scheduler can persist state after one-shot changes */
  onOneShotChange(cb: (shots: PendingOneShot[]) => void): void {
    this.oneShotStateCallback = cb;
  }

  /** Schedule a one-time task at a specific time. Returns the generated ID. */
  addOneShot(fireAt: number, prompt: string, silent = false): string {
    const id = randomBytes(4).toString("hex");
    const shot: PendingOneShot = { id, fireAt, prompt, silent, createdAt: Date.now() };
    this.pendingOneShots.push(shot);
    logger.info("scheduler:oneshot_added", { id, fireAt: new Date(fireAt).toISOString() });
    this.oneShotStateCallback?.(this.pendingOneShots);
    return id;
  }

  /** Remove a pending one-shot by ID */
  removeOneShot(id: string): boolean {
    const idx = this.pendingOneShots.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.pendingOneShots.splice(idx, 1);
    this.oneShotStateCallback?.(this.pendingOneShots);
    return true;
  }

  /** Get all pending one-shots */
  getPendingOneShots(): PendingOneShot[] {
    return [...this.pendingOneShots];
  }

  /** Start the one-shot tick loop (checks every 30s) */
  startOneShotLoop(): void {
    if (this.oneShotInterval) return;
    this.oneShotInterval = setInterval(() => {
      void this.tickOneShots();
    }, 30_000);
    // Also run immediately in case something is already due
    void this.tickOneShots();
  }


  private async tickOneShots(): Promise<void> {
    const now = Date.now();
    const due = this.pendingOneShots.filter((s) => s.fireAt <= now);
    if (due.length === 0) return;

    for (const shot of due) {
      // One-shots ALWAYS fire — they are user-initiated with an explicit time.
      // Protected windows only apply to recurring cron tasks.

      if (this.runningCount >= this.maxConcurrent) {
        logger.info("scheduler:oneshot_skipped_concurrency", { id: shot.id });
        continue; // Will retry on next tick
      }

      // Remove from pending BEFORE executing (prevents double-fire)
      const idx = this.pendingOneShots.findIndex((s) => s.id === shot.id);
      if (idx !== -1) this.pendingOneShots.splice(idx, 1);
      this.oneShotStateCallback?.(this.pendingOneShots);

      logger.info("scheduler:oneshot_firing", { id: shot.id });
      this.runningCount++;
      try {
        const result = await this.runner(shot.prompt, `oneshot-${shot.id}`);
        if (result.trim() && !shot.silent) {
          await this.deliverer(result, `oneshot-${shot.id}`).catch((err) => {
            logger.error("scheduler:oneshot_deliver_failed", { id: shot.id, error: err instanceof Error ? err.message : String(err) });
          });
        }
        logger.info("scheduler:oneshot_complete", { id: shot.id });
      } catch (err) {
        logger.error("scheduler:oneshot_failed", { id: shot.id, error: err instanceof Error ? err.message : String(err) });
        await this.alerter(`One-time task failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      } finally {
        this.runningCount--;
      }
    }
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    if (this.oneShotInterval) {
      clearInterval(this.oneShotInterval);
      this.oneShotInterval = null;
    }
  }
}
