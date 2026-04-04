import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionState {
  claudeSessionId: string;
  lastActivity: number;
  messageCount: number;
}

export interface PendingOneShot {
  id: string;
  fireAt: number;    // Unix timestamp (ms)
  prompt: string;
  silent: boolean;
  createdAt: number;
}

export interface DaemonState {
  version: number;
  timestamp: number;
  sessions: Record<string, SessionState>;
  scheduler: {
    failures: Record<string, number>;
    disabled: string[];
    lastRun: Record<string, number>;
  };
  pendingOneShots: PendingOneShot[];
  channels: Record<string, { healthy: boolean; lastMessage: number }>;
}

function emptyState(): DaemonState {
  return {
    version: 1,
    timestamp: Date.now(),
    sessions: {},
    scheduler: { failures: {}, disabled: [], lastRun: {} },
    pendingOneShots: [],
    channels: {},
  };
}

export class StateStore {
  private state: DaemonState;
  private readonly statePath: string;
  private readonly journalPath: string;

  constructor(private readonly baseDir: string) {
    this.statePath = join(baseDir, "state.json");
    this.journalPath = join(baseDir, "crash.log");
    this.state = emptyState();
  }

  load(): DaemonState {
    if (existsSync(this.statePath)) {
      try {
        this.state = JSON.parse(readFileSync(this.statePath, "utf-8"));
      } catch {
        this.state = emptyState();
      }
    } else {
      this.state = emptyState();
    }
    return this.state;
  }

  get current(): DaemonState {
    return this.state;
  }

  update(fn: (state: DaemonState) => void): void {
    fn(this.state);
    this.state.timestamp = Date.now();
  }

  flush(): void {
    mkdirSync(this.baseDir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  journalAppend(event: string, data: Record<string, unknown>): void {
    mkdirSync(this.baseDir, { recursive: true });
    const entry = JSON.stringify({ ts: Date.now(), event, ...data });
    appendFileSync(this.journalPath, entry + "\n");
  }

  getLastJournalEvent(): { ts: number; event: string } | null {
    if (!existsSync(this.journalPath)) return null;
    const content = readFileSync(this.journalPath, "utf-8").trim();
    if (!content) return null;
    const lines = content.split("\n");
    const last = lines[lines.length - 1];
    try {
      return JSON.parse(last) as { ts: number; event: string };
    } catch {
      return null;
    }
  }

  journalTrim(maxEntries: number): void {
    if (!existsSync(this.journalPath)) return;
    const lines = readFileSync(this.journalPath, "utf-8").trim().split("\n");
    if (lines.length > maxEntries) {
      const trimmed = lines.slice(lines.length - maxEntries);
      writeFileSync(this.journalPath, trimmed.join("\n") + "\n");
    }
  }
}
