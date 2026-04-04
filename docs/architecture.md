# Architecture

MaxOS is a single Node.js daemon that orchestrates Claude CLI sessions, routes messages from channels, runs scheduled tasks, and manages state persistence. It delegates all LLM work to the `claude` CLI -- it never calls the API directly.

## Process Model

```
Telegram / Discord / [future channels]
         |
         v
+----------------------------+
|      MaxOS Daemon          |
|  (single Node.js process)  |
|                            |
|  Gateway                   |
|    |-- Channel Adapters    |
|    |-- Session Manager     |
|    |-- Engine (CLI mgr)    |
|    |-- Scheduler (cron)    |
|    |-- State Store         |
|    +-- Health Server       |
+----------------------------+
         |
         v
  claude CLI (subprocess)
  (subscription-powered)
```

All modules are initialized and owned by the **Gateway** (`gateway.ts`), which is the process entry point.

## Module Breakdown

| Module | File(s) | Role |
|--------|---------|------|
| Gateway | `gateway.ts` | Process lifecycle, signal handling, health check HTTP server, module wiring |
| Channel Adapters | `channels/adapter.ts`, `channels/telegram.ts` | Normalize inbound messages, serialize outbound replies, handle media downloads |
| Session Manager | `sessions.ts` | Route conversations to Claude sessions, identity linking across channels, activity tracking |
| Engine | `engine.ts` | Spawn and manage `claude` CLI subprocesses -- both interactive (long-lived) and one-shot (fire-and-forget) |
| Scheduler | `scheduler.ts` | Parse HEARTBEAT.md, register cron jobs, enforce protected time windows, circuit breaker |
| State Store | `state.ts` | Periodic snapshots to `state.json`, crash journal (append-only log), recovery on startup |
| Config | `config.ts` | Load `maxos.json` (JSON5), deep-merge with defaults, resolve `${ENV_VAR}` substitutions |

## Message Flow

### Inbound (User sends a Telegram message)

1. **TelegramAdapter** receives the message via grammY's polling loop.
2. Adapter validates the sender against `allowedUsers`. Unauthorized senders are dropped silently.
3. Adapter normalizes the message into an `InboundMessage` with `channelName`, `senderId`, `conversationId`, `text`, and optional `attachments`.
4. For media (photos, voice, documents, video), the adapter downloads the file to `~/.maxos/inbox/YYYY-MM-DD/` and populates the `Attachment` object with a local file path.
5. Adapter calls the registered `onMessage` handler, which routes to `Gateway.handleMessage()`.

### Processing (Gateway handles the message)

6. Gateway sends an immediate **acknowledgment** message back to the user ("On it.", "Working on that now.", etc.) and starts a typing indicator loop (every 4 seconds).
7. Gateway calls `SessionManager.route()` to determine which Claude session this conversation maps to, based on routing rules in `maxos.json`.
8. Gateway calls `buildPrompt()` to convert the `InboundMessage` into a prompt string:
   - Text messages pass through directly.
   - Images get `[The user sent an image. Downloaded to: /path. Use your Read tool to view it.]`
   - Voice/audio messages are **transcribed locally via Whisper** before being sent to Claude. The transcript text is injected inline.
   - Documents get path references for Claude to read via its Read tool.
9. If no `InteractiveSession` exists for this session name (or the previous one died), Gateway creates one.
10. Gateway calls `session.send(prompt)` and waits for the response (with a configurable `responseTimeout`).

### Engine (Claude CLI execution)

11. `InteractiveSession.send()` spawns a `claude` process with `--output-format stream-json` and `--verbose`. If a prior session ID exists, it passes `--resume SESSION_ID` to maintain conversation history.
12. stdout is parsed as newline-delimited JSON. The handler collects:
    - `system` events (captures the `session_id` for future `--resume`)
    - `assistant` events (collects response text from content blocks)
    - `content_block_delta` events (streaming text deltas)
13. A **watchdog timer** resets on every stdout chunk. If no output arrives for `watchdogTimeout` ms (default 5 min), the process is killed and a `watchdog` event fires.
14. When the process exits, the full response text is emitted via `data` event.
15. If messages arrived while the session was busy, they queue and are processed sequentially.

### Outbound (Response sent back)

16. Gateway receives the response text and sends it through the channel adapter.
17. The adapter uses `smartChunk()` to split long responses at paragraph/sentence boundaries (Telegram's limit is 4096 chars).
18. Each chunk is sent via the Telegram Bot API with HTML parse mode.

## Scheduled Tasks

### HEARTBEAT.md Parsing

The scheduler reads `~/.maxos/workspace/HEARTBEAT.md` and parses it into tasks:

- `## Every N minutes` / `## Every N hours` -- converted to cron expressions (`*/N * * * *`)
- `## 0 6 * * 0-5 (description)` -- raw 5-field cron used directly
- Bullet points under each heading become the task prompt

### Execution Pipeline

1. `node-cron` fires the job at the scheduled time.
2. Scheduler checks if the current time falls within any **protected window** (sleep, sabbath, date night). If yes, the task is skipped silently.
3. Scheduler checks if the task is **disabled** (circuit breaker tripped). If yes, skip.
4. Scheduler checks the **concurrency limit** (`maxConcurrentTasks`, default 1). If at capacity, skip.
5. The task prompt is passed to `Gateway.runOneShot()`, which calls `engine.oneShot()`.
6. `oneShot()` spawns `claude -p "PROMPT" --output-format text` via `child_process.execFile`. This is a stateless, fire-and-forget execution -- no session history, no resume.
7. If the output is non-empty, it is delivered to the user's primary channel (first healthy channel, first allowed user).
8. On success, the failure counter resets. On failure, it increments.

### Circuit Breaker

If a task fails `circuitBreakerThreshold` consecutive times (default 3):
- The task is disabled.
- The user receives an alert: `Task "X" disabled after 3 consecutive failures. Last error: ...`
- The task stays disabled until manually re-enabled via `maxos cron enable TASK_NAME`.

## State Management

### state.json

Written every `stateSnapshotInterval` ms (default 30 seconds). Contains:

- **sessions** -- map of session name to `{ claudeSessionId, lastActivity, messageCount }`
- **scheduler** -- `{ failures, disabled, lastRun }` per task
- **channels** -- health status and last message timestamp per channel

On startup, the daemon reads `state.json` to restore session IDs (for `--resume`), scheduler failure counts, and disabled task lists.

### Crash Journal

Append-only log at `~/.maxos/crash.log`. Each line is a JSON object with `ts`, `event`, and event-specific data. Events include:

- `daemon_start` / `daemon_stop`
- `session_created` (with `resume: true/false`)
- `watchdog_timeout`

Trimmed to the last `crashJournalMaxEntries` (default 100) on graceful shutdown.

## Session Management

### Routing Rules

Evaluated in order. First match wins:

```jsonc
{
  "routing": [
    { "match": { "conversationId": "topic:work" }, "session": "work" },
    { "match": { "channel": "telegram", "type": "dm" }, "session": "main" },
    { "default": true, "session": "main" }
  ]
}
```

Match keys: `conversationId` (exact), `channel` (adapter name), `type` (`dm` or `group`).

### Identity Links

Map the same person across channels to one session:

```jsonc
{
  "identityLinks": {
    "mark": ["telegram:8117092034", "discord:123456"]
  }
}
```

The session manager builds a reverse lookup so that messages from either channel resolve to the same identity.

### Daily Reset

At the configured time (default `04:00`), all session IDs are cleared. The next incoming message creates a fresh Claude session. The workspace files (SOUL.md, MEMORY.md, journals) provide continuity.

## Media Handling Pipeline

```
Telegram message with photo/voice/doc/video
  |
  v
TelegramAdapter.downloadFile()
  - Calls Telegram Bot API getFile()
  - Streams file to ~/.maxos/inbox/YYYY-MM-DD/<filename>
  - Returns Attachment { path, type, mimeType, filename, size }
  |
  v
Gateway.buildPrompt()
  - image: injects "[Downloaded to: /path — use Read tool]"
  - voice/audio: calls transcribeAudio() (local Whisper)
    - Success: injects "[Transcription: "text"]"
    - Failure: injects "[Audio saved to: /path]"
  - document: injects "[File: name. Downloaded to: /path. Use Read tool.]"
  - video: injects "[Video saved to: /path]"
  |
  v
Prompt string sent to Claude CLI
```

Voice transcription uses the local `whisper` CLI with the `base` model (configurable via `WHISPER_MODEL` env var). Runs with `--fp16 False` for CPU-only machines. 2-minute timeout per transcription.

## Health Check

An HTTP server listens on `healthCheckPort` (default 18790) at `127.0.0.1`. GET `/health` or `/healthz` returns:

```json
{
  "status": "ok",
  "uptime": 3600,
  "channels": [{ "name": "telegram", "healthy": true }],
  "sessions": ["main"]
}
```

## Graceful Shutdown

On SIGTERM or SIGINT:

1. Stop accepting new messages (`shuttingDown = true`).
2. Stop the state snapshot interval.
3. Close the health check server.
4. Stop all cron jobs.
5. Kill all interactive Claude sessions.
6. Disconnect all channel adapters.
7. Flush final state snapshot.
8. Write `daemon_stop` to crash journal and trim.
9. Exit 0.
