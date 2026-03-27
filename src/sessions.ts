import { logger } from "./utils/logger.js";

interface RoutingRule {
  match?: Record<string, string>;
  default?: boolean;
  session: string;
}

interface RouteInput {
  channelName: string;
  conversationId: string;
  senderId: string;
}

interface SessionEntry {
  claudeSessionId: string;
  lastActivity: number;
  messageCount: number;
}

export class SessionManager {
  private sessions: Map<string, SessionEntry> = new Map();
  private identityMap: Map<string, string> = new Map();

  constructor(
    private readonly routing: RoutingRule[],
    identityLinks: Record<string, string[]>
  ) {
    // Build reverse lookup: "telegram:123" → "mark"
    for (const [name, ids] of Object.entries(identityLinks)) {
      for (const id of ids) {
        this.identityMap.set(id, name);
      }
    }
  }

  route(input: RouteInput): string {
    for (const rule of this.routing) {
      if (!rule.match) continue;
      if (this.matchesRule(input, rule.match)) {
        return rule.session;
      }
    }
    const defaultRule = this.routing.find((r) => r.default);
    return defaultRule?.session ?? "main";
  }

  private matchesRule(input: RouteInput, match: Record<string, string>): boolean {
    for (const [key, value] of Object.entries(match)) {
      if (key === "conversationId" && input.conversationId !== value) return false;
      if (key === "channel" && input.channelName !== value) return false;
      if (key === "type") {
        const type = input.conversationId.startsWith("dm:") ? "dm" : "group";
        if (type !== value) return false;
      }
    }
    return true;
  }

  resolveIdentity(channel: string, senderId: string): string {
    const key = `${channel}:${senderId}`;
    return this.identityMap.get(key) ?? key;
  }

  register(sessionName: string, claudeSessionId: string): void {
    this.sessions.set(sessionName, {
      claudeSessionId,
      lastActivity: Date.now(),
      messageCount: 0,
    });
    logger.info("sessions:register", { sessionName, claudeSessionId });
  }

  recordActivity(sessionName: string): void {
    const entry = this.sessions.get(sessionName);
    if (entry) {
      entry.lastActivity = Date.now();
      entry.messageCount++;
    }
  }

  getClaudeSessionId(sessionName: string): string | undefined {
    return this.sessions.get(sessionName)?.claudeSessionId;
  }

  getAll(): Record<string, SessionEntry> {
    return Object.fromEntries(this.sessions);
  }

  clear(sessionName: string): void {
    this.sessions.delete(sessionName);
  }

  clearAll(): void {
    this.sessions.clear();
  }

  loadFromState(sessions: Record<string, SessionEntry>): void {
    for (const [name, entry] of Object.entries(sessions)) {
      this.sessions.set(name, entry);
    }
  }
}
