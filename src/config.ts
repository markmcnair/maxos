import { readFileSync, existsSync } from "node:fs";
import JSON5 from "json5";

export interface MaxOSConfig {
  identity: {
    name: string;
    emoji: string;
    timezone: string;
  };
  engine: {
    model: string;
    permissionMode: string;
    allowedTools: string[];
    maxOneShotTimeout: number;
    watchdogTimeout: number;
    responseTimeout: number;
  };
  channels: {
    telegram?: {
      enabled: boolean;
      botToken: string;
      allowedUsers: string[];
      dmPolicy: string;
      forumTopics: boolean;
    };
  };
  sessions: {
    routing: Array<{
      match?: Record<string, string>;
      default?: boolean;
      session: string;
    }>;
    reset: { daily: string };
    identityLinks: Record<string, string[]>;
  };
  scheduler: {
    enabled: boolean;
    heartbeatFile: string;
    maxConcurrentTasks: number;
    circuitBreakerThreshold: number;
    protectedWindows: Array<{
      name: string;
      day?: string;
      start?: string;
      end?: string;
    }>;
  };
  reliability: {
    stateSnapshotInterval: number;
    crashJournalMaxEntries: number;
    healthCheckPort: number;
    autoRestart: boolean;
  };
}

export const DEFAULT_CONFIG: MaxOSConfig = {
  identity: { name: "Max", emoji: "\u{1F916}", timezone: "America/Chicago" },
  engine: {
    model: "sonnet",
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebSearch", "WebFetch", "Agent", "mcp__*"],
    maxOneShotTimeout: 300_000,
    watchdogTimeout: 300_000,
    responseTimeout: 300_000,
  },
  channels: {},
  sessions: {
    routing: [{ default: true, session: "main" }],
    reset: { daily: "04:00" },
    identityLinks: {},
  },
  scheduler: {
    enabled: true,
    heartbeatFile: "workspace/HEARTBEAT.md",
    maxConcurrentTasks: 1,
    circuitBreakerThreshold: 3,
    protectedWindows: [],
  },
  reliability: {
    stateSnapshotInterval: 30_000,
    crashJournalMaxEntries: 100,
    healthCheckPort: 18790,
    autoRestart: true,
  },
};

export function resolveEnvVars(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] ?? "");
}

function deepResolveEnv(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(deepResolveEnv);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepResolveEnv(v);
    }
    return result;
  }
  return obj;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object" &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(configPath: string): MaxOSConfig {
  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON5.parse(raw);
  const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed);
  return deepResolveEnv(merged) as MaxOSConfig;
}
