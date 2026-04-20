# Memory System

MaxOS uses a three-tier memory architecture to give the agent continuity across sessions, compactions, and restarts. Each tier trades immediacy for breadth.

## Tier 1: Context Window (Hot)

**What:** The full conversation transcript inside the active Claude CLI session.

**Where:** In-memory, managed by Claude Code.

**Lifespan:** Exists for the duration of one interactive session. Lost on session reset, compaction, or process death.

**How it works:** The `InteractiveSession` maintains a persistent Claude process via `--resume SESSION_ID`. Every message and response stays in the ~200K token context window until compaction. Questions like "what did I say 10 minutes ago?" are answered directly from context.

**Compaction bridge:** When the context window fills (~95%), Claude Code auto-compacts. MaxOS uses hooks to preserve context:

- **PreCompact hook** fires a prompt telling Claude to write a thorough summary to today's daily journal (Tier 2). Key decisions, in-progress tasks, commitments, current topic -- everything the future session needs to continue.
- **PostCompact hook** runs a shell script that re-injects critical operating rules into the fresh context.

## Tier 1.5: Task Memory Injection (Bridge)

**What:** Automatic memory prefix prepended to every scheduled-task prompt before the one-shot Claude process spawns.

**Where:** `src/memory.ts` — `buildMemoryContext()`. Called by `Gateway.runOneShot()` in `src/gateway.ts`.

**Lifespan:** Composed fresh on every task invocation.

**Why it exists:** Each scheduled task (morning brief, debrief, etc.) spawns a new Claude one-shot that doesn't inherit the interactive session's context. Without this bridge, the debrief at 4:35pm has no way to know the user texted someone at 4:20pm — it would re-raise that contact as ghosted. Task Memory Injection gives every one-shot the short-term context the interactive session accumulated.

**Four layers composed into `## Recent Memory Context`:**

1. **Today's closures** — contents of `memory/closures-YYYY-MM-DD.md` (append-only, written by the interactive session per SOUL.md rule)
2. **Yesterday's closures** — relevant for morning briefs / handoffs across days
3. **Dropped-loops** — `memory/dropped-loops.md` entries the user has explicitly retired
4. **QMD BM25 hits** — top-5 keyword matches against the task prompt, via `qmd search --json` (~500ms)

All four layers are optional. If the vault is empty or QMD is unavailable, `buildMemoryContext()` returns `""` and `runOneShot` falls through with the unmodified prompt. Any failure (missing binary, timeout, parse error) is swallowed silently — task execution never blocks on memory lookup.

**Why not Tier 3 (QMD vector search)?** Vector + rerank takes ~12 seconds per call. BM25 keyword (`qmd search`) is ~500ms. Interactive messages still use Tier 3 for deep semantic recall; tasks use Tier 1.5 because they fire on schedule and can't wait.

## Tier 2: Workspace Files (Warm)

**What:** Structured Markdown files in the workspace directory.

**Where:** `~/.maxos/workspace/`

**Lifespan:** Persists across sessions. Survives restarts, resets, and compaction.

### Key Files

| File | Purpose | Updated By |
|------|---------|------------|
| `SOUL.md` | Agent identity, personality, behavior rules, prime directives | Human (rarely changes) |
| `USER.md` | User profile, preferences, cognitive style, delegation rules | Human or agent |
| `MEMORY.md` | Curated persistent memory -- decisions, preferences, project context | Agent (proactively) |
| `memory/YYYY-MM-DD.md` | Daily journals -- conversation summaries, checkpoints, session notes | Agent (automatically) |

### Daily Journals

Four write mechanisms keep journals current:

1. **Periodic checkpoint** (HEARTBEAT.md, e.g. every 45 min) -- A one-shot task reads the current journal and appends a brief update. Keeps entries under 200 words.
2. **Pre-compaction flush** (PreCompact hook) -- Thorough summary written before context is lost.
3. **Session-end summary** (Stop hook) -- Wrap-up written when a conversation naturally ends.
4. **Closures log** (`memory/closures-YYYY-MM-DD.md`) -- Append-only file the interactive session writes to when the user confirms a closure, decision, or fact. SOUL.md instructs the agent to capture these in real time. Consumed by the daemon's task-memory injection (see Tier 1.5 below).

### Session Start Protocol

SOUL.md instructs the agent on boot:

1. MEMORY.md is already in context (loaded automatically by Claude Code from the workspace).
2. Read today's daily journal if it exists.
3. If today's doesn't exist, read yesterday's.
4. Don't announce what you've read -- just be informed by it.
5. If the user asks about something recent, check journals first.

### Rolling Cleanup

A monthly HEARTBEAT.md task moves journals older than 30 days to `memory/archive/`. Archived files remain searchable via QMD (Tier 3) but aren't loaded on session start.

## Tier 3: Vector Search (Cold)

**What:** A semantic search index over the entire workspace -- journals, memory, notes, task definitions, everything.

**Where:** QMD (local vector search engine) running as an MCP server.

**Lifespan:** Permanent. Indexes all workspace files and archived journals.

### How It Works

QMD provides three search strategies:

| Tool | Speed | Use Case |
|------|-------|----------|
| `qmd search` | ~30ms | Keyword/exact phrase matching |
| `qmd vector_search` | ~2s | Semantic similarity (finds concepts even with different vocabulary) |
| `qmd deep_search` | ~10s | Multi-strategy: auto-expands query, searches by keyword and meaning, reranks |

SOUL.md instructs the agent to use QMD when:
- The user asks about something from more than a few days ago
- Context about a project, person, or decision isn't in today's journal
- The agent is unsure about a preference or past conversation
- The user says "remember when..." or "what did we decide about..."

### Index Freshness

A daily scheduled task (typically 5:55 AM via HEARTBEAT.md) runs `qmd update && qmd embed` to re-index. New or modified files are picked up. Deleted files are removed from the index.

### Setup

QMD is configured as an MCP server in `~/.maxos/workspace/.mcp.json`. The `maxos init` onboarding flow sets this up automatically if QMD is installed. The `maxos doctor` command checks for QMD availability and offers to install it.

## Memory Flow: A Day in the Life

```
06:00 -- Daily session reset
  Session IDs cleared. Next message starts fresh.

06:01 -- User sends "good morning"
  Fresh InteractiveSession created.
  Claude reads MEMORY.md (auto-loaded from workspace).
  Claude reads today's journal per SOUL.md protocol.
  Agent is oriented with yesterday's context.

09:15 -- "What did we talk about earlier?"
  Answer is in the context window (Tier 1).

10:45 -- 45-minute checkpoint fires
  One-shot appends morning activity to today's journal (Tier 2).

11:30 -- "What did we decide about API pricing last month?"
  Not in context. Claude queries QMD (Tier 3).
  Finds the answer in an archived journal.

14:00 -- Context compaction triggers
  PreCompact: Claude writes thorough summary to journal.
  PostCompact: Critical rules re-injected.
  Claude reads today's updated journal, continues seamlessly.

16:25 -- Shutdown debrief fires
  Day's summary written to journal (Tier 2).
  Tomorrow's session will read this on boot.

05:55 next day -- QMD re-indexes
  Yesterday's journal is now searchable via semantic search (Tier 3).
```

## Workspace Directory Structure

```
~/.maxos/workspace/
  SOUL.md               Agent identity (Tier 2 -- loaded every session)
  USER.md               User profile (Tier 2 -- loaded every session)
  MEMORY.md             Curated memory (Tier 2 -- loaded every session)
  HEARTBEAT.md          Scheduled task definitions
  memory/
    2026-03-29.md       Today's journal (Tier 2)
    2026-03-28.md       Yesterday's journal (Tier 2)
    ...
    archive/            Journals older than 30 days (Tier 3 only)
  tasks/
    morning-brief.md    Task prompt files
    email-triage.md
    shutdown-debrief.md
  .claude/
    CLAUDE.md           Workspace rules (imports @../SOUL.md, @../USER.md)
    rules/              Guardrail files
    settings.json       Hooks (PreCompact, PostCompact, Stop)
```

## Design Rationale

**Why not just use a database?** Files are the API. Every memory artifact is human-readable, editable with any text editor, and version-controllable with git. No migration scripts, no schema changes, no vendor lock-in.

**Why three tiers?** Each tier optimizes for a different access pattern. Tier 1 is instant but ephemeral. Tier 2 is durable and fast to load but manually curated. Tier 3 is comprehensive but slower. The combination covers "what did you just say" through "what did we decide six months ago" without burning tokens on massive context windows.

**Why not stuff everything into the context window?** Token cost (even on subscription, context size affects latency) and relevance. A 200-word journal entry is more useful than 50K tokens of raw conversation history from two weeks ago.
