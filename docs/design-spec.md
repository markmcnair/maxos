# MaxOS: Design Specification — V1.0

**Date:** 2026-04-03
**Author:** Mark McNair + Max (Claude)
**Status:** V1.0 — shipped and tested

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
3. **Crash-proof by default.** State snapshots, circuit breakers on scheduled tasks, watchdog timers on hung processes, graceful shutdown with drain.
4. **Five commands to running.** `git clone` → `npm install` → `npx maxos init` → `npx maxos setup` → `npx maxos start`. Init collects identity (deterministic). Setup connects tools (intelligent). Start launches the daemon.

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

| Module | Responsibility | Lines |
|---|---|---|
| **Gateway** (`gateway.ts`) | Process lifecycle, signal handling, health/API server, crash journal, module initialization, message routing | ~520 |
| **Channel Router** (`channels/`) | Adapter interface, message normalization, smart chunking, Markdown→HTML conversion, media downloads, Whisper transcription | ~490 |
| **Session Manager** (`sessions.ts`) | Session ID registry, routing rules (conversation → session mapping), identity links, daily reset | ~100 |
| **Engine** (`engine.ts`) | Claude CLI subprocess management — Promise-based interactive sessions via spawn + stream-json, one-shot via execFile, watchdog timers, PATH enrichment, claude path auto-resolution | ~365 |
| **Scheduler** (`scheduler.ts`) | HEARTBEAT.md parser, node-cron job management, one-shot scheduling, circuit breaker | ~380 |
| **State Store** (`state.ts`) | Periodic state snapshots to disk, crash recovery on startup, config loading with env var substitution | ~105 |

**Core runtime: ~2,325 lines. CLI: ~655 lines. Total: ~2,980 lines of TypeScript.**

---

## 3. The Engine: Claude CLI Integration

### Two Execution Modes

#### Mode A: Interactive Session (Conversations)

For the main Telegram conversation and any persistent dialogue.

- Each message spawns a `claude -p "MESSAGE" --output-format stream-json --resume SESSION_ID` process
- `send()` returns a `Promise<string>` — each message gets its own promise, no shared event listeners
- Messages that arrive while a response is in-flight are queued with their promise resolvers and processed sequentially
- Session continuity maintained via `-n SESSION_NAME` (first message) then `--resume SESSION_ID` (subsequent)
- Session IDs captured from the `result` event in stream-json output and persisted to SessionManager

**Configuration per session:**
- `--model opus` (or user preference)
- `--permission-mode bypassPermissions` (daemon runs unattended)
- `--allowed-tools` as configured in `maxos.json`
- Working directory: `~/.maxos/workspace/`

**Watchdog:** If no stdout from Claude for 10 minutes (configurable), kill the process and reject the pending promise. Logs the timeout to crash journal.

**Claude path auto-resolution (Tier 4 guardrail):** The engine resolves the claude binary at startup: (1) `CLAUDE_PATH` env var, (2) sibling of `process.execPath` (handles nvm/homebrew/volta), (3) bare `"claude"` fallback. This prevents the "daemon starts but nothing works" bug where `claude` isn't in PATH.

**PATH enrichment:** The engine builds a rich PATH for all subprocesses, prepending `~/bin` (user scripts like gws wrappers), `~/.local/bin`, the nvm node bin dir (contains `claude`, `granola`, `maxos`), and `/opt/homebrew/bin`. This ensures tools available in interactive shells also work in daemon-spawned Claude sessions.

#### Mode B: One-Shot (Scheduled Tasks, Heartbeats)

For fire-and-forget tasks that don't need conversation history.

- Spawns `claude -p "PROMPT" --output-format text` via `child_process.execFile`
- Working directory: `~/.maxos/workspace/` (same workspace, so CLAUDE.md/SOUL.md/rules all load)
- Exits when complete. No persistent session state.
- Timeout: 10 minutes default (configurable per task)
- Output captured and routed to the user's primary channel if non-empty

### Session Recovery

On daemon restart:
1. Read `~/.maxos/state.json` for last-known session names and Claude session IDs
2. First message creates a new InteractiveSession with `-n SESSION_NAME`
3. Claude CLI resolves the named session from its own on-disk session store
4. If the session still exists, conversation history is restored automatically
5. Log recovery status to crash journal and notify user if last shutdown was a crash

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
  send(conversationId: string, content: OutboundMessage): Promise<void>;
  sendTyping?(conversationId: string): Promise<void>;
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

interface Attachment {
  path: string;
  type: "image" | "voice" | "audio" | "document" | "video";
  mimeType?: string;
  filename?: string;
  size?: number;
}
```

### V1 Adapter: Telegram

Built on grammY.

**Features:**
- Forum topic support: each topic = separate `conversationId`
- Smart message chunking: split at paragraph/sentence boundaries, not mid-word
- Markdown→Telegram HTML conversion: Claude outputs Markdown, the adapter converts `**bold**` → `<b>`, `*italic*` → `<i>`, `[text](url)` → clickable links, code blocks → `<pre>`, etc. Falls back to plain text if HTML parsing fails.
- Voice message transcription via local Whisper (OpenAI)
- Media attachments: photos, documents, audio, video, stickers, video notes
- 409 conflict retry with exponential backoff (handles competing bot processes)

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

### Session Registry

Tracks active sessions with metadata:
- Claude session ID (for `--resume`)
- Last activity timestamp
- Message count

Session IDs are captured from Claude CLI's stream-json `result` event and registered via `SessionManager.register()`. Persisted to `state.json` every 30 seconds.

### Identity Links

Same person on multiple channels shares one session:

```jsonc
{
  "identityLinks": {
    "alice": ["telegram:123456789", "discord:987654321"]
  }
}
```

### Daily Reset

Sessions reset at a configurable time (default 4:00 AM):
1. All interactive sessions killed
2. Session IDs cleared from registry
3. Next message creates a fresh session
4. Fresh session loads workspace files (SOUL.md, USER.md, MEMORY.md, today's journal)

---

## 6. Scheduler

### HEARTBEAT.md Format

```markdown
# Heartbeat Tasks

## Every 45 minutes [silent]
- If there has been any substantive work, decisions, or conversations since the last journal entry, write a brief checkpoint to today's daily journal (memory/YYYY-MM-DD.md). Include what happened, decisions made, current state. Keep under 200 words. Append only. If nothing meaningful has happened, do nothing — do NOT write empty "awaiting direction" entries.

## 55 5 * * * [silent]
- Run QMD maintenance: execute `cd ~/.maxos/workspace && qmd update && qmd embed 2>&1`. Report errors only.
```

> **Note:** Morning brief, email triage, and shutdown debrief are not baked into the template. They are offered as optional starter automations during onboarding (Phase 2) and written to HEARTBEAT.md + tasks/ only if the user accepts.

### Parser

The scheduler parses HEARTBEAT.md looking for:
- `## Every N minutes/hours` — converted to cron expression
- `## CRON_EXPRESSION (description)` — used directly
- `[silent]` tag on headings — task runs but output is NOT delivered to user channels
- `[script]` tag on headings — the bullet is a shell command, exec directly (no Claude spawn, no LLM cost)
- `[timeout:Nm]` / `[timeout:Ns]` tag on headings — custom timeout in minutes or seconds
- `[model:NAME]` tag on headings — per-task model override (e.g. `[model:sonnet]` for cheap one-shots), falls back to `config.engine.model` if unset
- Bullet points under each heading are the task prompt

### Execution

Each recurring task runs as a one-shot (Engine Mode B). The scheduler:
1. Ensures `maxConcurrentTasks` limit (default: 3)
2. Passes the bullet point text as the prompt
3. Routes output to user's primary channel if non-empty (unless `[silent]`)
4. Writes a summary of the output to today's daily journal (`memory/YYYY-MM-DD.md`) so interactive sessions have visibility into what scheduled tasks reported
5. Tracks consecutive failures per task

One-shot (one-time) tasks follow the same execution path but are stored as `PendingOneShot` entries in state.json rather than parsed from HEARTBEAT.md. A 30-second tick loop checks for due one-shots. They are removed from state before execution to prevent double-fire on crash.

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
      { "name": "family-time", "day": "sunday" },
      { "name": "focus-block", "day": "wednesday", "start": "14:00", "end": "17:00" }
    ]
  }
}
```

Protected windows are **agent context, not infrastructure enforcement.** The scheduler does NOT check protected windows — every task fires and delivers on its configured schedule. The user set the time; the system honors it.

Protected window config is passed to the agent via SOUL.md so the LLM knows when NOT to proactively message the user (e.g., don't send random suggestions at 3 AM). But if the user says "do X at 11pm" or schedules a task for 5:30 AM, it runs and delivers at that time regardless.

### One-Shot Scheduling

One-time tasks use the `maxos run-at` command or the `/api/oneshot` daemon API. The system:
1. Parses human time formats (`"3:45pm"`, `"14:30"`) into Unix timestamps
2. Stores pending one-shots in `state.json` (persists across restarts)
3. Checks for due one-shots every 30 seconds
4. Fires as a normal engine task, delivers output to primary channel
5. Removes from state before execution (prevents double-fire)

**API endpoints:**
- `POST /api/oneshot` — `{ fireAt: number, prompt: string, silent?: boolean }` → `{ ok, id, fireAt }`
- `GET /api/oneshot/list` → `PendingOneShot[]`
- `DELETE /api/oneshot/:id` → `{ ok }`

**CLI:** `npx maxos run-at "3:45pm" "Find the best AI post today"`

The workspace CLAUDE.md also teaches the agent to schedule one-shots via `curl` to the daemon API as a fallback if `maxos` isn't on PATH.

---

## 7. Three-Tier Memory System

### Tier 1: Short-Term (Context Window)

The full conversation transcript inside the active Claude session (~200K tokens). Maintained automatically via `--resume`. Before compaction, a PreCompact hook flushes important context to the daily journal (Tier 2). After compaction, a PostCompact hook re-injects critical operating rules.

### Tier 2: Mid-Term (Daily Journals)

Structured daily logs at `workspace/memory/YYYY-MM-DD.md`. Written by:
1. **Periodic checkpoint** (every 45 min, silent) — one-shot appends brief update
2. **Pre-compaction flush** (automatic via PreCompact hook) — thorough summary before context loss

SOUL.md includes a Session Start Protocol: read MEMORY.md (auto-loaded), read today's journal, fall back to yesterday's if today doesn't exist. No announcements — just be informed.

### Tier 3: Long-Term (QMD Semantic Search)

QMD runs as an MCP server indexing all workspace files. SOUL.md instructs the agent to search before saying "I don't know." Daily task at 5:55 AM re-indexes via `qmd update && qmd embed`.

### Memory Flow: A Day in the Life

```
6:00 AM — Fresh session starts
  → Claude reads MEMORY.md + today's journal → oriented

9:15 AM — "What did we talk about earlier?"
  → In context window (Tier 1) ✅

10:45 AM — 45-min checkpoint fires
  → One-shot appends morning activity to journal (Tier 2)

11:30 AM — "What did we decide about API pricing last month?"
  → QMD semantic search (Tier 3) → finds archived journal ✅

2:00 PM — Context compaction
  → PreCompact flushes to journal, PostCompact re-injects rules

4:35 PM — Shutdown debrief fires
  → Day summary written to journal → tomorrow's Claude reads on boot
```

---

## 8. Configuration

### Master Config: `~/.maxos/maxos.json`

```jsonc
{
  "identity": {
    "name": "Max",
    "emoji": "🤖",
    "timezone": "America/Chicago"
  },
  "engine": {
    "model": "opus",
    "permissionMode": "bypassPermissions",
    "allowedTools": [
      "Read", "Write", "Edit", "Bash", "Grep", "Glob",
      "WebSearch", "WebFetch", "Agent", "mcp__*"
    ],
    "maxOneShotTimeout": 600000,
    "watchdogTimeout": 600000,
    "responseTimeout": 600000
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "allowedUsers": ["123456789"],
      "dmPolicy": "allowlist",
      "forumTopics": false
    }
  },
  "sessions": {
    "routing": [{ "default": true, "session": "main" }],
    "reset": { "daily": "04:00" },
    "identityLinks": {}
  },
  "scheduler": {
    "enabled": true,
    "heartbeatFile": "workspace/HEARTBEAT.md",
    "maxConcurrentTasks": 3,
    "circuitBreakerThreshold": 3,
    "protectedWindows": [
      { "name": "sleep", "start": "22:00", "end": "06:00" }
    ]
  },
  "reliability": {
    "stateSnapshotInterval": 30000,
    "crashJournalMaxEntries": 100,
    "healthCheckPort": 18790,
    "autoRestart": true
  }
}
```

Secrets in `~/.maxos/.env` (never committed). Config supports `${VAR_NAME}` substitution.

### Directory Structure

```
~/.maxos/
├── maxos.json              # Master config (JSON5)
├── .env                    # Secrets (gitignored)
├── state.json              # Runtime state (auto-managed)
├── crash.log               # Crash journal
├── hooks/
│   └── post-compact-inject.sh
├── workspace/
│   ├── SOUL.md             # Agent personality + behavior
│   ├── USER.md             # Human profile + preferences
│   ├── HEARTBEAT.md        # Scheduled task definitions
│   ├── MEMORY.md           # Curated long-term memory
│   ├── CONTEXT_IMPORT.md   # Context from onboarding
│   ├── memory/
│   │   ├── YYYY-MM-DD.md   # Daily journals
│   │   └── archive/        # Journals older than 30 days
│   ├── tasks/              # Detailed task definitions
│   │   ├── morning-brief.md
│   │   ├── email-triage.md
│   │   └── ...
│   └── .claude/
│       ├── CLAUDE.md       # Workspace behavior rules
│       ├── rules/          # Guardrail files
│       └── settings.json   # Hooks, permissions
├── channels/
│   └── telegram/
└── inbox/
    └── YYYY-MM-DD/         # Downloaded media files
```

---

## 9. Reliability

### Startup: Deterministic Pre-flight

`maxos start` runs a scripted pre-flight before starting the daemon:
1. Kill anything holding port 18790 (previous daemon, zombie)
2. Kill competing Telegram pollers (CCBot, Claude plugins, old tmux sessions)
3. Disable Claude Code's Telegram plugin in `~/.claude/settings.json`
4. Unload old launchd scheduled task agents
5. Wait for Telegram API polling lock to release

Pre-flight is deterministic — no LLM, no improvisation. Runs every `maxos start` unless `--skip-preflight` is passed.

### Port Conflict Protection

The gateway catches `EADDRINUSE` on the health server and exits with a clear error message pointing to the kill command. Combined with pre-flight port killing, this prevents the "zombie daemon silently serving stale code" bug.

### State Snapshots

Every 30 seconds, the daemon writes session state, scheduler state, and channel health to `~/.maxos/state.json`.

### Crash Journal

Append-only log (`crash.log`) of lifecycle events: daemon start/stop, session creation, watchdog timeouts. Trimmed to last 100 entries. On startup, if the last event isn't a clean `daemon_stop`, the user is notified: "Restarted after a crash. All systems back online."

### Watchdog Timer

If an interactive session's Claude process produces no stdout for `watchdogTimeout` ms (default 10 min), the process is killed, the pending promise is rejected, and the session is removed from the active map.

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new messages
2. Wait up to 30s for in-flight Claude runs to finish
3. Save state and write crash journal entry (before channel disconnect)
4. Disconnect channels
5. Exit 0

---

## 10. Onboarding Flow

### Design Philosophy: Hybrid Onboarding

Onboarding is split into two stages: **deterministic script for identity/generation, intelligent agent for discovery/wiring.**

The line: anything that touches auth, credentials, or system config is scripted. Anything that requires judgment — discovering tools, verifying connections, porting automations, troubleshooting auth — is conversational.

### User Experience

```bash
$ git clone https://github.com/[user]/maxos.git && cd maxos && npm install
$ npx maxos init       # Identity + workspace generation (deterministic)
$ npx maxos setup      # Tool discovery + wiring (launches Claude Code)
```

Users can also skip `init` and go straight to Claude Code — a `SessionStart` hook in the repo's `.claude/settings.json` checks for the workspace and directs the agent to the onboard skill.

### Step 1: `npx maxos init` (Deterministic)

`scripts/onboard.ts` — readline wizard. Collects identity, personality, Telegram token (verified via getMe), generates workspace via Handlebars templates.

### Step 2: `npx maxos setup` (Intelligent)

`.claude/skills/onboard.md` — 3-phase conversational flow:

**Phase 1 — Connections:** Discovers and verifies integrations — Telegram (getMe), email (gws CLI wrappers verified with `+triage`), calendar (`+agenda`), iMessage (sqlite3), Granola CLI. Each verified with real API calls, not `which` checks. Auth failures handled via `auth login` browser flow. Credential file guardrail prevents touching `.enc` files.

**Phase 2 — Discover & Plan Automations:** Scans for existing tasks (Obsidian vault, crontab, launchd, CCBot). Reads every task file. Presents findings. Offers starter automations. Records everything — **no file writes yet.**

**Phase 3 — Wire Everything:**
1. Writes task files, appends HEARTBEAT.md entries, wires integrations, writes rules
2. Confirms protected time windows and updates maxos.json
3. Checks macOS FDA for the node binary via TCC database
4. Builds TypeScript, runs `npm link` for global CLI, starts daemon via `maxos start`
5. Verifies end-to-end Telegram delivery with test message
6. Shows summary table

**Onboarding reliability:** The repo has a `.claude/settings.json` with a `SessionStart` hook that injects "NO_WORKSPACE — FRESH INSTALL. Read .claude/skills/onboard.md" directly into the agent's context. This prevents the agent from exploring the repo instead of following the skill.

### Key Guardrails

**Credential file guardrail (Tier 4):** Never move, copy, rename, or delete `.enc`, `credentials.json`, or credential files. Safe actions: `auth status`, `auth login`, `+triage`/`+agenda` verification only.

**FDA dual-grant:** macOS FDA doesn't cascade from terminal to daemon. Onboarding checks the TCC database for node binary FDA status. Without this, iMessage works in Claude Code but silently fails in scheduled tasks.

---

## 11. CLI Commands

```bash
# Onboarding
npx maxos init                     # Identity + workspace generation
npx maxos setup                    # Tool discovery + wiring (Claude Code)

# Lifecycle
npx maxos start                    # Start daemon (runs pre-flight automatically)
npx maxos start --foreground       # Start in terminal (debug mode)
npx maxos stop                     # Graceful shutdown (kills by port)
npx maxos restart                  # Stop + pre-flight + start
npx maxos status                   # Health, sessions, scheduler, channels

# Configuration
npx maxos config show              # Resolved config
npx maxos config set <path> <val>  # Set value (dot-notation)
npx maxos config edit              # Open in $EDITOR

# Scheduler (recurring)
npx maxos cron list                # Show all tasks + status
npx maxos cron run <task>          # Execute task immediately
npx maxos cron enable <task>       # Re-enable disabled task
npx maxos cron disable <task>      # Disable task

# One-shot scheduling
npx maxos run-at "3:45pm" "prompt" # Schedule one-time task
npx maxos run-at "14:30" "prompt" --silent

# Sessions
npx maxos sessions list            # Active sessions
npx maxos sessions reset           # Reset all sessions

# Diagnostics
npx maxos logs                     # Daemon logs
npx maxos logs -n 50 -f            # Follow last 50 lines
npx maxos logs --crash             # Crash journal
npx maxos doctor                   # Dependency + health check
```

---

## 12. Repo Structure

```
maxos/
├── README.md
├── package.json
├── tsconfig.json
├── LICENSE (MIT)
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
│       ├── markdown-to-telegram.ts # Markdown → Telegram HTML
│       ├── time.ts                # Human time parsing for run-at
│       └── transcribe.ts          # Whisper voice transcription
│
├── .claude/
│   ├── settings.json              # SessionStart hook for onboarding
│   └── skills/
│       └── onboard.md             # Onboarding skill (Phase 1-3)
│
├── templates/                     # Handlebars templates for workspace gen
│   ├── soul.md.hbs
│   ├── user.md.hbs
│   ├── heartbeat.md.hbs
│   ├── claude.md.hbs
│   ├── settings.json.hbs
│   └── maxos.json.hbs
│
├── scripts/
│   ├── onboard.ts                 # Interview wizard
│   ├── generate-workspace.ts      # Template renderer
│   └── service.ts                 # launchd/systemd installer
│
├── hooks/
│   └── post-compact-inject.sh     # Template for rule re-injection
│
├── tests/
│   ├── chunker.test.ts
│   ├── config.test.ts
│   ├── engine.test.ts
│   ├── integration.test.ts
│   ├── markdown-telegram.test.ts
│   ├── oneshot.test.ts
│   ├── scheduler.test.ts
│   ├── sessions.test.ts
│   └── state.test.ts
│
├── docs/
│   └── design-spec.md             # This file
│
└── examples/
    ├── souls/
    ├── heartbeats/
    └── tasks/
```

---

## 13. Dependencies

```jsonc
{
  "dependencies": {
    "grammy": "^1.35.0",          // Telegram bot
    "node-cron": "^3.0.3",        // Cron scheduling
    "commander": "^13.1.0",       // CLI framework
    "json5": "^2.2.3",            // JSON5 config parsing
    "handlebars": "^4.7.8",       // Template generation
    "winston": "^3.17.0",         // Structured logging
    "dotenv": "^17.3.1"           // .env file loading
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0"              // Dev runner + test loader
  }
}
```

**7 runtime dependencies.** No native modules. No build step beyond `tsc`.

### External Dependencies

- **Claude Code CLI** — Required. Active Claude Code subscription.
- **Node.js 22+** — Required. nvm, Homebrew, or direct install.
- **QMD** — Optional. Provides Tier 3 long-term memory search.
- **Whisper** — Optional. Provides voice message transcription.

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
| Browser automation | Claude's built-in browser tool |
| Vector memory indexing | QMD (external) |

Every line we don't write is a bug we'll never ship.

---

## 15. Success Criteria

The system is complete when:

1. ✅ A new user can go from `git clone` to a working Telegram agent in under 10 minutes
2. ✅ The agent maintains conversational continuity across messages (session resume)
3. ✅ Scheduled tasks fire reliably with circuit breaker protection
4. ✅ One-shot tasks fire at the requested time and deliver results
5. ✅ Compound requests (3+ tasks) complete within the response window
6. ✅ "What was that SPX number?" works (session continuity)
7. ✅ Telegram formatting renders properly (Markdown→HTML conversion)
8. ✅ iMessage, email, calendar, and Granola work from daemon-spawned sessions
9. ✅ No text duplication in responses
10. ✅ Total runtime dependencies under 10

---

## 16. Lessons Learned

Decisions and fixes that emerged from 15+ onboarding test cycles. These are Tier 4 guardrails — future sessions shouldn't have to rediscover them.

### Architecture

- **Promise-based `send()`, not event emitters.** The original engine used `EventEmitter.emit("data")` for response delivery. When multiple messages arrived concurrently, `once("data")` listeners stacked on the shared session object. One `emit` fired ALL listeners — causing cross-talk, duplicate delivery, and lost responses. The fix: `send()` returns a `Promise<string>`. Each message has its own promise. No shared listeners, no stacking, no race conditions.

- **Protected windows are LLM context, not infrastructure enforcement.** Three iterations of getting this wrong. The scheduler does NOT check windows. Every task fires on schedule. Windows are passed to the agent as behavioral context — "don't proactively message during sleep hours." But user-scheduled tasks always run.

- **Deterministic startup in code, not in LLM.** Onboarding originally had 40 lines of bash that the LLM improvised differently each time. Moved all startup logic into `runPreflight()` in `maxos start` — deterministic, tested, same every time.

- **Pre-flight kills by port, not by name.** `pkill -f maxos` is fragile. `lsof -ti :18790 | xargs kill` always works. The zombie daemon bug — old daemon holding the port, new daemon crashing silently on EADDRINUSE — was the root cause of an entire test run's failures.

### Onboarding

- **SessionStart hook > CLAUDE.md instructions.** CLAUDE.md is a file the agent can choose to ignore. A `.claude/settings.json` SessionStart hook is injected into context before the agent's first response. ~50% onboarding failure rate became ~100% success rate with the hook.

- **Credential file guardrail.** Never touch `.enc` or `credentials.json` files. One test destroyed auth for all Google accounts by manipulating encrypted credential files. Safe actions: `auth status`, `auth login`, `+triage` verification.

- **FDA dual-grant.** Terminal FDA doesn't cascade to daemon's node process. Check the TCC database for the node binary's FDA status, not just protected path access from the current session.

### Runtime

- **10-minute timeouts, not 5.** Compound requests on Opus with web search routinely take 3-8 minutes. 5-minute timeout caused "still working" messages on every compound request. 10 minutes catches genuine hangs without false positives.

- **Late response delivery.** When timeout fires, the `send()` promise is still pending. When it eventually resolves, deliver as a follow-up message. Don't silently drop completed work.

- **Markdown→Telegram HTML.** Claude outputs Markdown. Telegram renders HTML. Without conversion, `**bold**` shows as literal asterisks. The adapter converts common patterns and falls back to plain text if parsing fails.

- **PATH enrichment for daemon subprocesses.** The daemon doesn't source `.zshrc`. Tools in `~/bin` (gws wrappers), nvm's bin dir (granola, maxos), and `/opt/homebrew/bin` must be explicitly added to the subprocess PATH.

- **`npm link` during onboarding.** Makes `maxos` CLI globally available so `maxos run-at` works from daemon-spawned Claude sessions.
