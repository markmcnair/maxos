# MaxOS

Personal AI agent runtime powered by Claude Code. One persistent daemon, zero API keys.

<!-- badges -->
![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)
![License MIT](https://img.shields.io/badge/license-MIT-blue)

## What is MaxOS?

MaxOS turns Claude Code into a persistent, always-on AI agent. It runs as a single Node.js daemon that manages Claude CLI sessions, routes messages from channels (Telegram, Discord, etc.), executes scheduled tasks via cron, and maintains three-tier memory across sessions. All you need is a Claude Code subscription — no API keys, no token billing.

## Quick Start

Paste this into [Claude Code](https://claude.ai/code):

```
Clone https://github.com/yourusername/maxos and set me up
```

That's it. Claude will clone the repo, walk you through setup as a conversation, and generate your workspace. No terminal required.

<details>
<summary>Manual setup (if you prefer)</summary>

```bash
git clone https://github.com/yourusername/maxos.git && cd maxos
npm install
npx maxos init
npx maxos start --foreground
```

`init` walks you through setup — bot tokens, identity files, schedule. `start --foreground` runs the daemon in your terminal so you can watch it boot.
</details>

## Architecture

```
Telegram / Discord / [channels]
         │
         ▼
┌─────────────────────────┐
│     MaxOS Daemon         │
│  (single Node.js process)│
│                          │
│  Channel ──► Session     │
│  Router      Manager     │
│     │          │         │
│  Scheduler   Engine      │
│  (cron)    (claude CLI)  │
│     │          │         │
│  State    ◄── Memory     │
│  Store       (3-tier)    │
└──────────────────────────┘
```

## Features

- **Telegram integration** — Full bot adapter via grammY with message chunking and rate limiting
- **Scheduled tasks** — Define recurring jobs in `HEARTBEAT.md` with cron syntax; the scheduler runs them automatically
- **Three-tier memory** — Hot (session), warm (workspace MEMORY.md), cold (vault-wide vector search)
- **Crash recovery** — State store with snapshots and crash journal; the daemon resumes where it left off
- **Protected time windows** — Define hours/days when the agent stays silent (Sabbath, date night, sleep)
- **Circuit breaker** — Failing tasks get automatically suspended after repeated errors
- **Pluggable channels** — Implement the `ChannelAdapter` interface to add any messaging platform
- **Service installer** — One command to register as a launchd (macOS) or systemd (Linux) service

## CLI Reference

| Command | Description |
|---------|-------------|
| `maxos init` | Interactive setup wizard — generates config, identity files, and schedule |
| `maxos start` | Start the daemon (add `--foreground` to run in terminal) |
| `maxos stop` | Gracefully stop the running daemon |
| `maxos status` | Show daemon status, uptime, active sessions, and scheduler state |
| `maxos logs` | Tail daemon logs (add `--lines N` to control output) |
| `maxos doctor` | Verify dependencies, config, and connectivity |
| `maxos install-service` | Register MaxOS as an OS-level service (auto-start on boot) |
| `maxos uninstall-service` | Remove the OS-level service registration |

## Configuration

MaxOS uses four files in your workspace root:

| File | Purpose |
|------|---------|
| `maxos.json` | Main config — channel tokens, engine settings, log level, state paths |
| `SOUL.md` | Agent identity — personality, voice, boundaries, prime directives |
| `USER.md` | User profile — preferences, cognitive style, delegation rules |
| `HEARTBEAT.md` | Scheduled tasks — cron expressions + task definitions in Markdown |

Run `maxos init` to generate all four with sensible defaults.

## Memory System

MaxOS maintains three tiers of memory:

1. **Hot** — In-session context. Lives in the Claude CLI process. Lost when the session ends.
2. **Warm** — `MEMORY.md` in the workspace root. Persists across sessions. The agent reads it on startup and writes to it proactively.
3. **Cold** — Full vault indexed via vector search (QMD or similar). Semantic retrieval across hundreds of documents.

The engine injects warm memory into every new session automatically. Cold memory is queried on demand when the agent needs deeper context.

## Requirements

- **Node.js 22+**
- **Claude Code CLI** with an active subscription (`claude` must be on your PATH)
- **Telegram bot token** (optional — only if using the Telegram channel)

## License

MIT — see [LICENSE](LICENSE).
