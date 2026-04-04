# Configuration

MaxOS loads its config from `~/.maxos/maxos.json` (JSON5 format). Missing fields fall back to defaults. Environment variables are substituted via `${VAR_NAME}` syntax anywhere in string values.

Secrets go in `~/.maxos/.env` (never committed). The daemon loads this file at startup.

## Full Schema with Defaults

```jsonc
{
  // --- Identity ---
  "identity": {
    "name": "Max",              // Agent's display name
    "emoji": "\ud83e\udd16",    // Agent's emoji (used in formatted output)
    "timezone": "America/Chicago" // IANA timezone for scheduler and timestamps
  },

  // --- Engine (Claude CLI) ---
  "engine": {
    "model": "sonnet",           // Claude model to use (sonnet, opus, haiku)
    "permissionMode": "bypassPermissions",  // Claude CLI permission mode for unattended operation
    "allowedTools": [            // Tools the Claude CLI session can use
      "Read", "Write", "Edit", "Bash", "Grep", "Glob",
      "WebSearch", "WebFetch", "Agent", "mcp__*"
    ],
    "maxOneShotTimeout": 300000, // Timeout (ms) for one-shot scheduled tasks (5 min)
    "watchdogTimeout": 300000,   // Kill interactive session if no output for this long (5 min)
    "responseTimeout": 300000    // Max time (ms) to wait for a response before giving up (5 min)
  },

  // --- Channels ---
  "channels": {
    "telegram": {
      "enabled": true,            // Enable/disable the Telegram adapter
      "botToken": "${TELEGRAM_BOT_TOKEN}",  // Bot token from @BotFather (use env var)
      "allowedUsers": [],         // Telegram user IDs allowed to interact (string[])
      "dmPolicy": "allowlist",    // "allowlist" = only allowedUsers can message; "open" = anyone
      "forumTopics": true         // Support Telegram forum topics as separate conversations
    }
  },

  // --- Sessions ---
  "sessions": {
    "routing": [                  // Routing rules evaluated in order; first match wins
      // { "match": { "conversationId": "topic:work" }, "session": "work" },
      // { "match": { "channel": "telegram", "type": "dm" }, "session": "main" },
      { "default": true, "session": "main" }
    ],
    "reset": {
      "daily": "04:00"           // Time (HH:MM) to reset all sessions daily
    },
    "identityLinks": {}          // Map identity name to channel-specific IDs
    // Example: { "alice": ["telegram:123456789", "discord:987654321"] }
  },

  // --- Scheduler ---
  "scheduler": {
    "enabled": true,             // Enable/disable the HEARTBEAT.md scheduler
    "heartbeatFile": "workspace/HEARTBEAT.md",  // Path relative to ~/.maxos/
    "maxConcurrentTasks": 1,     // Max simultaneous one-shot tasks
    "circuitBreakerThreshold": 3, // Consecutive failures before disabling a task
    "protectedWindows": []       // Time windows when tasks are skipped
    // Example:
    // [
    //   { "name": "sleep", "start": "22:00", "end": "06:00" },
    //   { "name": "family-time", "day": "sunday" },
    //   { "name": "focus-block", "day": "wednesday", "start": "14:00", "end": "17:00" }
    // ]
  },

  // --- Reliability ---
  "reliability": {
    "stateSnapshotInterval": 30000,   // How often to write state.json (ms)
    "crashJournalMaxEntries": 100,    // Max lines in crash.log before trimming
    "healthCheckPort": 18790,         // HTTP health check port (localhost only)
    "autoRestart": true               // Whether launchd/systemd should restart on crash
  }
}
```

## Section Reference

### identity

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | `"Max"` | Agent name. Used in SOUL.md generation and formatted output. |
| `emoji` | string | `"\ud83e\udd16"` | Agent emoji for display contexts. |
| `timezone` | string | `"America/Chicago"` | IANA timezone. Affects scheduler, protected windows, and daily reset timing. |

### engine

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `"sonnet"` | Claude model passed to `--model`. Options: `sonnet`, `opus`, `haiku`. |
| `permissionMode` | string | `"bypassPermissions"` | Passed to `--permission-mode`. Use `bypassPermissions` for unattended operation. |
| `allowedTools` | string[] | *(see above)* | Passed to `--allowed-tools`. Supports wildcards like `mcp__*`. |
| `maxOneShotTimeout` | number | `300000` | Timeout in ms for one-shot (scheduled task) executions. |
| `watchdogTimeout` | number | `300000` | Kill an interactive session if no stdout output for this many ms. |
| `responseTimeout` | number | `300000` | Max time in ms to wait for a complete response to a user message. |

### channels.telegram

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | *(not set)* | Set to `true` to activate the Telegram adapter. |
| `botToken` | string | *(required)* | Telegram bot token from @BotFather. Use `${TELEGRAM_BOT_TOKEN}` to pull from env. |
| `allowedUsers` | string[] | `[]` | Telegram user IDs (as strings) allowed to interact. Empty = no one (if `dmPolicy` is `allowlist`). |
| `dmPolicy` | string | `"allowlist"` | `"allowlist"` restricts to `allowedUsers`. `"open"` allows anyone. |
| `forumTopics` | boolean | `true` | Whether to treat Telegram forum topics as separate conversation IDs. |

### sessions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `routing` | array | `[{ default: true, session: "main" }]` | Routing rules. Each rule has an optional `match` object and a `session` name. See architecture docs for match keys. |
| `reset.daily` | string | `"04:00"` | Time (HH:MM) to clear all session IDs. Next message starts a fresh Claude session. |
| `identityLinks` | object | `{}` | Maps an identity name to an array of `"channel:userId"` strings so the same person on multiple channels shares one session. |

### scheduler

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable the HEARTBEAT.md parser and cron scheduler. |
| `heartbeatFile` | string | `"workspace/HEARTBEAT.md"` | Path to the heartbeat file, relative to `~/.maxos/`. |
| `maxConcurrentTasks` | number | `1` | Max simultaneous one-shot task executions. Additional tasks are skipped if at capacity. |
| `circuitBreakerThreshold` | number | `3` | Number of consecutive failures before a task is auto-disabled. |
| `protectedWindows` | array | `[]` | Time windows when all tasks are skipped. Each window has `name` (string), optional `day` (lowercase day name), optional `start` (HH:MM), optional `end` (HH:MM). |

**Protected window behavior:**
- `day` only (no `start`/`end`): entire day is protected
- `start` only (no `end`): protected from `start` until midnight
- `start` + `end`: protected during that range. Overnight windows (e.g. `22:00`-`06:00`) wrap correctly.

### reliability

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stateSnapshotInterval` | number | `30000` | How often (ms) to write `state.json` to disk. |
| `crashJournalMaxEntries` | number | `100` | Max entries in `crash.log`. Older entries are trimmed on shutdown. |
| `healthCheckPort` | number | `18790` | Port for the HTTP health check server (binds to `127.0.0.1` only). |
| `autoRestart` | boolean | `true` | Whether the generated launchd/systemd service should auto-restart the daemon. |

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | channels.telegram.botToken | Telegram bot token |
| `MAXOS_HOME` | All modules | Override the default `~/.maxos` directory |
| `CLAUDE_PATH` | Engine | Override the `claude` CLI path (default: `claude` from PATH) |
| `WHISPER_MODEL` | Transcription | Whisper model for voice transcription (default: `base`) |

## File Locations

```
~/.maxos/
  maxos.json        Config file (JSON5)
  .env              Secrets (env vars, gitignored)
  state.json        Runtime state (auto-managed, don't edit)
  crash.log         Crash journal (append-only)
  workspace/        Claude CLI working directory
    SOUL.md         Agent identity
    USER.md         User profile
    HEARTBEAT.md    Scheduled tasks
    MEMORY.md       Persistent memory
    memory/         Daily journals
    tasks/          Task prompt files
    .claude/        Claude Code integration
      CLAUDE.md     Workspace rules
      rules/        Guardrail files
      settings.json Hooks config
  inbox/            Downloaded media from channels
    YYYY-MM-DD/     Date-organized media files
```
