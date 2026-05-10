import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, mkdirSync, appendFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, type MaxOSConfig } from "./config.js";
import { StateStore } from "./state.js";
import { InteractiveSession, oneShot } from "./engine.js";
import { SessionManager } from "./sessions.js";
import { Scheduler, parseHeartbeat } from "./scheduler.js";
import { TelegramAdapter } from "./channels/telegram.js";
import type { ChannelAdapter, InboundMessage } from "./channels/adapter.js";
import { logger, enableConsoleLogging } from "./utils/logger.js";
import { transcribeAudio } from "./utils/transcribe.js";
import { consumeRestartMarker } from "./restart-marker.js";
import { buildMemoryContext } from "./memory.js";
import { buildSystemFacts, formatSystemFacts } from "./system-facts.js";
import {
  loadDroppedTopics,
  loadDroppedLoopIds,
  stripDroppedFromOutput,
  pruneOpenLoopsAgainstDropped,
} from "./dropped-loops-filter.js";
import { loadOpenLoops, saveOpenLoops } from "./loop-reconciler.js";
import { fetchAuthoritativeGhosted, stripInvalidGhosted } from "./ghosted-filter.js";
import { classifyTaskKit } from "./memory.js";
import {
  detectMissedRuns,
  filterRecentFireFalsePositives,
  formatMissedAlert,
  type TaskLastRunInfo,
} from "./missed-cron.js";
import { buildReplyContext } from "./reply-context.js";
import { buildChatContext } from "./chat-context.js";
import { buildHealthSummary, buildHealthDetail } from "./health-summary.js";
import { summarizeViolations, formatSummary as formatVoiceSummary } from "./voice-violations-summary.js";
import {
  schemaForTask,
  validateAgainstSchema,
  logSchemaViolation,
  isSchemaFailure,
} from "./brief-schema.js";
import { shouldAttemptRecovery, recoverFromVault } from "./brief-recovery.js";
import { buildDigestMessage } from "./maxos-digest.js";
import { runAllChecks as runDoctorChecks } from "./doctor.js";

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");
const OUTBOUND_IDS_PATH = join(MAXOS_HOME, "workspace", "memory", "outbound-ids.jsonl");

/**
 * Strip early-delivered ack text from the final response to avoid duplication.
 * Uses content-based matching instead of offset-based slicing — the "result"
 * event from Claude CLI may contain only the last assistant turn (not all
 * intermediate turns), so blind offset slicing truncates the response.
 *
 * If the response starts with the early text, strip it. Otherwise, deliver
 * the full response — duplication is always preferable to truncation.
 */
export function stripEarlyDelivered(response: string, earlyText: string): string {
  if (!earlyText) return response;
  if (response.startsWith(earlyText)) {
    return response.slice(earlyText.length).trim();
  }
  // Response doesn't start with the early text — different content (e.g.,
  // result event has only the final turn). Deliver everything.
  return response;
}

/**
 * Poll the given channels until at least one is healthy or the timeout elapses.
 * Returns the first healthy channel, or null on timeout.
 *
 * Rationale: Telegram's `bot.start()` is fire-and-forget (see telegram.ts), so
 * `connect()` resolves before the polling loop is actually up. Any `alertUser`
 * call that fires immediately after startup would silently drop because no
 * channel reported healthy yet.
 */
/**
 * Truncate a scheduled task's output for inclusion in the daily markdown journal.
 *
 * Cuts at the next newline at or after `maxChars` (falling back to a raw cut if
 * no newline exists after that point). The newline-snap matters: a mid-row cut
 * inside a markdown table produces an invalid row that breaks the Notion sync
 * with "Number of cells in table row must match the table width of the parent
 * table" errors.
 */
export function summarizeForJournal(result: string, maxChars: number): string {
  if (result.length <= maxChars) return result;
  const cutIdx = result.indexOf("\n", maxChars);
  const cutAt = cutIdx > 0 ? cutIdx : maxChars;
  return result.slice(0, cutAt).trimEnd() + "\n\n…(truncated, full output sent to Telegram)";
}

export async function waitForHealthyChannel(
  channels: ChannelAdapter[],
  timeoutMs: number,
): Promise<ChannelAdapter | null> {
  const POLL_INTERVAL_MS = 50;
  const deadline = Date.now() + timeoutMs;
  // Check once up-front so already-healthy channels return immediately.
  do {
    for (const ch of channels) {
      if (ch.isHealthy()) return ch;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  // Final check after the last sleep.
  for (const ch of channels) {
    if (ch.isHealthy()) return ch;
  }
  return null;
}

export class Gateway {
  private config: MaxOSConfig;
  private state: StateStore;
  private sessions: SessionManager;
  private scheduler: Scheduler;
  private channels: ChannelAdapter[] = [];
  private interactiveSessions: Map<string, InteractiveSession> = new Map();
  private healthServer: Server | null = null;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private resetCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastResetDate: string | null = null;
  private shuttingDown = false;
  private heartbeatPath: string = "";
  /** Current parsed HEARTBEAT tasks — used by missed-cron detection. */
  private currentTasks: import("./scheduler.js").HeartbeatTask[] = [];
  /** Daemon start time (ms since epoch) — used by /status command for uptime. */
  private daemonStartTime: number = Date.now();

  constructor(private readonly foreground: boolean) {
    if (foreground) enableConsoleLogging();

    const configPath = join(MAXOS_HOME, "maxos.json");
    this.config = loadConfig(configPath);
    this.state = new StateStore(MAXOS_HOME);
    this.sessions = new SessionManager(
      this.config.sessions.routing,
      this.config.sessions.identityLinks,
    );
    this.scheduler = new Scheduler(
      this.config.scheduler.maxConcurrentTasks,
      this.config.scheduler.circuitBreakerThreshold,
      this.config.scheduler.protectedWindows,
      (prompt, taskName, timeout) => this.runOneShot(prompt, taskName, timeout),
      (result, taskName) => this.deliverTaskResult(result, taskName),
      (msg) => this.alertUser(msg),
    );
  }

  async start(): Promise<void> {
    this.daemonStartTime = Date.now();
    logger.info("gateway:starting", { home: MAXOS_HOME });
    this.state.load();

    // Prune open-loops.json against dropped-loops.md on startup. Keeps the
    // structured loop store consistent with Mark's explicit retirements so
    // Loop Reconciliation never surfaces a retired item.
    try {
      const dropped = loadDroppedTopics(MAXOS_HOME);
      const droppedIds = loadDroppedLoopIds(MAXOS_HOME);
      if (dropped.length > 0 || droppedIds.length > 0) {
        const loops = loadOpenLoops(MAXOS_HOME);
        const { remaining, pruned } = pruneOpenLoopsAgainstDropped(loops, dropped, droppedIds);
        if (pruned.length > 0) {
          saveOpenLoops(MAXOS_HOME, remaining);
          logger.info("gateway:pruned_dropped_loops", {
            pruned: pruned.map((p) => p.id),
            remainingCount: remaining.length,
          });
        }
      }
    } catch (err) {
      logger.warn("gateway:prune_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Write deterministic system facts to disk so the interactive session's
    // @SYSTEM_FACTS.md import always reflects current runtime (model, paths,
    // start time). Stops the agent from asserting facts about itself from
    // training-data priors.
    try {
      const facts = buildSystemFacts({ maxosHome: MAXOS_HOME });
      const factsPath = join(MAXOS_HOME, "workspace", "SYSTEM_FACTS.md");
      const factsMd = formatSystemFacts(facts);
      // require fs.writeFileSync at top of file; use appendFileSync exists
      const { writeFileSync: writeF, mkdirSync: mkd } = await import("node:fs");
      mkd(join(MAXOS_HOME, "workspace"), { recursive: true });
      writeF(factsPath, factsMd);
    } catch (err) {
      logger.warn("gateway:system_facts_write_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Detect non-clean shutdown from crash journal
    const lastShutdown = this.state.getLastJournalEvent();
    const wasClean = lastShutdown?.event === "daemon_stop";
    this.state.journalAppend("daemon_start", { recovery: wasClean ? "clean" : "crash" });

    this.sessions.loadFromState(this.state.current.sessions);
    this.scheduler.loadState(this.state.current.scheduler);

    process.on("SIGTERM", () => void this.shutdown());
    process.on("SIGINT", () => void this.shutdown());

    await this.startChannels();

    // User-requested restart (via `maxos restart`) takes precedence over the
    // crash-detection path: if the user asked for the restart, confirm it's
    // done rather than reporting a "crash" just because shutdown couldn't drain.
    const restartMarker = consumeRestartMarker(MAXOS_HOME);
    if (restartMarker) {
      await this.alertUser("Restart complete. I'm back online.").catch(() => {});
    } else if (!wasClean && lastShutdown) {
      const crashTime = new Date(lastShutdown.ts).toLocaleTimeString();
      await this.alertUser(`Restarted after a crash (last clean event: ${lastShutdown.event} at ${crashTime}). All systems back online.`).catch(() => {});
    }

    if (this.config.scheduler.enabled) {
      this.startScheduler();
      // Detect scheduled tasks that were supposed to fire while the daemon was
      // down. Alert the user so they know something was skipped and can run it
      // manually via `maxos run-task`. Window: 6 hours — covers a typical
      // overnight / extended crash; longer windows get noisy for non-critical
      // silent tasks.
      await this.checkForMissedRuns().catch((err) => {
        logger.warn("gateway:missed_cron_check_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Load and start one-shot timer loop
      this.scheduler.loadOneShots(this.state.current.pendingOneShots ?? []);
      this.scheduler.onOneShotChange((shots) => {
        this.state.update((s) => { s.pendingOneShots = shots; });
        this.state.flush();
      });
      this.scheduler.startOneShotLoop();
    }

    this.startDailyResetCheck();
    this.startHealthServer();

    this.snapshotInterval = setInterval(() => {
      this.saveState();
    }, this.config.reliability.stateSnapshotInterval);

    logger.info("gateway:started");
  }

  private async startChannels(): Promise<void> {
    if (this.config.channels.telegram?.enabled) {
      const telegram = new TelegramAdapter();
      telegram.onMessage((msg) => void this.handleMessage(msg));
      await telegram.connect(this.config.channels.telegram);
      this.channels.push(telegram);
    }
  }

  private startScheduler(): void {
    this.heartbeatPath = join(MAXOS_HOME, this.config.scheduler.heartbeatFile);
    if (!existsSync(this.heartbeatPath)) {
      logger.warn("gateway:no_heartbeat", { path: this.heartbeatPath });
      return;
    }
    this.reloadHeartbeat();

    // Watch for changes so edits to HEARTBEAT.md take effect without a restart
    watchFile(this.heartbeatPath, { interval: 5000 }, () => {
      logger.info("gateway:heartbeat_changed");
      this.reloadHeartbeat();
    });
  }

  private reloadHeartbeat(): void {
    if (!this.heartbeatPath || !existsSync(this.heartbeatPath)) return;
    const md = readFileSync(this.heartbeatPath, "utf-8");
    const tasks = parseHeartbeat(md);
    this.scheduler.schedule(tasks);
    this.currentTasks = tasks;
    logger.info("gateway:scheduler_loaded", { taskCount: tasks.length });

    // Prune scheduler state (failures, disabled, lastRun) of any keys that
    // don't correspond to a currently-registered task. Keeps state.json
    // clean across slug-truncation changes and removed heartbeat entries
    // — without this, /status surfaces orphan-slug failures/disables forever.
    const taskNames = new Set(tasks.map((t) => t.name));
    const pruned = this.scheduler.pruneStaleState(taskNames);
    const totalPruned =
      pruned.failuresPruned.length +
      pruned.disabledPruned.length +
      pruned.lastRunPruned.length;
    if (totalPruned > 0) {
      logger.info("gateway:pruned_stale_scheduler_state", {
        failures: pruned.failuresPruned.length,
        disabled: pruned.disabledPruned.length,
        lastRun: pruned.lastRunPruned.length,
      });
    }
  }

  /**
   * On startup, check whether any scheduled tasks were supposed to fire
   * while the daemon was down. If so, alert the user so they can run
   * them manually via `maxos run-task`. Silent tasks (closure-watcher,
   * journal checkpoints, etc.) are logged but not surfaced.
   */
  private async checkForMissedRuns(): Promise<void> {
    const tasks = this.currentTasks;
    if (!tasks || tasks.length === 0) return;
    const state = this.scheduler.getState();
    const infos: TaskLastRunInfo[] = tasks.map((t) => ({
      name: t.name,
      cron: t.cron,
      silent: t.silent ?? false,
      lastRun: state.lastRun[t.name],
    }));
    const rawMissed = detectMissedRuns(infos, new Date(), 6);
    // Filter out tasks whose expected fire was within 5 min of now — those
    // are likely mid-execution from before the daemon restart, and lastRun
    // hasn't propagated yet. Without this filter, restarting the daemon
    // during a scheduled fire produces a false-positive missed_task warning.
    const missed = filterRecentFireFalsePositives(rawMissed, new Date(), 5 * 60_000);
    const suppressed = rawMissed.length - missed.length;
    if (suppressed > 0) {
      logger.info("gateway:missed_cron_suppressed_recent", { count: suppressed });
    }
    if (missed.length === 0) {
      logger.info("gateway:missed_cron_check", { missed: 0 });
      return;
    }
    for (const m of missed) {
      logger.warn("gateway:missed_task", {
        task: m.taskName,
        scheduled: m.scheduledFireTime,
        ageMinutes: m.ageMinutes,
        silent: m.silent,
      });
    }
    const userFacing = missed.filter((m) => !m.silent);
    if (userFacing.length > 0) {
      const alert = formatMissedAlert(missed);
      await this.alertUser(alert).catch(() => {});
    }
  }

  private startDailyResetCheck(): void {
    const resetTime = this.config.sessions.reset.daily; // "HH:MM"
    if (!resetTime) return;

    // Check every 60 seconds if it's time to reset sessions
    this.resetCheckInterval = setInterval(() => {
      const now = new Date();
      const currentHHMM =
        String(now.getHours()).padStart(2, "0") + ":" +
        String(now.getMinutes()).padStart(2, "0");
      const todayDate = now.toISOString().slice(0, 10);

      if (currentHHMM === resetTime && this.lastResetDate !== todayDate) {
        this.lastResetDate = todayDate;
        logger.info("gateway:daily_reset", { time: resetTime });

        // Kill all interactive sessions
        for (const [name, session] of this.interactiveSessions) {
          logger.info("gateway:daily_reset:killing_session", { name });
          session.kill();
        }
        this.interactiveSessions.clear();

        // Clear session registry
        this.sessions.clearAll();

        logger.info("gateway:daily_reset:complete");
      }
    }, 60_000);
  }

  private startHealthServer(): void {
    this.healthServer = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          uptime: process.uptime(),
          channels: this.channels.map((c) => ({ name: c.name, healthy: c.isHealthy() })),
          sessions: Object.keys(this.sessions.getAll()),
          pendingOneShots: this.scheduler.getPendingOneShots().length,
        }));
      } else if (req.url === "/api/cron/list" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.scheduler.listTasks()));
      } else if (req.url === "/api/cron/enable" && req.method === "POST") {
        this.readBody(req).then((body) => {
          try {
            const { task } = JSON.parse(body);
            const enabled = this.scheduler.enableTask(task);
            if (enabled) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "Task not found or not disabled" }));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
          }
        });
      } else if (req.url === "/api/cron/disable" && req.method === "POST") {
        this.readBody(req).then((body) => {
          try {
            const { task } = JSON.parse(body);
            this.scheduler.disableTask(task);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
          }
        });
      } else if (req.url === "/api/cron/reload" && req.method === "POST") {
        this.reloadHeartbeat();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tasks: this.scheduler.listTasks() }));
      } else if (req.url === "/api/oneshot" && req.method === "POST") {
        this.readBody(req).then((body) => {
          try {
            const { fireAt, prompt, silent } = JSON.parse(body);
            if (!fireAt || !prompt) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "fireAt and prompt are required" }));
              return;
            }
            const id = this.scheduler.addOneShot(fireAt, prompt, silent ?? false);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, id, fireAt: new Date(fireAt).toISOString() }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
          }
        });
      } else if (req.url === "/api/deliver-task" && req.method === "POST") {
        // Used by `maxos run-task` so manually-rerun tasks still get
        // delivered to the user's channels via the normal pipeline.
        this.readBody(req).then(async (body) => {
          try {
            const { taskName, result } = JSON.parse(body);
            if (!taskName || typeof result !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "taskName and result are required" }));
              return;
            }
            await this.deliverTaskResult(result, taskName);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
        });
      } else if (req.url === "/api/oneshot/list" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.scheduler.getPendingOneShots()));
      } else if (req.url?.startsWith("/api/oneshot/") && req.method === "DELETE") {
        const id = req.url.split("/").pop();
        if (id && this.scheduler.removeOneShot(id)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "One-shot not found" }));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.healthServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.error("gateway:port_in_use", { port: this.config.reliability.healthCheckPort });
        console.error(`\n❌ Port ${this.config.reliability.healthCheckPort} is already in use. Another MaxOS daemon may be running.`);
        console.error(`   Run: kill $(lsof -ti :${this.config.reliability.healthCheckPort}) && maxos start`);
        process.exit(1);
      }
      throw err;
    });
    this.healthServer.listen(this.config.reliability.healthCheckPort, "127.0.0.1");
    logger.info("gateway:health_server", { port: this.config.reliability.healthCheckPort });
  }

  private readBody(req: import("node:http").IncomingMessage): Promise<string> {
    return new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => resolve(data));
    });
  }

  // Ack messages are handled by the LLM via telegram-behavior.md rules,
  // not hardcoded in the gateway. The LLM decides whether a message needs
  // an ack based on whether tool use is required. Conversational replies
  // ("BEAUTIFUL!", "thanks", etc.) get a direct response, not "Working on that now."

  /**
   * Build the prompt string from an inbound message.
   * If the message has attachments, prepend instructions for Claude
   * to read the downloaded files using its Read tool.
   * Voice/audio attachments are transcribed locally via Whisper first.
   */
  private async buildPrompt(msg: InboundMessage): Promise<string> {
    if (!msg.attachments || msg.attachments.length === 0) {
      return msg.text;
    }

    const parts: string[] = [];

    for (const att of msg.attachments) {
      switch (att.type) {
        case "image":
          parts.push(
            `[The user sent an image. It has been downloaded to: ${att.path}` +
            ` — Use your Read tool to view it. It's a real file on disk.]`
          );
          break;
        case "voice": {
          // Transcribe voice messages locally before passing to Claude
          const transcript = await transcribeAudio(att.path);
          if (transcript) {
            parts.push(
              `[The user sent a voice message. Transcription: "${transcript}"]`
            );
          } else {
            parts.push(
              `[The user sent a voice message but transcription failed. Audio file saved to: ${att.path}]`
            );
          }
          break;
        }
        case "audio": {
          // Transcribe audio files too
          const transcript = await transcribeAudio(att.path);
          if (transcript) {
            parts.push(
              `[The user sent an audio file: "${att.filename || "audio"}". Transcription: "${transcript}"]`
            );
          } else {
            parts.push(
              `[The user sent an audio file: "${att.filename || "audio"}". Transcription failed. File saved to: ${att.path}]`
            );
          }
          break;
        }
        case "document":
          parts.push(
            `[The user sent a file: "${att.filename || "document"}". Downloaded to: ${att.path}` +
            ` (${att.mimeType || "unknown type"}). Use your Read tool to read it.]`
          );
          break;
        case "video":
          parts.push(
            `[The user sent a video. Saved to: ${att.path}` +
            ` (${att.mimeType || "video/mp4"}). The file is on disk if needed.]`
          );
          break;
      }
    }

    // Combine attachment context with any caption/text
    if (msg.text) {
      parts.push(msg.text);
    }

    return parts.join("\n\n");
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    if (this.shuttingDown) return;

    const channel = this.channels.find((c) => c.name === msg.channelName);

    // /status — daemon-intercept, mobile-friendly health dashboard. Skip the
    // LLM round-trip entirely; just read state files and reply directly.
    // Subcommands:
    //   /status            — 5-line summary (default)
    //   /status detail     — full breakdown
    //   /status loops      — open loops list
    //   /status violations — voice violations 24h
    // /digest — on-demand version of the daily 21:25 digest. Same content,
    // any time. Single-line command, no subcommands.
    if (channel && /^\s*\/digest\s*$/i.test(msg.text ?? "")) {
      try {
        const doctorResults = await runDoctorChecks({ maxosHome: MAXOS_HOME, fast: true });
        const message = buildDigestMessage({
          maxosHome: MAXOS_HOME,
          now: new Date(),
          doctorResults,
        });
        await channel.send(msg.conversationId, { text: message, format: "text" });
      } catch (err) {
        logger.error("gateway:digest_failed", { error: err instanceof Error ? err.message : String(err) });
        await channel.send(msg.conversationId, {
          text: `/digest failed: ${err instanceof Error ? err.message : String(err)}`,
          format: "text",
        }).catch(() => {});
      }
      return;
    }

    const statusMatch = (msg.text ?? "").trim().match(/^\/status(?:\s+(\w+))?\s*$/i);
    if (channel && statusMatch) {
      const sub = (statusMatch[1] || "").toLowerCase();
      try {
        let reply: string;
        switch (sub) {
          case "":
          case "summary":
            reply = buildHealthSummary({ maxosHome: MAXOS_HOME, daemonStartTime: this.daemonStartTime });
            break;
          case "detail":
          case "full":
            reply = buildHealthDetail({ maxosHome: MAXOS_HOME, daemonStartTime: this.daemonStartTime });
            break;
          case "loops": {
            const loopsPath = join(MAXOS_HOME, "workspace", "memory", "open-loops.json");
            if (!existsSync(loopsPath)) {
              reply = "🔄 No open loops file. (treated as empty)";
            } else {
              const raw = readFileSync(loopsPath, "utf-8");
              try {
                const loops = JSON.parse(raw) as Array<{ id: string; topic: string; person?: string; firstSeen?: string; notes?: string }>;
                if (loops.length === 0) {
                  reply = "🔄 No open loops.";
                } else {
                  const lines = [`🔄 *Open loops* (${loops.length})`, ""];
                  for (const l of loops) {
                    const who = l.person ? ` — ${l.person}` : "";
                    const seen = l.firstSeen ? ` (since ${l.firstSeen})` : "";
                    lines.push(`• *${l.topic}*${who}${seen}`);
                    if (l.notes) lines.push(`  ${l.notes}`);
                  }
                  reply = lines.join("\n");
                }
              } catch {
                reply = "🔄 open-loops.json is corrupt — run /status detail";
              }
            }
            break;
          }
          case "violations": {
            const vPath = join(MAXOS_HOME, "workspace", "memory", "voice-violations.jsonl");
            if (!existsSync(vPath)) {
              reply = "Voice violations: no log yet (clean window).";
            } else {
              const since = Date.now() - 24 * 3600_000;
              const summary = summarizeViolations(readFileSync(vPath, "utf-8"), since);
              reply = formatVoiceSummary(summary);
            }
            break;
          }
          default:
            reply = `Unknown /status subcommand: \`${sub}\`.\nKnown: /status, /status detail, /status loops, /status violations`;
        }
        await channel.send(msg.conversationId, { text: reply, format: "text" });
      } catch (err) {
        logger.error("gateway:status_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        await channel.send(msg.conversationId, {
          text: `/status failed: ${err instanceof Error ? err.message : String(err)}`,
          format: "text",
        }).catch(() => {});
      }
      return;
    }

    const sessionName = this.sessions.route(msg);
    logger.info("gateway:message", { from: msg.senderId, session: sessionName });

    let session = this.interactiveSessions.get(sessionName);

    if (!session || !session.alive) {
      session = this.createInteractiveSession(sessionName);
      this.interactiveSessions.set(sessionName, session);
    }

    // Keep typing indicator alive while processing
    const typingInterval = channel?.sendTyping
      ? setInterval(() => { channel.sendTyping!(msg.conversationId).catch(() => {}); }, 4000)
      : null;

    // Track early-delivered text so we don't double-send it with the final response.
    // We store the actual text content — NOT just the length — because the final
    // "result" event from Claude CLI may contain only the last assistant turn,
    // not all intermediate text blocks. Offset-based slicing on mismatched text
    // causes truncation (e.g., slicing 100 chars off a different string).
    let earlyDeliveredText = "";
    let firstTextSent = false;

    const earlyTextHandler = async (text: string) => {
      // Send the FIRST assistant text block immediately as an ack.
      // Subsequent text blocks are part of the full response.
      if (!firstTextSent && text.trim() && channel) {
        firstTextSent = true;
        earlyDeliveredText = text;
        try {
          await channel.send(msg.conversationId, { text, format: "html" });
        } catch {
          earlyDeliveredText = ""; // Failed to send — deliver everything in final response
        }
      }
    };

    // Remove any stale text handlers from previous messages before registering.
    // Without this, concurrent messages on the same session stack handlers —
    // each handler has its own firstTextSent=false, so the same text event
    // triggers multiple sends, causing duplicate Telegram messages.
    //
    // KNOWN LIMITATION (ISSUE-009): this fixes duplicate-into-same-conversation
    // but NOT cross-conversation leak. If two conversations ever share a
    // session (multi-user setup, identity link), a handler registered for
    // conv A could receive the early-text events from a still-in-flight
    // send() that started for conv B, and the prefix would be sent to the
    // wrong conversation. Single-user setups (Mark today) cannot trigger
    // this because both would-be conversations resolve to the same
    // conversationId. Revisit if multi-user or shared sessions are added.
    session.removeAllListeners("text");
    session.on("text", earlyTextHandler);

    const userPrompt = await this.buildPrompt(msg);
    const replyContext = buildReplyContext(msg, OUTBOUND_IDS_PATH);
    const chatContext = buildChatContext(MAXOS_HOME);
    const prompt = [chatContext, replyContext, userPrompt].filter(Boolean).join("\n\n");
    const responseTimeout = this.config.engine.responseTimeout ?? 600_000;

    // send() returns a Promise that resolves when THIS message's response
    // is ready — no shared event listeners, no stacking, no cross-talk.
    const sendPromise = session.send(prompt);
    const timeoutPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("__TIMEOUT__"), responseTimeout)
    );

    const response = await Promise.race([sendPromise, timeoutPromise]);

    if (typingInterval) clearInterval(typingInterval);
    session.removeListener("text", earlyTextHandler);

    if (response === "__TIMEOUT__") {
      // Tell user we're still working
      if (channel) {
        await channel.send(msg.conversationId, { text: "Still working on this — I'll send the results when I'm done.", format: "text" }).catch(() => {});
      }
      // The sendPromise is still pending — when it resolves, deliver as follow-up
      sendPromise.then((lateResponse) => {
        if (lateResponse.trim() && channel) {
          const finalText = stripEarlyDelivered(lateResponse, earlyDeliveredText);
          if (finalText) {
            channel.send(msg.conversationId, { text: finalText, format: "html" }).catch(() => {});
          }
        }
      }).catch(() => {});
    } else if (response.trim() && channel) {
      // Strip already-delivered ack prefix from the final response
      const finalText = stripEarlyDelivered(response, earlyDeliveredText);
      if (finalText) {
        await channel.send(msg.conversationId, { text: finalText, format: "html" });
      }
    }

    this.sessions.recordActivity(sessionName);
  }

  private createInteractiveSession(name: string): InteractiveSession {
    const session = new InteractiveSession({
      sessionName: name,
      cwd: join(MAXOS_HOME, "workspace"),
      model: this.config.engine.model,
      permissionMode: this.config.engine.permissionMode,
      allowedTools: this.config.engine.allowedTools,
      watchdogTimeout: this.config.engine.watchdogTimeout,
    });

    // Persist session ID when the engine captures it from Claude CLI
    session.on("sessionId", (id: string) => {
      this.sessions.register(name, id);
      logger.info("gateway:session_registered", { session: name, claudeId: id });
    });

    session.on("watchdog", () => {
      logger.warn("gateway:watchdog", { session: name });
      this.state.journalAppend("watchdog_timeout", { session: name });
      this.interactiveSessions.delete(name);
      this.sessions.clear(name);
    });

    session.on("exit", (code: number) => {
      logger.info("gateway:session_exit", { session: name, code });
      this.interactiveSessions.delete(name);
    });

    session.start();
    this.state.journalAppend("session_created", { name });
    return session;
  }

  private async runOneShot(prompt: string, taskName: string, timeout?: number): Promise<string> {
    // Inject recent memory context before spawning the one-shot. Every task
    // starts a fresh Claude session, so without this, yesterday's "I handled
    // that" slips out of context and the debrief re-raises the same loop.
    // Passing taskName enables task-specific deterministic kits (calendar
    // brief for morning-brief/shutdown-debrief).
    const memoryContext = await buildMemoryContext(prompt, { taskName }).catch(() => "");
    const finalPrompt = memoryContext
      ? `${memoryContext}\n\n---\n\n${prompt}`
      : prompt;

    logger.info("gateway:oneshot", {
      task: taskName,
      memoryChars: memoryContext.length,
    });

    const rawResult = await oneShot({
      prompt: finalPrompt,
      cwd: join(MAXOS_HOME, "workspace"),
      model: this.config.engine.model,
      outputFormat: "text",
      timeout: timeout ?? this.config.engine.maxOneShotTimeout,
      permissionMode: this.config.engine.permissionMode,
      allowedTools: this.config.engine.allowedTools,
    });

    // Deterministic post-processing layer. Each filter is targeted at a
    // specific section of the output where the LLM has historically
    // ignored prompt directives. The filters can't prevent the LLM from
    // GENERATING bad content — they remove bad content before delivery.
    let filtered = rawResult;

    // Filter 1: dropped-loops enforcement (all tasks).
    const droppedTopics = loadDroppedTopics(MAXOS_HOME);
    if (droppedTopics.length > 0) {
      const afterDropped = stripDroppedFromOutput(filtered, droppedTopics);
      if (afterDropped !== filtered) {
        logger.info("gateway:oneshot:dropped_filter_applied", {
          task: taskName,
          droppedTopicsCount: droppedTopics.length,
          bytesRemoved: filtered.length - afterDropped.length,
        });
        filtered = afterDropped;
      }
    }

    // Filter 2: ghosted authority enforcement (brief + debrief only).
    // Fetch authoritative --ghosted list and strip any Ghosted-section
    // bullet that doesn't match. Catches false-carries like the Miguel
    // case where the LLM kept someone from yesterday's ghosted list
    // even though today's scan shows the thread is active.
    const kit = classifyTaskKit(taskName);
    if (kit === "morning-brief" || kit === "shutdown-debrief") {
      const authoritative = await fetchAuthoritativeGhosted({
        maxosHome: MAXOS_HOME,
        hours: kit === "morning-brief" ? 24 : 24,
      }).catch(() => []);
      const afterGhosted = stripInvalidGhosted(filtered, authoritative);
      if (afterGhosted !== filtered) {
        logger.info("gateway:oneshot:ghosted_filter_applied", {
          task: taskName,
          authoritativeCount: authoritative.length,
          bytesRemoved: filtered.length - afterGhosted.length,
        });
        filtered = afterGhosted;
      }
    }

    // Filter 3: schema validation (brief / debrief / brew only).
    // Doesn't strip content — just LOGS missing required sections so we can
    // detect when the LLM drops a section and silently delivers a malformed
    // brief. Mark sees the violation count via /status (future) or by reading
    // brief-issues.jsonl directly.
    //
    // Filter 4 (Round T, 2026-05-07): catastrophic-failure auto-recovery.
    // When the LLM produces a tiny / mostly-empty output (the 125-char
    // "Sync clean" garbage that ate Mark's debrief 2026-05-07), the schema
    // validator detects 3+ missing required sections OR <500 chars with
    // 1+ missing. We then read the long-form vault file the LLM saved
    // during Step 6, transform it to highlight-reel format, and REPLACE
    // the LLM's output with the recovered version. Logs both events.
    const schema = schemaForTask(taskName);
    if (schema) {
      const violation = validateAgainstSchema(filtered, schema, taskName);
      if (violation.missingRequired.length > 0 || violation.missingOptional.length > 0) {
        logSchemaViolation(
          join(MAXOS_HOME, "workspace", "memory", "brief-issues.jsonl"),
          violation,
        );
        if (isSchemaFailure(violation)) {
          logger.warn("gateway:oneshot:schema_failure", {
            task: taskName,
            missing: violation.missingRequired,
            chars: violation.totalChars,
          });
        }
      }
      if (shouldAttemptRecovery(violation)) {
        const recovery = recoverFromVault(MAXOS_HOME, taskName, new Date());
        if (recovery.recovered && recovery.content) {
          logger.warn("gateway:oneshot:recovery_applied", {
            task: taskName,
            originalChars: violation.totalChars,
            recoveredChars: recovery.content.length,
            vaultPath: recovery.vaultPath,
          });
          // Prepend a banner so Mark knows this is the recovered version.
          // Source label is "saved state" so it covers both the brief/debrief
          // vault file recovery and the brew archive-snapshot recovery.
          const banner = `⚠️ Recovered from saved state — original LLM output was malformed (${violation.totalChars} chars, missing ${violation.missingRequired.join(", ")})\n\n`;
          filtered = banner + recovery.content;
        } else {
          logger.warn("gateway:oneshot:recovery_failed", {
            task: taskName,
            reason: recovery.reason,
            vaultPath: recovery.vaultPath,
          });
        }
      }
    }

    return filtered;
  }

  private async deliverTaskResult(result: string, taskName: string): Promise<void> {
    logger.info("gateway:deliver_task", { task: taskName, length: result.length });

    // Write task output to daily journal so interactive sessions can see it.
    // Without this, one-shot tasks and interactive sessions are blind to each other.
    this.journalTaskResult(taskName, result);

    // Send scheduled task results to the primary user on the first healthy channel
    for (const channel of this.channels) {
      if (channel.isHealthy()) {
        const userId = this.config.channels.telegram?.allowedUsers[0];
        if (userId) {
          await channel.send(`dm:${userId}`, { text: result, format: "html", taskName });
          return;
        }
      }
    }
    logger.warn("gateway:deliver_task:no_channel", { task: taskName });
  }

  /**
   * Append a brief summary of a scheduled task's output to today's daily journal.
   * This bridges the gap between one-shot tasks and interactive sessions —
   * the interactive session reads the journal and knows what tasks reported.
   */
  private journalTaskResult(taskName: string, result: string): void {
    try {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      const memoryDir = join(MAXOS_HOME, "workspace", "memory");
      const journalPath = join(memoryDir, `${dateStr}.md`);

      const summary = summarizeForJournal(result, 2000);

      const entry = `\n\n### ${taskName} (${timeStr})\n${summary}\n`;

      if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
      appendFileSync(journalPath, entry);
      logger.info("gateway:journal_task", { task: taskName, journal: journalPath });
    } catch (err) {
      logger.error("gateway:journal_task:error", {
        task: taskName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async alertUser(message: string): Promise<void> {
    // Wait up to 15s for a channel to come online. startup path calls this
    // immediately after `startChannels()`, but Telegram's polling loop is
    // fire-and-forget — without this wait, startup alerts silently drop.
    const channel = await waitForHealthyChannel(this.channels, 15_000);
    if (!channel) {
      logger.warn("gateway:alert_user:no_healthy_channel");
      return;
    }
    const routing = this.config.sessions.routing.find((r) => r.default);
    if (!routing) return;
    try {
      await channel.send(`dm:${this.config.channels.telegram?.allowedUsers[0] ?? "unknown"}`, {
        text: message,
        format: "text",
      });
    } catch (err) {
      logger.warn("gateway:alert_user:send_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private saveState(): void {
    this.state.update((s) => {
      s.sessions = this.sessions.getAll();
      s.scheduler = this.scheduler.getState();
      s.channels = {};
      for (const ch of this.channels) {
        s.channels[ch.name] = { healthy: ch.isHealthy(), lastMessage: Date.now() };
      }
    });
    this.state.flush();
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info("gateway:shutting_down");

    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.resetCheckInterval) clearInterval(this.resetCheckInterval);
    if (this.healthServer) this.healthServer.close();

    this.scheduler.stopAll();
    if (this.heartbeatPath) unwatchFile(this.heartbeatPath);

    // Wait for in-flight work to complete (up to 30s)
    const drainStart = Date.now();
    const DRAIN_TIMEOUT = 30_000;
    while (Date.now() - drainStart < DRAIN_TIMEOUT) {
      const busySessions = [...this.interactiveSessions.values()].filter(s => s.isBusy);
      if (busySessions.length === 0) break;
      logger.info("gateway:draining", { busySessions: busySessions.length });
      await new Promise(r => setTimeout(r, 500));
    }

    // Kill remaining sessions
    for (const [name, session] of this.interactiveSessions) {
      logger.info("gateway:killing_session", { name });
      session.kill();
    }

    // Save state BEFORE disconnecting channels (so crash recovery has latest data)
    this.saveState();
    this.state.journalAppend("daemon_stop", { reason: "shutdown" });
    this.state.journalTrim(this.config.reliability.crashJournalMaxEntries);

    for (const channel of this.channels) {
      await channel.disconnect().catch(() => {});
    }

    logger.info("gateway:stopped");
    process.exit(0);
  }
}
