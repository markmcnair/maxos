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

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");

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
    logger.info("gateway:starting", { home: MAXOS_HOME });
    this.state.load();

    // Detect non-clean shutdown from crash journal
    const lastShutdown = this.state.getLastJournalEvent();
    const wasClean = lastShutdown?.event === "daemon_stop";
    this.state.journalAppend("daemon_start", { recovery: wasClean ? "clean" : "crash" });

    this.sessions.loadFromState(this.state.current.sessions);
    this.scheduler.loadState(this.state.current.scheduler);

    process.on("SIGTERM", () => void this.shutdown());
    process.on("SIGINT", () => void this.shutdown());

    await this.startChannels();

    // Notify user if last shutdown was a crash
    if (!wasClean && lastShutdown) {
      const crashTime = new Date(lastShutdown.ts).toLocaleTimeString();
      await this.alertUser(`Restarted after a crash (last clean event: ${lastShutdown.event} at ${crashTime}). All systems back online.`).catch(() => {});
    }

    if (this.config.scheduler.enabled) {
      this.startScheduler();
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
    logger.info("gateway:scheduler_loaded", { taskCount: tasks.length });
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
    session.removeAllListeners("text");
    session.on("text", earlyTextHandler);

    const prompt = await this.buildPrompt(msg);
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
    logger.info("gateway:oneshot", { task: taskName });
    return oneShot({
      prompt,
      cwd: join(MAXOS_HOME, "workspace"),
      model: this.config.engine.model,
      outputFormat: "text",
      timeout: timeout ?? this.config.engine.maxOneShotTimeout,
      permissionMode: this.config.engine.permissionMode,
      allowedTools: this.config.engine.allowedTools,
    });
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
          await channel.send(`dm:${userId}`, { text: result, format: "html" });
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

      // Truncate result to first ~500 chars for the journal (full output went to Telegram)
      const summary = result.length > 500
        ? result.slice(0, 500).trimEnd() + "..."
        : result;

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
    for (const channel of this.channels) {
      if (channel.isHealthy()) {
        const routing = this.config.sessions.routing.find((r) => r.default);
        if (routing) {
          try {
            await channel.send(`dm:${this.config.channels.telegram?.allowedUsers[0] ?? "unknown"}`, {
              text: message,
              format: "text",
            });
            return;
          } catch {
            // Try next channel
          }
        }
      }
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
