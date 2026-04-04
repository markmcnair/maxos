<p align="center">
  <img src="docs/banner.png" alt="MaxOS" width="700"/>
</p>

<p align="center">
  <strong>Turn your Claude Code subscription into a persistent AI agent you can text.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-22%2B-3b82f6?style=flat-square" alt="Node 22+"/>
  <img src="https://img.shields.io/badge/runtime_deps-7-3b82f6?style=flat-square" alt="7 dependencies"/>
  <img src="https://img.shields.io/badge/tests-72-3b82f6?style=flat-square" alt="72 tests"/>
  <img src="https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square" alt="MIT License"/>
</p>

<p align="center">
  <a href="https://cash.app/$markmcnair">
    <img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-$markmcnair-00C244?style=flat-square&logo=cashapp&logoColor=white" alt="Buy me a coffee"/>
  </a>
</p>

---

Runs on your Claude Code subscription via OAuth. No API keys. No token billing. If you have Claude Code on a Mac, that's all you need.

MaxOS is a Node.js daemon that sits between your messaging apps and the Claude CLI. Telegram routing, scheduled tasks, session memory, crash recovery. One process, always running.

## Quick start

Paste this into [Claude Code](https://claude.ai/code):

```
Clone https://github.com/markmcnair/maxos and set me up
```

Claude clones the repo, finds your tools, ports your existing automations, and starts the daemon. You just talk to it.

<details>
<summary>Manual setup</summary>

```bash
git clone https://github.com/markmcnair/maxos.git && cd maxos
npm install
npx maxos init       # Collects identity, personality, Telegram token
npx maxos setup      # Claude Code discovers your tools, wires everything
npx maxos start      # Starts the daemon with automatic pre-flight
```
</details>

## What it does

| | |
|---|---|
| **Telegram agent** | Message your AI from your phone. Text, voice memos, photos, documents. Conversations carry across sessions. |
| **Scheduled tasks** | Morning briefings, email triage, daily debriefs, relationship check-ins. Define them in Markdown with cron syntax. They fire on time and deliver results to Telegram. |
| **One-shot scheduling** | "Find the best AI post today and send it to me at 5pm." Fires once, delivers, cleans up. |
| **Three-tier memory** | In-session context, daily journals that survive resets, and semantic search across your whole workspace. Ask about a decision from last month and get an answer. |
| **Session continuity** | Send a compound request, come back an hour later, ask a follow-up. The agent remembers the whole thread. |
| **Crash recovery** | State snapshots every 30 seconds. Circuit breakers on failing tasks. Watchdog timers. If it crashes, it restarts and tells you what happened. |
| **Protected windows** | Sleep hours, Sabbath, date night. Tasks still fire on schedule, but the agent won't bother you with unsolicited ideas at 3am. |
| **Voice transcription** | Send a voice memo on Telegram. Whisper transcribes it locally, the agent reads the transcript. |

## How it works

```
You (Telegram)
     |
     v
+----------------------------+
|       MaxOS Daemon          |
|    (Node.js, always on)     |
|                             |
|  Telegram ----> Sessions    |
|  adapter        manager     |
|     |              |        |
|  Scheduler      Engine      |
|  (node-cron)  (claude CLI)  |
|     |              |        |
|  State Store <-- Memory     |
|               (3-tier)      |
+----------------------------+
     |
     v
  claude CLI
  (your subscription)
```

You message your agent on Telegram. The daemon routes it to a Claude CLI session running in `~/.maxos/workspace/`. Claude reads your SOUL.md, memory, rules, and tools. It responds. The daemon converts the Markdown to Telegram HTML and sends it back.

Scheduled tasks work the same way without the Telegram part. Cron fires, Claude runs the task in the workspace, output goes to your phone.

## Why not OpenClaw?

OpenClaw is being sunset by Claude Code. MaxOS was built as the replacement.

| | OpenClaw | MaxOS |
|---|---|---|
| Auth | API key (per-token billing) | Claude Code OAuth (subscription) |
| Dependencies | 200+ | 7 |
| Setup | Manual config files | "Clone and set me up" in Claude Code |
| Channels | 24 adapters | Telegram v1, pluggable interface for more |
| Scheduling | Basic cron | Cron + one-shot + circuit breakers |
| Memory | Single-tier | Three-tier (session, journal, semantic search) |
| Codebase | Large | ~3,000 lines of TypeScript |

Claude Code already does model routing, token management, context compaction, tool execution, MCP, and sandboxing. We don't rebuild any of it.

## CLI

```bash
maxos start                        # Start daemon (pre-flight runs automatically)
maxos stop                         # Stop daemon
maxos status                       # Health check
maxos restart                      # Stop + start

maxos cron list                    # See all scheduled tasks
maxos cron run morning-brief       # Fire one right now
maxos cron enable email-triage     # Re-enable after circuit breaker
maxos run-at "3:45pm" "Do X"      # One-shot future task

maxos config show                  # View config
maxos config set engine.model opus # Change a value
maxos logs -f                      # Follow daemon logs
maxos logs --crash                 # View crash journal
maxos doctor                       # Check dependencies + health
```

## Configuration

Four Markdown and JSON files in your workspace:

| File | What it is |
|------|-----------|
| `SOUL.md` | Agent personality, voice, behavioral rules |
| `USER.md` | Your profile, preferences, primary channel |
| `HEARTBEAT.md` | Cron schedules pointing to task files |
| `maxos.json` | Channels, engine settings, timeouts, protected windows |

Task definitions live in `workspace/tasks/`. Each task is a Markdown file with the full prompt. HEARTBEAT.md just has the cron schedule and a one-liner pointing to the task file.

`maxos init` generates all of them. The setup skill adjusts them based on what it finds on your machine.

## Memory system

The agent has three layers of memory:

1. The conversation itself. ~200K token context window inside the active Claude session, maintained via `--resume`.

2. Daily journals at `workspace/memory/YYYY-MM-DD.md`. A checkpoint task writes updates every 45 minutes. A pre-compaction hook saves context before it gets dropped. New sessions read today's journal on startup.

3. Semantic search via [QMD](https://github.com/tobi/qmd) across the whole workspace. "What did we decide about API pricing last month?" hits the vector index and pulls from archived journals, notes, whatever's been written.

## Requirements

- Node.js 22+
- Claude Code CLI with an active subscription
- macOS (Linux support is there but less tested)
- A Telegram bot token (create one via [@BotFather](https://t.me/BotFather))

**Optional:** [QMD](https://github.com/tobi/qmd) for Tier 3 memory search. [Whisper](https://github.com/openai/whisper) for voice transcription.

### macOS: Full Disk Access

The daemon needs FDA on your **node binary**, not just your terminal. Without it, iMessage and protected files work in Claude Code but fail silently in scheduled tasks.

System Settings > Privacy & Security > Full Disk Access > add the node binary. `which node` gives you the path. Cmd+Shift+G in the file picker to enter it.

One-time setup. The onboarding skill checks for this automatically.

## Migrating from OpenClaw or CCBot

The setup skill scans your machine for existing automations and ports them:

- OpenClaw `tasks/` directory
- Obsidian vault scheduled task files
- launchd agents (`~/Library/LaunchAgents/com.max.task-*`)
- CCBot config and tmux sessions
- Crontab entries

It reads every task file, preserves the full prompt, strips delivery instructions (the daemon handles delivery now), and writes them to `~/.maxos/workspace/tasks/` with matching HEARTBEAT.md cron entries.

## Contributing

PRs welcome. If Claude Code does something, we don't rebuild it.

```bash
npm test                           # 72 tests, node built-in runner
npx tsc                            # Type-check
```

The [design spec](docs/design-spec.md) has the full architecture breakdown and the lessons from building this.

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <a href="https://cash.app/$markmcnair">
    <img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-$markmcnair-00C244?style=for-the-badge&logo=cashapp&logoColor=white" alt="Buy me a coffee"/>
  </a>
</p>

<p align="center">
  Built by <a href="https://github.com/markmcnair">Mark McNair</a> and the agent this project created.
</p>
