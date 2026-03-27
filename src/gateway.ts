import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
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

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");

export class Gateway {
  private config: MaxOSConfig;
  private state: StateStore;
  private sessions: SessionManager;
  private scheduler: Scheduler;
  private channels: ChannelAdapter[] = [];
  private interactiveSessions: Map<string, InteractiveSession> = new Map();
  private healthServer: Server | null = null;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

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
      (prompt, taskName) => this.runOneShot(prompt, taskName),
      (msg) => this.alertUser(msg),
    );
  }

  async start(): Promise<void> {
    logger.info("gateway:starting", { home: MAXOS_HOME });
    this.state.load();
    this.state.journalAppend("daemon_start", { recovery: "clean" });

    this.sessions.loadFromState(this.state.current.sessions);
    this.scheduler.loadState(this.state.current.scheduler);

    process.on("SIGTERM", () => void this.shutdown());
    process.on("SIGINT", () => void this.shutdown());

    await this.startChannels();

    if (this.config.scheduler.enabled) {
      this.startScheduler();
    }

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
    const heartbeatPath = join(MAXOS_HOME, this.config.scheduler.heartbeatFile);
    if (!existsSync(heartbeatPath)) {
      logger.warn("gateway:no_heartbeat", { path: heartbeatPath });
      return;
    }
    const md = readFileSync(heartbeatPath, "utf-8");
    const tasks = parseHeartbeat(md);
    this.scheduler.schedule(tasks);
    logger.info("gateway:scheduler_started", { taskCount: tasks.length });
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
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.healthServer.listen(this.config.reliability.healthCheckPort, "127.0.0.1");
    logger.info("gateway:health_server", { port: this.config.reliability.healthCheckPort });
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    if (this.shuttingDown) return;

    const sessionName = this.sessions.route(msg);
    logger.info("gateway:message", { from: msg.senderId, session: sessionName });

    let session = this.interactiveSessions.get(sessionName);

    if (!session || !session.alive) {
      session = this.createInteractiveSession(sessionName);
      this.interactiveSessions.set(sessionName, session);
    }

    let responseBuffer = "";
    const responsePromise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(responseBuffer || "(No response — session may be processing)");
      }, 120_000);

      const onData = (data: string) => {
        responseBuffer += data;
        if (this.looksLikePromptReady(responseBuffer)) {
          clearTimeout(timeout);
          session!.removeListener("data", onData);
          resolve(this.extractResponse(responseBuffer));
        }
      };
      session!.on("data", onData);
    });

    session.send(msg.text);
    const response = await responsePromise;

    if (response.trim()) {
      const channel = this.channels.find((c) => c.name === msg.channelName);
      if (channel) {
        await channel.send(msg.conversationId, { text: response, format: "html" });
      }
    }

    this.sessions.recordActivity(sessionName);
  }

  private createInteractiveSession(name: string): InteractiveSession {
    const existingId = this.sessions.getClaudeSessionId(name);
    const session = new InteractiveSession({
      sessionName: name,
      cwd: join(MAXOS_HOME, "workspace"),
      model: this.config.engine.model,
      permissionMode: this.config.engine.permissionMode,
      allowedTools: this.config.engine.allowedTools,
      resume: !!existingId,
      watchdogTimeout: this.config.engine.watchdogTimeout,
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
    this.state.journalAppend("session_created", { name, resume: !!existingId });
    return session;
  }

  private async runOneShot(prompt: string, taskName: string): Promise<string> {
    logger.info("gateway:oneshot", { task: taskName });
    return oneShot({
      prompt,
      cwd: join(MAXOS_HOME, "workspace"),
      model: this.config.engine.model,
      outputFormat: "text",
      timeout: this.config.engine.maxOneShotTimeout,
      permissionMode: this.config.engine.permissionMode,
      allowedTools: this.config.engine.allowedTools,
    });
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

  private looksLikePromptReady(buffer: string): boolean {
    const lines = buffer.split("\n");
    const lastLine = lines[lines.length - 1]?.trim() ?? "";
    return lastLine.endsWith("\u276F") || lastLine.endsWith(">") || lastLine.endsWith("$");
  }

  private extractResponse(buffer: string): string {
    const clean = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
    const lines = clean.split("\n");
    while (lines.length > 0 && (lines[lines.length - 1].trim().endsWith("\u276F") || lines[lines.length - 1].trim() === "")) {
      lines.pop();
    }
    return lines.join("\n").trim();
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
    if (this.healthServer) this.healthServer.close();

    this.scheduler.stopAll();

    for (const [name, session] of this.interactiveSessions) {
      logger.info("gateway:killing_session", { name });
      session.kill();
    }

    for (const channel of this.channels) {
      await channel.disconnect().catch(() => {});
    }

    this.saveState();
    this.state.journalAppend("daemon_stop", { reason: "shutdown" });
    this.state.journalTrim(this.config.reliability.crashJournalMaxEntries);

    logger.info("gateway:stopped");
    process.exit(0);
  }
}
