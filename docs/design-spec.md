# MaxOS: Design Specification

**Date:** 2026-03-27
**Author:** Mark McNair + Max (Claude)
**Status:** Draft — awaiting review

---

## 1. Overview

### What MaxOS Is

MaxOS is an open-source personal AI agent runtime that turns a Claude Code subscription into a persistent, always-on assistant accessible through messaging apps. It is a single Node.js daemon that handles channel routing, session management, scheduled automation, and three-tier memory persistence — delegating all LLM work to the Claude CLI.

### What MaxOS Is Not

- Not a model-agnostic framework (Claude Code only — this is a feature, not a limitation)
- Not a multi-user platform (one daemon = one human = one agent)
- Not an API-key-burning token furnace (subscription-powered, zero additional LLM cost)

### Design Principles

1. **Delegate, don't reimplement.** Claude Code already handles model routing, token counting, context compaction, auth, tool execution, MCP, subagents, and sandboxing. We orchestrate — we don't rebuild.
2. **Files are the API.** Configuration is JSON5. Identity is Markdown. Memory is Markdown. Everything is human-readable, git-versionable, and editable with any text editor.
3. **Crash-proof by default.** State snapshots, auto-restart via launchd/systemd, circuit breakers on scheduled tasks, watchdog timers on hung processes.
4. **Four commands to running.** `git clone` → `npm install` → `npx maxos init` → `npx maxos start`.

---

## 2. Architecture

### Process Model

Single long-lived Node.js process ("the daemon") with six internal modules:

```
Telegram / Discord / Slack / [future channels]
                │
                ▼
    ┌───────────────────────────┐
    │       MaxOS Daemon        │
    │   (single Node.js process) │
    │                           │
    │  ┌─────────┐ ┌─────────┐ │
    │  │ Channel  │ │ Session │ │
    │  │ Router   │ │ Manager │ │
    │  └────┬─────┘ └────┬────┘ │
    │       │            │      │
    │  ┌────▼─────┐ ┌────▼────┐ │
    │  │Scheduler │ │ Engine  │ │
    │  │(node-cron)│ │(CLI mgr)│ │
    │  └──────────┘ └────┬────┘ │
    │                    │      │
    │  ┌─────────┐ ┌────▼────┐ │
    │  │ Memory  │ │ State   │ │
    │  │ Watcher │ │ Store   │ │
    │  └─────────┘ └─────────┘ │
    └───────────┬───────────────┘
                │
                ▼
         claude CLI (subprocess)
         (subscription-powered)
```

### Module Responsibilities

| Module | Responsibility | Est. Lines |
|---|---|---|
| **Gateway** (`gateway.ts`) | Process lifecycle, signal handling, health checks, crash journal, module initialization | ~150 |
| **Channel Router** (`channels/`) | Adapter interface, message normalization, reply serialization, smart chunking | ~200 |
| **Session Manager** (`sessions.ts`) | Session ID registry, routing rules (conversation → session mapping), identity links, daily reset | ~200 |
| **Engine** (`engine.ts`) | Claude CLI subprocess management — interactive sessions via PTY, one-shot via execFile, watchdog timers, session recovery | ~250 |
| **Scheduler** (`scheduler.ts`) | HEARTBEAT.md parser, node-cron job management, circuit breaker, protected time windows | ~150 |
| **State Store** (`state.ts`) | Periodic state snapshots to disk, crash recovery on startup, config loading with env var substitution | ~100 |

**Total estimated: ~1,050 lines of TypeScript.**

---

## 3. The Engine: Claude CLI Integration

### Two Execution Modes

#### Mode A: Interactive Session (Conversations)

For the main Telegram conversation and any persistent dialogue.

- Spawns a long-lived `claude` process using `node-pty` (pseudo-terminal)
- Command: `claude --resume SESSION_NAME` (or fresh `claude` for new sessions)
- Messages sent via PTY stdin
- Responses streamed via PTY stdout, parsed in real-time
- Full tool access, full conversation history, full context window
- PTY is required because Claude CLI's interactive mode expects a terminal — raw stdin/stdout falls back to non-interactive behavior

**Configuration per session:**
- `--model sonnet` (or user preference)
- `--permission-mode bypassPermissions` (daemon runs unattended)
- `--allowed-tools` as configured in `maxos.json`
- Working directory: `~/.maxos/workspace/`

**Watchdog:** If no output from Claude for 5 minutes (configurable), kill the process and restart. Logs the timeout to crash journal. This prevents the permanent deadlocks that plague OpenClaw (#17635).

#### Mode B: One-Shot (Scheduled Tasks, Heartbeats)

For fire-and-forget tasks that don't need conversation history.

- Spawns `claude -p "PROMPT" --output-format text` via `child_process.execFile`
- Working directory: `~/.maxos/workspace/` (same workspace, so CLAUDE.md/SOUL.md/rules all load)
- Exits when complete. No persistent session state.
- Timeout: 5 minutes default (configurable per task)
- Output captured and routed to the user's primary channel if non-empty

### Session Recovery

On daemon restart:
1. Read `~/.maxos/state.json` for last-known session names and Claude session IDs
2. For each interactive session, attempt `claude --resume SESSION_NAME`
3. If resume fails (session expired/corrupted), start fresh — workspace files provide all persistent context
4. Log recovery status to crash journal and notify user via Telegram: "Restarted. Picked up where we left off." or "Restarted. Fresh session — I've read today's journal."

---

## 4. Channel System

### Adapter Interface

```typescript
interface ChannelAdapter {
  readonly name: string;
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isHealthy(): boolean;
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(target: string, content: OutboundMessage): Promise<void>;
  capabilities(): ChannelCapabilities;
}

interface InboundMessage {
  channelName: string;
  senderId: string;
  senderName: string;
  conversationId: string;   // "dm:123" or "topic:456"
  text: string;
  replyToId?: string;
  attachments?: Attachment[];
  timestamp: number;
}

interface OutboundMessage {
  text: string;
  format?: "text" | "markdown" | "html";
  replyToId?: string;
  attachments?: Attachment[];
}

interface ChannelCapabilities {
  markdown: boolean;
  html: boolean;
  threads: boolean;
  reactions: boolean;
  voice: boolean;
  maxMessageLength: number;
}
```

### V1 Adapter: Telegram

Built on grammY (same library OpenClaw uses for Telegram).

**Features:**
- Forum topic support: each topic = separate `conversationId`
- Smart message chunking: split at paragraph/sentence boundaries, not mid-word
- HTML formatting (Telegram's supported parse mode)
- Inline keyboard for interactive prompts (permission requests, confirmations)
- Voice message support (future — transcription via Whisper)

**Adding a new channel:** Create `src/channels/discord.ts`, implement `ChannelAdapter`, add config block to `maxos.json`. Zero core code changes.

---

## 5. Session Management

### Routing

Config-driven routing maps conversations to Claude sessions:

```jsonc
{
  "sessions": {
    "routing": [
      { "match": { "conversationId": "topic:work" }, "session": "work" },
      { "match": { "channel": "telegram", "type": "dm" }, "session": "main" },
      { "default": true, "session": "main" }
    ]
  }
}
```

Evaluation order: most specific match wins (exact conversation > channel type > default). Identical to OpenClaw's binding priority system.

### Session Registry

Tracks active sessions with metadata:
- Claude session ID (for `--resume`)
- Last activity timestamp
- Message count
- Session state (active, idle, resetting)

Persisted to `state.json` every 30 seconds.

### Identity Links

Same person on multiple channels shares one session:

```jsonc
{
  "identityLinks": {
    "mark": ["telegram:8117092034", "discord:123456"]
  }
}
```

### Daily Reset

Sessions reset at a configurable time (default 4:00 AM). Before reset:
1. Stop hook fires — Claude writes session summary to daily journal
2. Session IDs cleared from registry
3. Next message creates a fresh session
4. Fresh session loads workspace files (SOUL.md, USER.md, MEMORY.md, today's journal)

---

## 6. Scheduler

### HEARTBEAT.md Format

```markdown
# Heartbeat Tasks

## Every 30 minutes
- Check for anything that needs proactive attention

## Every 45 minutes
- Write a checkpoint to today's daily journal

## 0 6 * * 0-5 (Sun-Fri at 6:00 AM)
- Run morning brief: read tasks/morning-brief.md and execute every step

## 0 15 55 * * 0-5 (Sun-Fri at 3:55 PM)
- Run email triage: read tasks/email-triage.md and execute every step

## 0 16 25 * * 0-5 (Sun-Fri at 4:25 PM)
- Run shutdown debrief: read tasks/shutdown-debrief.md and execute every step

## 0 9 * * 1 (Monday at 9:00 AM)
- Run weekly relationship review

## 0 5 55 * * * (Daily at 5:55 AM)
- Run QMD maintenance: execute `qmd update && qmd embed`
```

### Parser

The scheduler parses HEARTBEAT.md looking for:
- `## Every N minutes/hours` — converted to cron expression
- `## CRON_EXPRESSION (description)` — used directly
- Bullet points under each heading are the task prompt

### Execution

Each task runs as a one-shot (Engine Mode B). The scheduler:
1. Checks protected time windows before firing
2. Ensures `maxConcurrentTasks` limit (default: 1)
3. Passes the bullet point text as the prompt
4. Routes output to user's primary channel if non-empty
5. Tracks consecutive failures per task

### Circuit Breaker

If a task fails 3 consecutive times:
1. Task is disabled
2. User receives alert: "Task X disabled after 3 failures. Last error: ..."
3. Task stays disabled until manually re-enabled via `npx maxos cron enable TASK` or chat command
4. Failure counter resets on success

### Protected Time Windows

```jsonc
{
  "scheduler": {
    "protectedWindows": [
      { "name": "sleep", "start": "22:00", "end": "06:00" },
      { "name": "sabbath", "day": "saturday" },
      { "name": "date-night", "day": "thursday", "start": "17:30" },
      { "name": "sabbath-dinner", "day": "friday", "start": "17:30" }
    ]
  }
}
```

Tasks scheduled during protected windows are skipped silently. The morning brief at 6:00 AM fires because it's at the boundary, not within the window.

---

## 7. Three-Tier Memory System

### Tier 1: Short-Term (Context Window)

**What it is:** The full conversation transcript inside the active Claude session.

**How it works:** The interactive session (Mode A) maintains complete conversation history in Claude's context window (~200K tokens). "What did I say 15 minutes ago?" is answered instantly because it's all in context.

**What happens at compaction:** When the context window fills (~95% capacity), Claude Code auto-compacts. Before compaction, a PreCompact hook fires a prompt that tells Claude to flush important context to the daily journal (Tier 2). After compaction, a PostCompact hook re-injects critical operating rules.

**Hook configuration:**

```jsonc
{
  "hooks": {
    "PreCompact": [{
      "hooks": [{
        "type": "prompt",
        "prompt": "Context is about to be compacted. Write a thorough summary of the current conversation to today's daily journal at workspace/memory/YYYY-MM-DD.md. Include: key decisions made, tasks completed, tasks in progress, commitments or promises, current topic of discussion, and any information the user would expect you to remember. Append — do not overwrite existing entries. This is the bridge between your current memory and your future self."
      }]
    }],
    "PostCompact": [{
      "hooks": [{
        "type": "command",
        "command": "~/.maxos/hooks/post-compact-inject.sh"
      }]
    }]
  }
}
```

### Tier 2: Mid-Term (Daily Journals)

**What it is:** Structured daily logs at `workspace/memory/YYYY-MM-DD.md`.

**Three write mechanisms:**

1. **Periodic checkpoint** (every 45 min via HEARTBEAT.md) — A one-shot Claude task reads the current journal, appends a brief update of what's happened since the last checkpoint. Keeps entries under 200 words. Costs minimal tokens because it's a tiny one-shot.

2. **Pre-compaction flush** (automatic via PreCompact hook) — Thorough summary written before context is lost. Described above.

3. **Session-end summary** (via Stop hook) — When a conversation naturally ends, Claude appends a wrap-up to the journal.

```jsonc
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "prompt",
        "prompt": "If this appears to be the end of a conversation (not mid-task), append a brief session summary to today's journal at workspace/memory/YYYY-MM-DD.md. Topics discussed, outcomes, and anything to pick up next time. Append only."
      }]
    }]
  }
}
```

**How Claude re-orients on session start:**

SOUL.md includes a Session Start Protocol:

```markdown
## Session Start Protocol

When starting a new session or after a reset:
1. MEMORY.md is already in your context (loaded automatically)
2. Read today's daily journal (memory/YYYY-MM-DD.md) if it exists
3. If today's doesn't exist, read yesterday's journal
4. Do NOT announce what you've read. Just be informed by it.
5. If the user asks about something recent, check the journals first.
```

Daily journals are typically 500-2000 words (~750-3000 tokens). Negligible cost to load on boot.

**Rolling cleanup (30-day retention):**

Monthly HEARTBEAT.md task moves journals older than 30 days to `memory/archive/`. Archived files remain searchable via QMD (Tier 3) but aren't loaded on session start.

### Tier 3: Long-Term (QMD Semantic Search)

**What it is:** A vector search engine indexing all workspace files — journals, memory, notes, task definitions, everything.

**How it works:** QMD runs as an MCP server (configured in `.mcp.json`). Claude has access to these tools:
- `qmd search` — keyword search (fast, ~30ms)
- `qmd vector_search` — semantic similarity (~2s)
- `qmd deep_search` — comprehensive multi-strategy (~10s)
- `qmd get` — retrieve specific document

**When Claude uses it:** SOUL.md includes instructions:

```markdown
## Long-Term Memory Search

You have access to QMD, a semantic search engine over your entire workspace.
Use it when:
- The user asks about something from more than a few days ago
- You need context about a project, person, or decision not in today's journal
- You're unsure about a preference or past conversation
- The user says "remember when..." or "what did we decide about..."

ALWAYS search before saying "I don't know" or "I don't have that."
```

**Index freshness:** Daily scheduled task at 5:55 AM runs `qmd update && qmd embed`.

**Setup:** QMD is installed during onboarding (`npm install -g qmd` or from https://github.com/tobi/qmd.git). MCP server configured automatically in `.mcp.json`.

### Memory Flow: A Day in the Life

```
6:00 AM — Fresh session starts
  → Claude reads MEMORY.md (auto-loaded in context)
  → Claude reads today's journal per Session Start Protocol
  → Claude is oriented. Knows yesterday's context.

9:15 AM — "What did we talk about earlier?"
  → Answer is in context window (Tier 1) ✅

10:45 AM — 45-min checkpoint fires
  → One-shot appends morning activity to today's journal (Tier 2)

11:30 AM — "What did we decide about API pricing last month?"
  → Not in context. Claude queries QMD (Tier 3)
  → Finds the answer in an archived journal ✅

2:00 PM — Context compaction triggers
  → PreCompact: Claude writes thorough summary to journal
  → PostCompact: Critical rules re-injected
  → Claude reads today's updated journal, continues seamlessly

4:25 PM — Shutdown debrief fires
  → Day's summary written to journal (Tier 2)
  → Tomorrow's Claude will read this on boot

5:55 AM next day — QMD re-indexes
  → Yesterday's journal now searchable via semantic search (Tier 3)
```

---

## 8. Configuration

### Master Config: `~/.maxos/maxos.json`

```jsonc
{
  // Agent identity
  "identity": {
    "name": "Max",
    "emoji": "🤖",
    "timezone": "America/Chicago"
  },

  // Claude CLI settings
  "engine": {
    "model": "sonnet",
    "permissionMode": "bypassPermissions",
    "allowedTools": [
      "Read", "Write", "Edit", "Bash", "Grep", "Glob",
      "WebSearch", "WebFetch", "Agent", "mcp__*"
    ],
    "maxOneShotTimeout": 300000,
    "watchdogTimeout": 300000
  },

  // Channel configurations
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "allowedUsers": [],
      "dmPolicy": "allowlist",
      "forumTopics": true
    }
  },

  // Session management
  "sessions": {
    "routing": [
      { "default": true, "session": "main" }
    ],
    "reset": { "daily": "04:00" },
    "identityLinks": {}
  },

  // Scheduler
  "scheduler": {
    "enabled": true,
    "heartbeatFile": "workspace/HEARTBEAT.md",
    "maxConcurrentTasks": 1,
    "circuitBreakerThreshold": 3,
    "protectedWindows": []
  },

  // Reliability
  "reliability": {
    "stateSnapshotInterval": 30000,
    "crashJournalMaxEntries": 100,
    "healthCheckPort": 18790,
    "autoRestart": true
  }
}
```

### Environment Variables

Secrets stored in `~/.maxos/.env` (never committed):

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
```

Config supports `${VAR_NAME}` substitution from environment.

### Directory Structure

```
~/.maxos/
├── maxos.json              # Master config (JSON5)
├── .env                    # Secrets (gitignored)
├── state.json              # Runtime state (auto-managed)
├── crash.log               # Crash journal
├── hooks/
│   └── post-compact-inject.sh  # Rule re-injection script
├── workspace/
│   ├── SOUL.md             # Agent personality + behavior
│   ├── USER.md             # Human profile + preferences
│   ├── HEARTBEAT.md        # Scheduled task definitions
│   ├── MEMORY.md           # Curated long-term memory (agent-maintained)
│   ├── memory/
│   │   ├── YYYY-MM-DD.md   # Daily journals
│   │   └── archive/        # Journals older than 30 days
│   ├── tasks/              # Detailed task definitions
│   │   ├── morning-brief.md
│   │   ├── email-triage.md
│   │   └── shutdown-debrief.md
│   └── .claude/
│       ├── CLAUDE.md       # Imports @../SOUL.md, @../USER.md
│       ├── rules/          # Guardrail files
│       ├── settings.json   # Hooks, permissions
│       └── agents/         # Custom subagents
├── channels/
│   └── telegram/
│       └── config.json     # Channel-specific state
└── services/
    └── com.maxos.daemon.plist  # Generated launchd config
```

---

## 9. Reliability

### Auto-Restart

The `maxos install-service` command generates:

**macOS (launchd):**
```xml
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.maxos.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/maxos/dist/index.js</string>
    <string>start</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>~/.maxos/workspace</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>~/.maxos/daemon.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>~/.maxos/daemon.stderr.log</string>
</dict>
</plist>
```

**Linux (systemd):**
```ini
[Unit]
Description=MaxOS Agent Daemon
After=network.target

[Service]
Type=simple
ExecStart=/path/to/node /path/to/maxos/dist/index.js start
WorkingDirectory=~/.maxos/workspace
Restart=always
RestartSec=2
EnvironmentFile=~/.maxos/.env

[Install]
WantedBy=default.target
```

Process crashes → restarted in <2 seconds. State recovered from `state.json`.

### State Snapshots

Every 30 seconds, the daemon writes to `~/.maxos/state.json`:

```jsonc
{
  "version": 1,
  "timestamp": 1711540800000,
  "sessions": {
    "main": {
      "claudeSessionId": "abc123",
      "lastActivity": 1711540750000,
      "messageCount": 47
    }
  },
  "scheduler": {
    "failures": { "email-triage": 0, "morning-brief": 0 },
    "disabled": [],
    "lastRun": { "morning-brief": 1711526400000 }
  },
  "channels": {
    "telegram": { "healthy": true, "lastMessage": 1711540700000 }
  }
}
```

### Crash Journal

Last 100 events with timestamps:

```jsonc
[
  { "ts": 1711540800000, "event": "daemon_start", "recovery": "clean" },
  { "ts": 1711540850000, "event": "session_created", "name": "main" },
  { "ts": 1711541000000, "event": "watchdog_timeout", "session": "main", "action": "kill_restart" },
  { "ts": 1711541002000, "event": "session_recovered", "name": "main", "method": "resume" }
]
```

### Watchdog Timer

If an interactive session produces no output for `watchdogTimeout` ms (default 5 min):
1. Log to crash journal
2. Kill the Claude process
3. Attempt session resume
4. If resume fails, start fresh session
5. Notify user: "Session hung and was restarted."

### Circuit Breaker

Scheduled tasks that fail 3 consecutive times are disabled with a Telegram alert. Prevents infinite token burn on broken tasks. Manual re-enable via CLI or chat.

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new messages
2. Wait up to 30s for in-flight Claude runs to finish
3. Flush state snapshot
4. Write crash journal entry
5. Disconnect channels
6. Exit 0

---

## 10. Onboarding Flow

### User Experience

```bash
$ git clone https://github.com/[user]/maxos.git
$ cd maxos
$ npm install
$ npx maxos init
```

### Interview Wizard

Plain Node.js readline prompts (no Claude needed for the questions):

1. "What should your agent be called?" → `identity.name`
2. "What's your name?" → USER.md
3. "What's your timezone?" → `identity.timezone`
4. "Describe your ideal AI assistant's personality." → SOUL.md generation seed
5. "What kind of work do you primarily do?" → SOUL.md + USER.md
6. "Any daily tools/services?" → SOUL.md tool awareness
7. "Connect Telegram? (y/n)" → Channel setup
8. If yes: "Paste your BotFather bot token" → `channels.telegram.botToken`
9. If yes: "What's your Telegram user ID?" → `channels.telegram.allowedUsers`

### Generation

After the interview, `maxos init`:

1. Passes all answers to `claude -p` with a generation prompt
2. Claude generates personalized SOUL.md, USER.md, HEARTBEAT.md from the answers
3. Writes `maxos.json` from template + answers
4. Creates `.claude/CLAUDE.md` that imports SOUL.md and USER.md via `@` syntax
5. Creates `.claude/settings.json` with hooks configured
6. Generates `post-compact-inject.sh` hook script
7. Configures `.mcp.json` for QMD (if installed)
8. Creates directory structure under `~/.maxos/`
9. Optionally installs launchd/systemd service

### Post-Init Output

```
✅ Generated SOUL.md — your agent's personality
✅ Generated USER.md — your profile and preferences
✅ Generated HEARTBEAT.md — starter scheduled tasks
✅ Generated maxos.json — daemon configuration
✅ Generated .claude/ — Claude Code integration
✅ Installed launchd service

Start your agent:
  npx maxos start

Or run in foreground (for debugging):
  npx maxos start --foreground

Open Telegram and message your bot to say hello!
```

---

## 11. CLI Commands

```bash
# Lifecycle
npx maxos init                     # Interactive onboarding
npx maxos start                    # Start daemon (background via service)
npx maxos start --foreground       # Start in terminal (debug mode)
npx maxos stop                     # Graceful shutdown
npx maxos restart                  # Stop + start
npx maxos status                   # Health, sessions, scheduler, channels

# Service management
npx maxos install-service          # Install launchd/systemd service
npx maxos uninstall-service        # Remove service

# Configuration
npx maxos config show              # Resolved config with sources
npx maxos config set <path> <val>  # Set config value
npx maxos config edit              # Open maxos.json in $EDITOR

# Scheduler
npx maxos cron list                # Show all tasks + status
npx maxos cron run <task>          # Execute task immediately
npx maxos cron enable <task>       # Re-enable disabled task
npx maxos cron disable <task>      # Disable task

# Sessions
npx maxos sessions list            # Active sessions + metadata
npx maxos sessions reset <name>    # Reset specific session
npx maxos sessions reset --all     # Reset all sessions

# Diagnostics
npx maxos logs                     # Tail daemon logs
npx maxos logs --crash             # Show crash journal
npx maxos doctor                   # Check dependencies, config, health
```

---

## 12. Repo Structure

```
maxos/
├── README.md                      # Quick start + architecture overview
├── package.json                   # Dependencies + "bin": { "maxos": ... }
├── tsconfig.json
├── LICENSE                        # MIT
│
├── src/
│   ├── index.ts                   # CLI entry (commander.js)
│   ├── gateway.ts                 # Daemon lifecycle + module init
│   ├── engine.ts                  # Claude CLI subprocess manager
│   ├── sessions.ts                # Session registry + routing
│   ├── scheduler.ts               # node-cron + HEARTBEAT.md parser
│   ├── state.ts                   # State snapshots + recovery
│   ├── config.ts                  # maxos.json loader + env substitution
│   ├── channels/
│   │   ├── adapter.ts             # ChannelAdapter interface
│   │   └── telegram.ts            # Telegram (grammY)
│   └── utils/
│       ├── logger.ts              # Structured logging (winston)
│       ├── chunker.ts             # Smart message splitting
│       └── pty.ts                 # PTY wrapper for interactive sessions
│
├── templates/                     # Onboarding generation templates
│   ├── soul.md.hbs                # SOUL.md (Handlebars)
│   ├── user.md.hbs                # USER.md
│   ├── heartbeat.md.hbs           # HEARTBEAT.md
│   ├── claude.md.hbs              # .claude/CLAUDE.md
│   ├── settings.json.hbs          # .claude/settings.json
│   └── maxos.json.hbs             # Default config
│
├── scripts/
│   ├── onboard.ts                 # Interview wizard
│   ├── doctor.ts                  # Diagnostic checks
│   └── service.ts                 # launchd/systemd installer
│
├── services/
│   ├── com.maxos.daemon.plist     # macOS launchd template
│   └── maxos.service              # Linux systemd template
│
├── hooks/
│   └── post-compact-inject.sh     # Template for rule re-injection
│
├── docs/
│   ├── architecture.md            # Technical deep dive
│   ├── adding-channels.md         # Channel adapter guide
│   ├── configuration.md           # All config options
│   ├── memory-system.md           # Three-tier memory explained
│   └── migrating-from-openclaw.md # OpenClaw → MaxOS migration
│
└── examples/
    ├── souls/                     # Community SOUL.md examples
    │   ├── chief-of-staff.md
    │   ├── dev-partner.md
    │   └── executive-assistant.md
    ├── heartbeats/                # Example schedules
    │   ├── developer.md
    │   ├── founder.md
    │   └── student.md
    └── tasks/                     # Example task definitions
        ├── morning-brief.md
        ├── email-triage.md
        └── shutdown-debrief.md
```

---

## 13. Dependencies

```jsonc
{
  "dependencies": {
    "grammy": "^1.35.0",          // Telegram bot (same as OpenClaw)
    "node-cron": "^3.0.0",        // Cron scheduling
    "node-pty": "^1.0.0",         // PTY for interactive Claude sessions
    "commander": "^12.0.0",       // CLI framework
    "json5": "^2.2.0",            // JSON5 config parsing
    "handlebars": "^4.7.0",       // Template generation (onboarding)
    "winston": "^3.17.0"          // Structured logging
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.0.0"               // Dev runner
  }
}
```

**7 runtime dependencies.** OpenClaw has 200+.

### External Dependencies (installed separately)

- **Claude Code CLI** — Required. User must have an active Claude Code subscription.
- **Node.js 22+** — Required. Installed via Homebrew or nvm.
- **QMD** — Optional but recommended. Provides Tier 3 long-term memory search. Install from https://github.com/tobi/qmd.git. The `maxos doctor` command checks for QMD and offers to install it.

---

## 14. What We Don't Build

| Capability | Why Not |
|---|---|
| Model routing / fallback chains | Claude CLI handles it |
| Token counting / context management | Claude CLI handles it |
| Context compaction | Claude CLI handles it |
| Auth / billing | Claude CLI handles it |
| Tool execution + sandboxing | Claude CLI handles it |
| Tool permission system | Claude CLI handles it |
| Sub-agent orchestration | Claude's native Agent tool |
| MCP server management | Claude's native MCP system |
| Skill discovery / loading | Claude's native plugin system |
| Browser automation | Claude's built-in browser tool + Playwright MCP |
| Vector memory indexing | QMD (external) |

Every line we don't write is a bug we'll never ship.

---

## 15. OpenClaw Feature Parity

| OpenClaw Feature | MaxOS Equivalent | Ships In |
|---|---|---|
| Gateway (single process daemon) | MaxOS daemon | v1 |
| SOUL.md | SOUL.md (identical concept) | v1 |
| AGENTS.md | .claude/CLAUDE.md + .claude/rules/ | v1 |
| USER.md | USER.md (identical concept) | v1 |
| HEARTBEAT.md | HEARTBEAT.md (enhanced: cron syntax + circuit breaker) | v1 |
| MEMORY.md + daily logs | Three-tier memory system | v1 |
| IDENTITY.md | identity block in maxos.json | v1 |
| TOOLS.md | .claude/rules/ + MCP config | v1 |
| 24+ channel adapters | Pluggable adapters (Telegram in v1) | v1 framework |
| Session management + routing | Session manager with config-driven routing | v1 |
| Heartbeat system | Scheduler with cron + circuit breaker + protected windows | v1 |
| Cron jobs | Scheduler (same concept, better failure handling) | v1 |
| Sub-agents | Claude Code native subagents (free) | v1 |
| MCP tool servers | Claude Code native MCP (free) | v1 |
| Model fallback chains | Claude CLI (free) | v1 |
| Context compaction | Claude CLI + PreCompact/PostCompact hooks | v1 |
| Memory search (vector) | QMD via MCP | v1 |
| Browser automation | Claude browser tool / Playwright MCP (free) | v1 |
| Multi-agent routing | Session routing + subagents | v1 |
| Sandbox/Docker | Claude Code native sandbox (free) | v1 |
| DM pairing / allowlist | allowedUsers in channel config | v1 |
| Identity links | identityLinks in session config | v1 |
| Skills system | Claude Code plugins (free) | v1 |
| Canvas / A2UI | — | v2 |
| Node commands (camera, etc.) | — | v2 |
| ACP (external agent bridge) | — | v2 |
| Voice message transcription | — | v2 |
| Discord adapter | — | v2 |
| Slack adapter | — | v2 |

---

## 16. Migration: Current Setup → MaxOS

Mark's current infrastructure migrates cleanly:

| Current | MaxOS Equivalent |
|---|---|
| CCBot (Python tmux bridge) | MaxOS daemon's Telegram adapter (built-in) |
| 7 launchd .plist files | HEARTBEAT.md entries (one file, not seven) |
| tmux session management | Engine subprocess management (no tmux dependency) |
| ~/.ccbot/.env | ~/.maxos/.env |
| ~/.ccbot/state.json | ~/.maxos/state.json |
| CLAUDE.md (14KB monolith) | SOUL.md + USER.md + .claude/CLAUDE.md (separated) |
| .claude/rules/ | .claude/rules/ (identical, carried over) |
| .claude/hooks/ | .claude/settings.json hooks (same, just in config) |
| QMD MCP server | QMD MCP server (identical, carried over) |
| GWS CLI wrappers | Carried over as-is (they're just shell scripts) |
| Work/Scheduled Tasks/*.md | workspace/tasks/*.md (moved, same format) |

**Context preservation:** All MEMORY.md entries, auto-memory files, feedback files, and project files carry over to the new workspace. The daily journals start fresh, but QMD indexes the old vault for long-term recall.

---

## 17. Success Criteria

The system is complete when:

1. A new user can go from `git clone` to a working Telegram agent in under 10 minutes
2. The agent maintains conversational continuity across sessions (daily reset, compaction, crashes)
3. Scheduled tasks fire reliably with circuit breaker protection
4. "What did we talk about this morning?" works (Tier 2 journal)
5. "What did we decide about X last month?" works (Tier 3 QMD search)
6. The daemon auto-recovers from crashes without user intervention
7. Total codebase is under 1,500 lines of TypeScript
8. Total runtime dependencies are under 10
