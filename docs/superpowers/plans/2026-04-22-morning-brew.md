# Morning Brew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `tasks/ai-briefing.md` with a three-section daily "Morning Brew" (AI / Prime Framework Hit / Learning Breadcrumb), including an overnight builder pipeline that lets Max ship working prototypes while Mark sleeps.

**Architecture:** Follow MaxOS's existing "deterministic TS modules + orchestrating task markdown" pattern. Core state transitions, scoring, filtering, and API adapters live in `src/brew-*.ts` with `node:test` coverage. Task markdown files in `~/.maxos/workspace/tasks/` invoke those modules via Bash and use LLM reasoning for synthesis, deslop, and voice. Telegram reply capture bridges daily task sessions via a JSONL log written by a small patch to `src/channels/telegram.ts`. Overnight builds dispatch `frontend-builder` + `backend-builder` + `qa-tester` agents via the `Agent` tool inside `prime-scout.md`.

**Tech Stack:** TypeScript (Node 22, ESM), `node:test` + `node:assert/strict`, `grammy` (existing Telegram), `winston` (existing logger), Bash, `gws` CLI, `qmd`, `yt-dlp`, Vercel MCP, Claude Preview MCP, `Agent` tool for sub-agent dispatch, `Looper` / `deslop` / `simplify` / `verification-before-completion` skills.

**Reference spec:** [docs/superpowers/specs/2026-04-22-morning-brew-design.md](../specs/2026-04-22-morning-brew-design.md)

---

## File Structure Map

### New TypeScript modules (`~/Projects/maxos/src/`)

| File | Responsibility |
|---|---|
| `telegram-reply-logger.ts` | Pure function: given inbound `ChannelMessage`, append to JSONL if it has a `replyToId`. |
| `brew-state.ts` | Read/write `state.json` with a Zod-style schema validator. Pure functions for state transitions (advance-breadcrumb, rotate-topic, tick-streak). |
| `brew-reply-parser.ts` | Read `telegram-replies.jsonl`, find last reply to a given `msgId`, classify A/B/ambiguous. |
| `brew-covered-topics.ts` | Read/write `covered-topics.md`; keyword + fuzzy-match dedup check. |
| `brew-github-trending.ts` | Fetch `github.com/trending?since=daily`, filter by AI keywords, return candidates. |
| `brew-youtube-scorer.ts` | Wrap `yt-dlp` to pull view/like/subscriber counts; compute quality score. |
| `brew-archive.ts` | Write daily brew snapshot to `archive/YYYY-MM-DD.json`. |
| `brew-tuning-nudger.ts` | Read 7-day archive + feedback, propose tuning.md weight nudges. |

### New CLI entry points (compiled from TS → invoked from task markdown via Bash)

Each module also exports a `main()` function callable as `node dist/src/brew-<x>.js <args>`.

### New task markdown files (`~/.maxos/workspace/tasks/`)

| File | Schedule |
|---|---|
| `morning-brew.md` | `15 6 * * 0-5` |
| `prime-scout.md` | `0 22 * * 0-4,6 [timeout:360m]` |
| `weekly-brew-introspection.md` | `0 20 * * 0 [silent] [timeout:15m]` |
| `feedback/morning-brew/feedback.md` | (starter — no schedule) |

### New state files (`~/.maxos/workspace/memory/morning-brew/`)

- `state.json` — breadcrumb track, streak, last outbound msg_id, alternative_offered
- `covered-topics.md` — rolling 30-day anti-repeat log
- `tuning.md` — human-readable picker heuristics
- `prime-hit.json` — most recent scout output (candidate + prototype URL)
- `archive/YYYY-MM-DD.json` — daily snapshot

### Modified files

- `src/channels/telegram.ts` — invoke new reply logger on inbound messages with `replyToId`
- `~/.maxos/workspace/HEARTBEAT.md` — swap cron entries (remove ai-briefing; add brew + scout + introspection)
- `~/.maxos/workspace/MEMORY.md` — add one-line pointer to brew state files
- `~/.maxos/workspace/tasks/archive/` — move `ai-briefing.md` here

### Test files (`~/Projects/maxos/tests/`)

One test file per new TS module (following existing convention): `brew-state.test.ts`, `brew-reply-parser.test.ts`, `brew-covered-topics.test.ts`, `brew-github-trending.test.ts`, `brew-youtube-scorer.test.ts`, `brew-archive.test.ts`, `brew-tuning-nudger.test.ts`, `telegram-reply-logger.test.ts`.

---

## Phase 1 — Brew Shell (AI section only)

Foundation. Ships a working morning brew with just the AI section, the state directory, and the Telegram reply logger. Learning + Prime remain stubs until Phase 2/3.

### Task 1: Telegram reply logger (daemon change)

**Files:**
- Create: `~/Projects/maxos/src/telegram-reply-logger.ts`
- Create: `~/Projects/maxos/tests/telegram-reply-logger.test.ts`
- Modify: `~/Projects/maxos/src/channels/telegram.ts:~179` (hook into existing inbound path)

- [ ] **Step 1: Write the failing test**

Create `tests/telegram-reply-logger.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logTelegramReply, type ChannelMessageLike } from "../src/telegram-reply-logger.js";

describe("logTelegramReply", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "brew-reply-log-"));
    logPath = join(tmp, "telegram-replies.jsonl");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("appends a JSONL line when message has replyToId", () => {
    const msg: ChannelMessageLike = {
      messageId: "m2",
      conversationId: "dm:mark",
      text: "A",
      replyToId: "m1",
      timestamp: 1714000000000,
    };
    logTelegramReply(msg, logPath);
    const line = readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.msgId, "m2");
    assert.equal(parsed.replyToId, "m1");
    assert.equal(parsed.body, "A");
    assert.equal(parsed.ts, 1714000000000);
  });

  it("does NOT write when replyToId is absent", () => {
    const msg: ChannelMessageLike = {
      messageId: "m3",
      conversationId: "dm:mark",
      text: "hello",
      timestamp: 1714000000001,
    };
    logTelegramReply(msg, logPath);
    assert.equal(existsSync(logPath), false);
  });

  it("appends multiple lines across calls", () => {
    logTelegramReply({ messageId: "m2", conversationId: "dm:mark", text: "A", replyToId: "m1", timestamp: 1 }, logPath);
    logTelegramReply({ messageId: "m4", conversationId: "dm:mark", text: "B", replyToId: "m3", timestamp: 2 }, logPath);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/maxos && npm test -- tests/telegram-reply-logger.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/telegram-reply-logger.ts`:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ChannelMessageLike {
  messageId: string;
  conversationId: string;
  text?: string;
  replyToId?: string;
  timestamp: number;
}

export interface ReplyLogEntry {
  ts: number;
  msgId: string;
  replyToId: string;
  conversationId: string;
  body: string;
}

export function logTelegramReply(msg: ChannelMessageLike, logPath: string): void {
  if (!msg.replyToId) return;
  const entry: ReplyLogEntry = {
    ts: msg.timestamp,
    msgId: msg.messageId,
    replyToId: msg.replyToId,
    conversationId: msg.conversationId,
    body: msg.text ?? "",
  };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/maxos && npm test -- tests/telegram-reply-logger.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Hook into the inbound handler**

Modify `src/channels/telegram.ts`. Find the block ending near line 183 where `ChannelMessage` is assembled. Immediately after the `const msg: ChannelMessage = { ... }` block, add:

```typescript
import { logTelegramReply } from "../telegram-reply-logger.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ... existing imports stay

// ... inside the inbound handler, after the msg object is constructed:
try {
  const logPath = join(homedir(), ".maxos", "workspace", "memory", "telegram-replies.jsonl");
  logTelegramReply(msg, logPath);
} catch (err) {
  logger.warn("telegram:reply_log_failed", { error: err instanceof Error ? err.message : String(err) });
}
```

(Import lines go to the top of the file; the `try`/`catch` block goes right after `const msg: ChannelMessage = { ... }` assembly.)

- [ ] **Step 6: Verify build passes**

Run: `cd ~/Projects/maxos && npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/maxos
git add src/telegram-reply-logger.ts tests/telegram-reply-logger.test.ts src/channels/telegram.ts
git commit -m "$(cat <<'EOF'
Telegram reply logger — JSONL bridge across daily task sessions

Inbound Telegram messages with reply_to_message now append to
memory/telegram-replies.jsonl so scheduled tasks can read Mark's
A/B replies from the prior day's brew.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2: Brew state module

**Files:**
- Create: `~/Projects/maxos/src/brew-state.ts`
- Create: `~/Projects/maxos/tests/brew-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-state.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readBrewState,
  writeBrewState,
  emptyState,
  advanceBreadcrumb,
  rotateTopic,
  tickStreak,
  type BrewState,
} from "../src/brew-state.js";

describe("brew-state", () => {
  let tmp: string;
  let p: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "brew-state-"));
    p = join(tmp, "state.json");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("emptyState returns a fresh state", () => {
    const s = emptyState();
    assert.equal(s.current_track, null);
    assert.equal(s.new_topic_streak, 0);
    assert.equal(s.awaiting_response, false);
  });

  it("writes and reads state round-trip", () => {
    const s = emptyState();
    s.new_topic_streak = 3;
    writeBrewState(p, s);
    const loaded = readBrewState(p);
    assert.equal(loaded.new_topic_streak, 3);
  });

  it("readBrewState returns emptyState when file missing", () => {
    const s = readBrewState(p);
    assert.deepEqual(s, emptyState());
  });

  it("advanceBreadcrumb appends to delivered list and clears next_planned", () => {
    const s: BrewState = {
      ...emptyState(),
      current_track: {
        topic: "RAG",
        started: "2026-04-19",
        breadcrumbs_delivered: [],
        next_planned: { type: "video", intent: "first intro" },
      },
    };
    const updated = advanceBreadcrumb(s, {
      date: "2026-04-19",
      type: "video",
      url: "https://youtu.be/x",
      title: "RAG 101",
      why_picked: "top tier channel",
    });
    assert.equal(updated.current_track?.breadcrumbs_delivered.length, 1);
    assert.equal(updated.current_track?.next_planned, null);
  });

  it("rotateTopic promotes alternative and resets delivered", () => {
    const s: BrewState = {
      ...emptyState(),
      current_track: { topic: "RAG", started: "2026-04-19", breadcrumbs_delivered: [], next_planned: null },
      alternative_offered: { topic: "Vectors", one_line_pitch: "up next", why_picked: "QMD match" },
    };
    const updated = rotateTopic(s, "2026-04-22");
    assert.equal(updated.current_track?.topic, "Vectors");
    assert.equal(updated.current_track?.breadcrumbs_delivered.length, 0);
    assert.equal(updated.alternative_offered, null);
  });

  it("tickStreak increments on switch, resets on continue", () => {
    const s = { ...emptyState(), new_topic_streak: 2 };
    assert.equal(tickStreak(s, "switch").new_topic_streak, 3);
    assert.equal(tickStreak(s, "continue").new_topic_streak, 0);
    assert.equal(tickStreak(s, "hold").new_topic_streak, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-state.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `src/brew-state.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Breadcrumb {
  date: string;
  type: "video" | "article" | "tutorial" | "project" | "reading" | "advanced";
  url: string;
  title: string;
  why_picked: string;
}

export interface PlannedBreadcrumb {
  type: Breadcrumb["type"];
  intent: string;
}

export interface LearningTrack {
  topic: string;
  started: string;
  breadcrumbs_delivered: Breadcrumb[];
  next_planned: PlannedBreadcrumb | null;
}

export interface AlternativeTopic {
  topic: string;
  one_line_pitch: string;
  why_picked: string;
}

export interface BrewState {
  current_track: LearningTrack | null;
  alternative_offered: AlternativeTopic | null;
  last_outbound_msg_id: string | null;
  last_ab_question: string | null;
  new_topic_streak: number;
  awaiting_response: boolean;
  last_updated: string | null;
}

export function emptyState(): BrewState {
  return {
    current_track: null,
    alternative_offered: null,
    last_outbound_msg_id: null,
    last_ab_question: null,
    new_topic_streak: 0,
    awaiting_response: false,
    last_updated: null,
  };
}

export function readBrewState(path: string): BrewState {
  if (!existsSync(path)) return emptyState();
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  return { ...emptyState(), ...parsed };
}

export function writeBrewState(path: string, state: BrewState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function advanceBreadcrumb(state: BrewState, delivered: Breadcrumb): BrewState {
  if (!state.current_track) throw new Error("advanceBreadcrumb: no current_track");
  return {
    ...state,
    current_track: {
      ...state.current_track,
      breadcrumbs_delivered: [...state.current_track.breadcrumbs_delivered, delivered],
      next_planned: null,
    },
  };
}

export function rotateTopic(state: BrewState, today: string): BrewState {
  if (!state.alternative_offered) throw new Error("rotateTopic: no alternative_offered");
  return {
    ...state,
    current_track: {
      topic: state.alternative_offered.topic,
      started: today,
      breadcrumbs_delivered: [],
      next_planned: null,
    },
    alternative_offered: null,
  };
}

export function tickStreak(state: BrewState, choice: "continue" | "switch" | "hold"): BrewState {
  if (choice === "continue") return { ...state, new_topic_streak: 0 };
  if (choice === "switch") return { ...state, new_topic_streak: state.new_topic_streak + 1 };
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-state.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-state.ts tests/brew-state.test.ts
git commit -m "$(cat <<'EOF'
Brew state module — pure transitions for learning track + streak

Read/write state.json plus advance/rotate/tick helpers. All pure functions
so Phase 2 can wire them into the task markdown via CLI invocations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: GitHub trending fetcher

**Files:**
- Create: `~/Projects/maxos/src/brew-github-trending.ts`
- Create: `~/Projects/maxos/tests/brew-github-trending.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-github-trending.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTrendingHtml, filterByAIKeywords, type TrendingRepo } from "../src/brew-github-trending.js";

describe("parseTrendingHtml", () => {
  it("extracts repo title, description, stars-today from sample fragment", () => {
    const html = `
      <article class="Box-row">
        <h2 class="h3 lh-condensed">
          <a href="/user/repo">
            <span>user</span> / <span>repo</span>
          </a>
        </h2>
        <p class="col-9 color-fg-muted my-1 pr-4">Awesome LLM agent toolkit.</p>
        <span class="d-inline-block float-sm-right">1,234 stars today</span>
      </article>
    `;
    const repos = parseTrendingHtml(html);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].slug, "user/repo");
    assert.equal(repos[0].url, "https://github.com/user/repo");
    assert.equal(repos[0].description, "Awesome LLM agent toolkit.");
    assert.equal(repos[0].starsToday, 1234);
  });

  it("returns empty array for empty html", () => {
    assert.deepEqual(parseTrendingHtml(""), []);
  });
});

describe("filterByAIKeywords", () => {
  const repos: TrendingRepo[] = [
    { slug: "a/b", url: "https://github.com/a/b", description: "An LLM wrapper with RAG support.", starsToday: 100 },
    { slug: "c/d", url: "https://github.com/c/d", description: "Simple CLI for photo editing.", starsToday: 200 },
    { slug: "e/f", url: "https://github.com/e/f", description: "MCP server for Obsidian.", starsToday: 50 },
  ];

  it("keeps only repos matching AI keywords", () => {
    const filtered = filterByAIKeywords(repos);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.find(r => r.slug === "a/b"));
    assert.ok(filtered.find(r => r.slug === "e/f"));
  });

  it("is case-insensitive", () => {
    const filtered = filterByAIKeywords([
      { slug: "x/y", url: "u", description: "llm EVAL harness", starsToday: 0 },
    ]);
    assert.equal(filtered.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-github-trending.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-github-trending.ts`:

```typescript
export interface TrendingRepo {
  slug: string;         // "user/repo"
  url: string;          // "https://github.com/user/repo"
  description: string;
  starsToday: number;
}

const AI_KEYWORDS = [
  "llm", "rag", "agent", "mcp", "claude", "model", "embedding", "vector",
  "prompt", "inference", "fine-tun", "eval", "benchmark", "training",
  "dataset", "framework", "openai", "anthropic", "transformer", "neural",
];

export function parseTrendingHtml(html: string): TrendingRepo[] {
  const repos: TrendingRepo[] = [];
  // Each trending article is a Box-row. Use a non-greedy regex to split.
  const articleRegex = /<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];
    const hrefMatch = block.match(/<a\s+href="\/([^"]+)"/);
    if (!hrefMatch) continue;
    const slug = hrefMatch[1].trim();
    const descMatch = block.match(/<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch ? stripTags(descMatch[1]).trim() : "";
    const starsMatch = block.match(/([\d,]+)\s+stars? today/);
    const starsToday = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ""), 10) : 0;
    repos.push({
      slug,
      url: `https://github.com/${slug}`,
      description,
      starsToday,
    });
  }
  return repos;
}

export function filterByAIKeywords(repos: TrendingRepo[]): TrendingRepo[] {
  return repos.filter(r => {
    const blob = (r.description + " " + r.slug).toLowerCase();
    return AI_KEYWORDS.some(k => blob.includes(k));
  });
}

export async function fetchTrending(): Promise<TrendingRepo[]> {
  const res = await fetch("https://github.com/trending?since=daily", {
    headers: { "User-Agent": "Mozilla/5.0 (MaxOS brew)" },
  });
  if (!res.ok) throw new Error(`github trending fetch failed: ${res.status}`);
  const html = await res.text();
  return parseTrendingHtml(html);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const all = await fetchTrending();
    const ai = filterByAIKeywords(all);
    process.stdout.write(JSON.stringify(ai, null, 2));
  })().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-github-trending.test.ts`
Expected: PASS.

- [ ] **Step 5: Smoke test CLI against live GitHub**

Run: `cd ~/Projects/maxos && npm run build && node dist/src/brew-github-trending.js | head -40`
Expected: JSON array of AI-filtered trending repos (non-empty on most days).

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-github-trending.ts tests/brew-github-trending.test.ts
git commit -m "$(cat <<'EOF'
GitHub trending fetcher — AI-keyword-filtered candidates

Pure HTML parser + AI keyword filter with unit tests, plus a CLI entry
that the brew task invokes for fresh candidates each morning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4: Covered-topics anti-repeat module

**Files:**
- Create: `~/Projects/maxos/src/brew-covered-topics.ts`
- Create: `~/Projects/maxos/tests/brew-covered-topics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-covered-topics.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCoveredLog,
  isNearMatch,
  appendCovered,
  type CoveredEntry,
} from "../src/brew-covered-topics.js";

describe("parseCoveredLog", () => {
  it("parses one entry per line", () => {
    const md = `
2026-04-20 · github.com/a/b · [rag, vectors, llm]
2026-04-21 · https://example.com · [mcp, claude, tools]
`;
    const entries = parseCoveredLog(md);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0].keywords, ["rag", "vectors", "llm"]);
  });

  it("ignores blank lines and comments", () => {
    const md = `# comment\n\n2026-04-20 · url · [kw]\n`;
    assert.equal(parseCoveredLog(md).length, 1);
  });
});

describe("isNearMatch", () => {
  const entries: CoveredEntry[] = [
    { date: "2026-04-20", url: "https://github.com/a/b", keywords: ["rag", "vectors", "llm"] },
  ];

  it("matches if URL is identical", () => {
    assert.equal(isNearMatch("https://github.com/a/b", ["new", "keywords"], entries), true);
  });

  it("matches if 2+ keywords overlap", () => {
    assert.equal(isNearMatch("https://other.com", ["rag", "vectors", "fresh"], entries), true);
  });

  it("does NOT match on just one shared keyword", () => {
    assert.equal(isNearMatch("https://other.com", ["rag", "cats", "dogs"], entries), false);
  });
});

describe("appendCovered", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "covered-"));
    p = join(tmp, "covered-topics.md");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("appends a new line to the log", () => {
    appendCovered(p, { date: "2026-04-22", url: "https://g.com/x/y", keywords: ["a", "b", "c"] });
    const content = readFileSync(p, "utf-8");
    assert.ok(content.includes("2026-04-22 · https://g.com/x/y · [a, b, c]"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-covered-topics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-covered-topics.ts`:

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CoveredEntry {
  date: string;
  url: string;
  keywords: string[];
}

export function parseCoveredLog(md: string): CoveredEntry[] {
  const entries: CoveredEntry[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\d{4}-\d{2}-\d{2})\s+·\s+(\S+)\s+·\s+\[([^\]]+)\]/);
    if (!match) continue;
    entries.push({
      date: match[1],
      url: match[2],
      keywords: match[3].split(",").map(s => s.trim().toLowerCase()),
    });
  }
  return entries;
}

export function isNearMatch(
  candidateUrl: string,
  candidateKeywords: string[],
  entries: CoveredEntry[],
): boolean {
  const cks = new Set(candidateKeywords.map(s => s.toLowerCase()));
  for (const e of entries) {
    if (e.url === candidateUrl) return true;
    const overlap = e.keywords.filter(k => cks.has(k)).length;
    if (overlap >= 2) return true;
  }
  return false;
}

export function readCoveredLog(path: string): CoveredEntry[] {
  if (!existsSync(path)) return [];
  return parseCoveredLog(readFileSync(path, "utf-8"));
}

export function appendCovered(path: string, entry: CoveredEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${entry.date} · ${entry.url} · [${entry.keywords.join(", ")}]\n`;
  appendFileSync(path, line);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-covered-topics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-covered-topics.ts tests/brew-covered-topics.test.ts
git commit -m "$(cat <<'EOF'
Brew covered-topics log — anti-repeat dedup via URL + keyword overlap

30-day rolling log with simple parser, near-match detector (2+ shared
keywords OR identical URL), and append helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5: Seed state directory + starter files

**Files:**
- Create: `~/.maxos/workspace/memory/morning-brew/state.json` (starter)
- Create: `~/.maxos/workspace/memory/morning-brew/covered-topics.md` (starter)
- Create: `~/.maxos/workspace/memory/morning-brew/tuning.md` (v1 baseline)
- Create: `~/.maxos/workspace/memory/morning-brew/archive/.gitkeep`
- Create: `~/.maxos/workspace/tasks/feedback/morning-brew/feedback.md` (starter)

- [ ] **Step 1: Create state.json with empty schema**

```bash
mkdir -p ~/.maxos/workspace/memory/morning-brew/archive
cat > ~/.maxos/workspace/memory/morning-brew/state.json <<'EOF'
{
  "current_track": null,
  "alternative_offered": null,
  "last_outbound_msg_id": null,
  "last_ab_question": null,
  "new_topic_streak": 0,
  "awaiting_response": false,
  "last_updated": null
}
EOF
```

- [ ] **Step 2: Create covered-topics.md**

```bash
cat > ~/.maxos/workspace/memory/morning-brew/covered-topics.md <<'EOF'
# Covered Topics — Morning Brew Anti-Repeat Log

Rolling 30-day log. Each line: `YYYY-MM-DD · URL · [keyword1, keyword2, keyword3]`.
The brew checks this before picking an AI section winner; 2+ shared keywords or
identical URL within the last 30 days triggers dedup → fallback to next source.

Mark can add entries here manually to force dedup on a topic.
EOF
```

- [ ] **Step 3: Create tuning.md v1 baseline**

```bash
cat > ~/.maxos/workspace/memory/morning-brew/tuning.md <<'EOF'
# Morning Brew Tuning — v1.0

Updated by weekly introspection task (Sun 8pm). Mark can edit directly; his
edits win over algorithmic nudges.

## AI picker weights

- Claude / Anthropic / MCP specific: 1.0
- Business RAG / LLM wrapper: 0.9
- AI agent orchestration / multi-agent: 0.85
- Open-source model releases: 0.75
- AI coding tools (Cursor, Copilot, Cline): 0.7
- Dev-tooling MCP servers: 0.85
- AI infrastructure (inference runtimes, vector DBs): 0.75
- Consumer AI apps: 0.3
- AI policy / regulation: 0.2

## Prime Framework weights

- Automate Mark's recurring manual work: 1.0
- Remove friction from Emprise Growth ops: 0.95
- Templates Mark can apply to client work: 0.9
- Infrastructure under MaxOS itself: 0.85
- Family logistics automation: 0.7
- Personal finance / trading automation: 0.7

## Learning picker

- First breadcrumb on new topic: always YouTube video, 5–15 min
- Quality bar: views/subs > 5×, likes > 90%, upload < 6 months old
- Preferred channels: 3Blue1Brown, Fireship, Yannic Kilcher, Andrej Karpathy
- Avoid: consumer AI hype channels, "X killer" titles, faceless AI aggregators

## Engagement history

(populated by weekly introspection)

## This week's nudges

(populated by weekly introspection)
EOF
```

- [ ] **Step 4: Create feedback.md starter**

```bash
mkdir -p ~/.maxos/workspace/tasks/feedback/morning-brew
cat > ~/.maxos/workspace/tasks/feedback/morning-brew/feedback.md <<'EOF'
# Morning Brew — Feedback Log

Freeform corrections from Mark. Read by the brew on every run before picking.
Mark appends when something misses or hits hard; entries stay until Mark
archives them.

## Format

```
### YYYY-MM-DD — [brief topic]
[freeform note — "this was great, more like it" or "missed the mark because X"]
```

## Entries

(none yet)
EOF
```

- [ ] **Step 5: Create archive .gitkeep**

```bash
touch ~/.maxos/workspace/memory/morning-brew/archive/.gitkeep
```

- [ ] **Step 6: Verify layout**

Run: `ls ~/.maxos/workspace/memory/morning-brew/ && ls ~/.maxos/workspace/tasks/feedback/morning-brew/`

Expected: state.json, covered-topics.md, tuning.md, archive/ in the first; feedback.md in the second.

- [ ] **Step 7: Commit (workspace is not in the Projects repo — no commit needed)**

These files live in `~/.maxos/workspace/`, which is a separate user-data directory, not the MaxOS project repo. No git action for this task. Flag in the PR description that the workspace seeding must be replicated on fresh installs (add to `onboard.md` in Task 17 or a follow-up).

### Task 6: morning-brew.md task — AI section only

**Files:**
- Create: `~/.maxos/workspace/tasks/morning-brew.md`
- Modify: `~/.maxos/workspace/HEARTBEAT.md`
- Move: `~/.maxos/workspace/tasks/ai-briefing.md` → `~/.maxos/workspace/tasks/archive/ai-briefing-v1.md`
- Modify: `~/.maxos/workspace/MEMORY.md`

- [ ] **Step 1: Create the task file**

Write `~/.maxos/workspace/tasks/morning-brew.md`:

```markdown
# Morning Brew — Daily Three-Section Brief

You are Max delivering Mark's daily Morning Brew. This replaces the old AI briefing. 30-second read max. Every word earns its place.

## Voice & Quality Contract (read first — non-negotiable)

- Follow SOUL.md voice: strong opinions, no corporate openers, no disclaimer-stacking.
- Follow USER.md: brevity mandatory, one line per item where possible.
- Follow `memory/feedback_no_speculative_commentary.md`: NEVER editorialize about what Mark did or didn't do. Neutral facts only.
- Headlines are rewritten in Mark's voice — never copied from source titles.
- Before sending the final brew to Telegram, mentally run it through the `deslop` skill. If you spot em-dashes, "furthermore", "delve", adverb pile-ups, or any AI-tell, rewrite that section.

## Pre-flight

- Run `date +%u` — if result is `6` (Saturday), respond "Sabbath. No brew." and stop.
- Today's date: `date +%Y-%m-%d`.
- Read `tasks/feedback/morning-brew/feedback.md` — apply any active guidance before picking.

## Phase 1 — AI Section (this phase only, for now)

### Step 1: Check coverage log

Read `memory/morning-brew/covered-topics.md`. Load existing entries into your head — you'll dedup against these.

### Step 2: GitHub Trending first

Run: `cd ~/Projects/maxos && node dist/src/brew-github-trending.js 2>/dev/null`

This returns a JSON array of AI-keyword-filtered trending repos. Score the top 5 on:

- **Stack fit** (1–5) — Claude Code, MCP, Node/TS, Python, Notion/Obsidian, Granola, gws
- **Active project fit** (1–5) — Emprise Growth, Kingdom Coffee Roasters, business-brain RAG, Options Omega, MaxOS
- **Actionable today** (1–5) — can Mark install/use/fork today
- **Novelty** (1–5) — 5 if unique, 1 if near-match to covered-topics.md (use 2+ keyword overlap rule)

Weighted: `(stack × 0.35) + (active × 0.30) + (actionable × 0.20) + (novelty × 0.15)`.

### Step 3: Confidence gate

If the top GitHub candidate's weighted score ≥ 3.8 AND its URL + 3 keywords are NOT a near-match to covered-topics entries → **it wins**. Skip the fallback chain.

### Step 4: Fallback chain (only if GitHub fails gate)

Try each in order; first to score ≥ 3.8 wins:

1. **X / Twitter** — `WebSearch` for `"AI OR Claude OR LLM site:x.com OR site:twitter.com" past 24h`. Look for researcher/founder threads with high engagement.
2. **YouTube** — `WebSearch` for AI channels with fresh uploads. Score via `yt-dlp` (Task 11 wires this in — for Phase 1 just use view-count heuristic from search snippet).
3. **Hacker News** — `curl -s "https://hn.algolia.com/api/v1/search?tags=front_page&query=AI&numericFilters=created_at_i>$(date -v-1d +%s)"` and pick highest-point AI post.
4. **Reddit** — `curl -s "https://www.reddit.com/r/LocalLLaMA/top.json?t=day&limit=10" -H "User-Agent: MaxOS brew"`. Pick highest-upvote post.
5. **Product Hunt** — `WebFetch` on producthunt.com top of the day; filter for AI category.

### Step 5: Log the winner

Append to `memory/morning-brew/covered-topics.md`:

`YYYY-MM-DD · <URL> · [kw1, kw2, kw3]`

(Three most distinctive keywords from the candidate.)

### Step 6: Assemble AI section output

```
🧠 AI
[Rewritten headline — tell Mark why HE should care]
[2 sentences: what it is + why it matters to your active work specifically]
→ Action: [one specific thing Mark could do today]
Source: [URL] · [signal, e.g., "3.2k stars today · trending #2"]
```

## Phase 2 — Learning Section

**Not yet implemented.** Skip this section for now.

## Phase 3 — Prime Framework Hit

**Not yet implemented.** If `memory/morning-brew/prime-hit.json` exists, mention briefly: "Prime scout didn't run yet — coming soon." Otherwise omit.

## Deliver

Output the brew to Mark, starting with:

```
☕️ Morning Brew — [Day, Mon DD]

```

Then the AI section from Step 6. Keep it tight.

## Weak signal fallback

If NO source clears the gate today: deliver the brew with an honest "Light AI day — nothing cleared the bar. [One line of what you did see, if anything]." Don't pad.

## Rules — non-negotiable

- NEVER run on Saturday (`date +%u` == 6).
- NEVER fabricate URLs — every link must come from a real fetch.
- NEVER pad — if one section is weak, deliver it short.
- NEVER editorialize about Mark's actions.
- Run brew draft through deslop mental check before send.
```

- [ ] **Step 2: Archive old ai-briefing.md**

```bash
mkdir -p ~/.maxos/workspace/tasks/archive
mv ~/.maxos/workspace/tasks/ai-briefing.md ~/.maxos/workspace/tasks/archive/ai-briefing-v1.md
```

- [ ] **Step 3: Update HEARTBEAT.md — replace ai-briefing entry**

Use `Edit` to replace the block in `~/.maxos/workspace/HEARTBEAT.md`:

Old:
```
## 15 6 * * 0-5
- Run the AI briefing: read tasks/ai-briefing.md and execute every step
```

New:
```
## 15 6 * * 0-5
- Run morning brew: read tasks/morning-brew.md and execute every step
```

- [ ] **Step 4: Add MEMORY.md pointer**

Append to `~/.maxos/workspace/MEMORY.md`:

```
- Morning Brew state lives at `memory/morning-brew/` — state.json, covered-topics.md, tuning.md, archive/. Tasks: morning-brew.md (06:15), prime-scout.md (22:00, Phase 3), weekly-brew-introspection.md (Sun 20:00, Phase 4).
```

- [ ] **Step 5: Smoke test — run brew manually**

Run: `claude -p "$(cat ~/.maxos/workspace/tasks/morning-brew.md)"`

Expected: a three-section brew output with only the AI section populated, Learning skipped, Prime absent. No crashes. Output should be compact (≤ 15 lines).

- [ ] **Step 6: Commit maxos project changes (if any — only the archive move via a workspace-side PR later)**

The workspace isn't in the Projects repo. No git commit for this task on the project side. Note the workspace changes for handoff:

```
Workspace changes (not committed — user data):
- tasks/morning-brew.md (created)
- tasks/archive/ai-briefing-v1.md (moved from tasks/)
- HEARTBEAT.md (ai-briefing → morning-brew cron swap)
- MEMORY.md (brew pointer added)
```

---

## Phase 2 — Learning Breadcrumb

### Task 7: Brew reply parser

**Files:**
- Create: `~/Projects/maxos/src/brew-reply-parser.ts`
- Create: `~/Projects/maxos/tests/brew-reply-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-reply-parser.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findReplyTo,
  classifyReply,
  type ReplyChoice,
} from "../src/brew-reply-parser.js";

describe("classifyReply", () => {
  it("recognizes A / continue / yes as continue", () => {
    assert.equal(classifyReply("A"), "continue");
    assert.equal(classifyReply("a"), "continue");
    assert.equal(classifyReply("continue"), "continue");
    assert.equal(classifyReply("yes"), "continue");
    assert.equal(classifyReply("Continue RAG track"), "continue");
  });

  it("recognizes B / new / switch as switch", () => {
    assert.equal(classifyReply("B"), "switch");
    assert.equal(classifyReply("b"), "switch");
    assert.equal(classifyReply("switch"), "switch");
    assert.equal(classifyReply("new topic please"), "switch");
  });

  it("returns ambiguous for unknown replies", () => {
    assert.equal(classifyReply("hmm not sure"), "ambiguous");
    assert.equal(classifyReply(""), "ambiguous");
  });
});

describe("findReplyTo", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reply-parser-"));
    p = join(tmp, "telegram-replies.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("finds most recent reply to a given msgId", () => {
    writeFileSync(p, [
      JSON.stringify({ ts: 1, msgId: "r1", replyToId: "m1", conversationId: "dm", body: "A" }),
      JSON.stringify({ ts: 2, msgId: "r2", replyToId: "m1", conversationId: "dm", body: "B" }),
      JSON.stringify({ ts: 3, msgId: "r3", replyToId: "m2", conversationId: "dm", body: "A" }),
    ].join("\n") + "\n");
    const found = findReplyTo(p, "m1");
    assert.equal(found?.body, "B");
    assert.equal(found?.ts, 2);
  });

  it("returns null when no reply", () => {
    writeFileSync(p, JSON.stringify({ ts: 1, msgId: "r1", replyToId: "other", conversationId: "dm", body: "A" }) + "\n");
    assert.equal(findReplyTo(p, "m1"), null);
  });

  it("returns null when file missing", () => {
    assert.equal(findReplyTo("/nonexistent", "m1"), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-reply-parser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-reply-parser.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import type { ReplyLogEntry } from "./telegram-reply-logger.js";

export type ReplyChoice = "continue" | "switch" | "ambiguous";

export function classifyReply(body: string): ReplyChoice {
  const t = body.trim().toLowerCase();
  if (!t) return "ambiguous";
  if (/^(a\b|continue|yes|go|keep)/i.test(t)) return "continue";
  if (/^(b\b|new|switch|change)/i.test(t)) return "switch";
  return "ambiguous";
}

export function findReplyTo(path: string, targetMsgId: string): ReplyLogEntry | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  let latest: ReplyLogEntry | null = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ReplyLogEntry;
      if (entry.replyToId === targetMsgId) {
        if (!latest || entry.ts > latest.ts) latest = entry;
      }
    } catch {
      continue;
    }
  }
  return latest;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const msgId = process.argv[2];
  const path = process.argv[3] ?? `${process.env.HOME}/.maxos/workspace/memory/telegram-replies.jsonl`;
  if (!msgId) {
    console.error("usage: brew-reply-parser <msgId> [path]");
    process.exit(1);
  }
  const reply = findReplyTo(path, msgId);
  if (!reply) {
    console.log(JSON.stringify({ found: false }));
  } else {
    console.log(JSON.stringify({ found: true, choice: classifyReply(reply.body), body: reply.body, ts: reply.ts }));
  }
}
```

- [ ] **Step 4: Verify passing**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-reply-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-reply-parser.ts tests/brew-reply-parser.test.ts
git commit -m "$(cat <<'EOF'
Brew reply parser — classify A/B from Telegram reply JSONL

Reads telegram-replies.jsonl, finds most recent reply to a given outbound
msg_id, classifies body as continue/switch/ambiguous.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8: YouTube quality scorer

**Files:**
- Create: `~/Projects/maxos/src/brew-youtube-scorer.ts`
- Create: `~/Projects/maxos/tests/brew-youtube-scorer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-youtube-scorer.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreVideo, parseDuration, meetsQualityBar } from "../src/brew-youtube-scorer.js";

describe("parseDuration", () => {
  it("parses HH:MM:SS and MM:SS", () => {
    assert.equal(parseDuration("10:30"), 630);
    assert.equal(parseDuration("1:05:00"), 3900);
    assert.equal(parseDuration("45"), 45);
  });
});

describe("scoreVideo", () => {
  it("scores high on good views:subs ratio and like ratio", () => {
    const s = scoreVideo({
      views: 1_000_000,
      likes: 50_000,
      subscribers: 100_000,
      durationSec: 600,
      uploadDate: "20260101",
      title: "RAG explained",
    });
    assert.ok(s.score >= 4.0, `expected >= 4.0, got ${s.score}`);
    assert.ok(s.viewToSubRatio >= 5);
  });

  it("scores low when views:subs < 1 (subscriber echo chamber)", () => {
    const s = scoreVideo({
      views: 50_000,
      likes: 3_000,
      subscribers: 200_000,
      durationSec: 600,
      uploadDate: "20260101",
      title: "Foo",
    });
    assert.ok(s.score < 3.5);
  });
});

describe("meetsQualityBar", () => {
  it("rejects videos older than 6 months", () => {
    const oldUpload = "20250101";
    const pass = meetsQualityBar(
      { views: 10_000_000, likes: 500_000, subscribers: 1_000_000, durationSec: 600, uploadDate: oldUpload, title: "x" },
      new Date("2026-04-22"),
    );
    assert.equal(pass, false);
  });

  it("accepts videos with good metrics and recent upload", () => {
    const pass = meetsQualityBar(
      { views: 5_000_000, likes: 300_000, subscribers: 500_000, durationSec: 600, uploadDate: "20260301", title: "x" },
      new Date("2026-04-22"),
    );
    assert.equal(pass, true);
  });

  it("rejects videos outside 5–15 min window", () => {
    const pass = meetsQualityBar(
      { views: 5_000_000, likes: 300_000, subscribers: 500_000, durationSec: 60, uploadDate: "20260301", title: "x" },
      new Date("2026-04-22"),
    );
    assert.equal(pass, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-youtube-scorer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-youtube-scorer.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VideoMetrics {
  views: number;
  likes: number;
  subscribers: number;
  durationSec: number;
  uploadDate: string; // "YYYYMMDD"
  title: string;
}

export interface VideoScore {
  score: number;         // 0–5
  viewToSubRatio: number;
  likeRatio: number;
  breakdown: { factor: string; weight: number; value: number }[];
}

export function parseDuration(d: string): number {
  const parts = d.split(":").map(Number).reverse();
  let sec = 0;
  if (parts[0]) sec += parts[0];
  if (parts[1]) sec += parts[1] * 60;
  if (parts[2]) sec += parts[2] * 3600;
  return sec;
}

export function scoreVideo(m: VideoMetrics): VideoScore {
  const viewToSubRatio = m.subscribers > 0 ? m.views / m.subscribers : 0;
  const likeRatio = m.views > 0 ? m.likes / m.views : 0;

  // Normalize each to 0–5
  const viewScore = Math.min(5, viewToSubRatio / 2);      // 10× ratio = 5
  const likeScore = Math.min(5, likeRatio * 100);         // 5% likes = 5 (YouTube norm ~2–5%)
  const durationScore = m.durationSec >= 300 && m.durationSec <= 900 ? 5 : 2;

  const score = viewScore * 0.5 + likeScore * 0.3 + durationScore * 0.2;

  return {
    score: Math.round(score * 100) / 100,
    viewToSubRatio,
    likeRatio,
    breakdown: [
      { factor: "views:subs", weight: 0.5, value: viewScore },
      { factor: "like ratio", weight: 0.3, value: likeScore },
      { factor: "duration fit", weight: 0.2, value: durationScore },
    ],
  };
}

export function meetsQualityBar(m: VideoMetrics, today: Date): boolean {
  // Upload within last 6 months
  const uy = parseInt(m.uploadDate.slice(0, 4));
  const um = parseInt(m.uploadDate.slice(4, 6));
  const ud = parseInt(m.uploadDate.slice(6, 8));
  const uploaded = new Date(uy, um - 1, ud);
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  if (uploaded < sixMonthsAgo) return false;

  // 5–15 min
  if (m.durationSec < 300 || m.durationSec > 900) return false;

  // view:sub >= 5×
  if (m.subscribers > 0 && m.views / m.subscribers < 5) return false;

  // like ratio >= 0.9% (YouTube's ~90%+ "likes" was on old up/down system;
  // modern proxy: like/view >= 0.9% i.e. 90+ likes per 10k views)
  if (m.views > 0 && m.likes / m.views < 0.009) return false;

  return true;
}

export async function fetchMetrics(videoUrl: string): Promise<VideoMetrics> {
  const fmt = "%(view_count)s\t%(like_count)s\t%(channel_follower_count)s\t%(duration)s\t%(upload_date)s\t%(title)s";
  const { stdout } = await execFileAsync("yt-dlp", [
    "--print", fmt,
    "--skip-download",
    "--no-warnings",
    videoUrl,
  ], { timeout: 20_000 });
  const [views, likes, subs, dur, up, title] = stdout.trim().split("\t");
  return {
    views: parseInt(views, 10),
    likes: parseInt(likes, 10),
    subscribers: parseInt(subs, 10),
    durationSec: parseInt(dur, 10),
    uploadDate: up,
    title,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: brew-youtube-scorer <youtube-url>");
    process.exit(1);
  }
  fetchMetrics(url).then(m => {
    const s = scoreVideo(m);
    const passes = meetsQualityBar(m, new Date());
    console.log(JSON.stringify({ url, metrics: m, score: s, passes_bar: passes }, null, 2));
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Verify tests pass**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-youtube-scorer.test.ts`
Expected: PASS.

- [ ] **Step 5: Smoke test CLI against a known video**

Run: `cd ~/Projects/maxos && npm run build && node dist/src/brew-youtube-scorer.js "https://www.youtube.com/watch?v=TgaxrYBJnIk"`

Expected: JSON with metrics, score, passes_bar boolean. (Requires `yt-dlp` installed: `brew install yt-dlp` if missing.)

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-youtube-scorer.ts tests/brew-youtube-scorer.test.ts
git commit -m "$(cat <<'EOF'
YouTube quality scorer — yt-dlp wrapper + signal-weighted score

Pulls view/like/subscriber metrics via yt-dlp, computes a 0–5 score
(views:subs dominant), and a binary quality bar (5–15min, <6mo old,
>=5× view:sub, >=0.9% like:view).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 9: Add Learning section to morning-brew.md

**Files:**
- Modify: `~/.maxos/workspace/tasks/morning-brew.md`

- [ ] **Step 1: Replace the Phase 2 stub with the full Learning section**

Use `Edit` to replace this block in `~/.maxos/workspace/tasks/morning-brew.md`:

Old:
```
## Phase 2 — Learning Section

**Not yet implemented.** Skip this section for now.
```

New:
```
## Phase 2 — Learning Section

### Step 1: Read state + parse yesterday's reply

```bash
STATE=~/.maxos/workspace/memory/morning-brew/state.json
LAST_MSG_ID=$(jq -r '.last_outbound_msg_id // empty' $STATE)
AWAITING=$(jq -r '.awaiting_response' $STATE)

if [ -n "$LAST_MSG_ID" ] && [ "$AWAITING" = "true" ]; then
  REPLY_JSON=$(node ~/Projects/maxos/dist/src/brew-reply-parser.js "$LAST_MSG_ID")
else
  REPLY_JSON='{"found":false}'
fi
echo "$REPLY_JSON"
```

Parse the JSON: if `found && choice === "continue"` → continue current track. If `found && choice === "switch"` → rotate topic using the pre-picked `alternative_offered`. If `ambiguous` → ask Mark to clarify in today's brew, don't advance. If `!found` → hold (no streak change).

### Step 2: Streak warning check

```bash
STREAK=$(jq -r '.new_topic_streak' $STATE)
if [ "$STREAK" -ge 5 ]; then
  echo "WARNING_BLOCK=⚠️ 5 days of new topics — my picker is weak. What DO you want to learn?"
fi
```

If the warning fires, it prepends the Learning section in the final output.

### Step 3: Pick today's breadcrumb

- If continuing: use `current_track.next_planned`.
- If rotating: promote `alternative_offered` to `current_track` (topic, started=today, delivered=[], next_planned=null). Today's delivery is the FIRST breadcrumb on this new track → must be a YouTube video.
- If no current_track at all (fresh start): pick a starter topic from `tuning.md` + QMD signal on Mark's hot threads. First breadcrumb = YouTube video.

**First-breadcrumb YouTube pick:**

1. Search for candidate videos on the topic via `WebSearch` or `WebFetch` on YouTube search.
2. For each candidate, score via `node dist/src/brew-youtube-scorer.js <url>`.
3. Take the top candidate whose `passes_bar === true`. If none, loosen the bar one notch (e.g., allow 15→20 min) and try again. If still none, pick the highest-scoring and note "no candidate fully passed bar."

**Non-first breadcrumb:** progression is video → article/tutorial → hands-on project → deeper reading → advanced. Picker selects type based on `breadcrumbs_delivered.length`.

### Step 4: Pre-pick tomorrow's alternative

Tomorrow's A/B must be concrete on both sides. Pick `alternative_offered` for state.json now:

- Use `tuning.md` preferred topics list minus current track's topic
- QMD query: "things Mark has been thinking about recently that aren't `<current track topic>`"
- Write `{topic, one_line_pitch, why_picked}` to state

### Step 5: Write state

```bash
# Pseudocode — in the task, use jq or a small inline script to produce:
# - updated current_track (with today's delivered breadcrumb appended)
# - new alternative_offered
# - last_ab_question set
# - new_topic_streak ticked per classify result
# - awaiting_response = true
# - last_updated = now
# last_outbound_msg_id will be filled in AFTER the brew is sent (Step 7)
```

### Step 6: Assemble Learning section

```
[WARNING_BLOCK if streak >= 5, else empty]
📚 Learning — [current_track.topic] (day N)
[one-line description of what this breadcrumb gives Mark]
→ [URL] · [quality metrics, e.g., "4.8M views · 98% likes · 3Blue1Brown"]

Continue [current_track.topic] or switch to [alternative_offered.topic] ([alternative_offered.one_line_pitch])? Reply A or B.
```

Day count `N` = `breadcrumbs_delivered.length` (including today's).

### Step 7: Capture outbound Telegram message ID after send

The daemon delivers brew output to Telegram and logs the outbound message ID. After send, read the daemon's outbound log (location: `~/.maxos/daemon.log` — grep for `telegram:sent` with today's timestamp), extract the returned `message_id`, and write it to `state.json` as `last_outbound_msg_id`.

(Phase 2 implementation note: if the daemon doesn't yet expose outbound message IDs back to the task, add a small shim in a follow-up task — see Phase 2.5 in the plan. For now, document this dependency clearly in the task output so manual verification catches any regression.)
```

- [ ] **Step 2: Smoke test**

Run: `claude -p "$(cat ~/.maxos/workspace/tasks/morning-brew.md)"`

Expected: brew now includes a Learning section (may be empty on first run since no current_track exists yet — task should handle this by picking a fresh starter topic).

- [ ] **Step 3: No git commit (workspace changes only)**

### Task 10: Capture outbound message ID (daemon shim)

**Files:**
- Modify: `~/Projects/maxos/src/channels/telegram.ts` (capture and persist outbound message_id)
- Modify: `~/Projects/maxos/src/engine.ts` or the scheduler path that invokes tasks — expose the captured ID to the task context OR write to a known-location file the task can read

**Rationale:** morning-brew needs yesterday's outbound msg_id to find today's reply. The daemon already receives a `message_id` back from Telegram on send but doesn't expose it. We need a tiny shim.

- [ ] **Step 1: Test — write the failing test**

Create `tests/brew-outbound-capture.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordOutboundId } from "../src/brew-outbound-capture.js";

describe("recordOutboundId", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "outbound-"));
    p = join(tmp, "outbound-ids.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("records task name + message_id + timestamp", () => {
    recordOutboundId(p, { task: "morning-brew", messageId: "m123", ts: 1714000000000 });
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.task, "morning-brew");
    assert.equal(parsed.messageId, "m123");
  });

  it("appends across calls", () => {
    recordOutboundId(p, { task: "morning-brew", messageId: "m1", ts: 1 });
    recordOutboundId(p, { task: "morning-brew", messageId: "m2", ts: 2 });
    assert.equal(readFileSync(p, "utf-8").trim().split("\n").length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-outbound-capture.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the recorder**

Create `src/brew-outbound-capture.ts`:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface OutboundRecord {
  task: string;
  messageId: string;
  ts: number;
}

export function recordOutboundId(path: string, rec: OutboundRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}

export function findLatestForTask(path: string, task: string, linesContent: string): OutboundRecord | null {
  let latest: OutboundRecord | null = null;
  for (const line of linesContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as OutboundRecord;
      if (r.task === task && (!latest || r.ts > latest.ts)) latest = r;
    } catch { continue; }
  }
  return latest;
}
```

- [ ] **Step 4: Hook into the daemon's send path**

Locate the code in `src/channels/telegram.ts` that sends a message and returns (look for the `sendText` or equivalent method — a `logger.info("telegram:sent", ...)` call probably exists near the message_id). Add:

```typescript
import { recordOutboundId } from "../brew-outbound-capture.js";
import { homedir } from "node:os";
import { join } from "node:path";

// After successful send, inside the success path:
const outboundPath = join(homedir(), ".maxos", "workspace", "memory", "outbound-ids.jsonl");
try {
  recordOutboundId(outboundPath, {
    task: taskName ?? "unknown",  // daemon passes current task name into send if possible
    messageId: String(result.message_id),
    ts: Date.now(),
  });
} catch (err) {
  logger.warn("telegram:outbound_capture_failed", { error: err instanceof Error ? err.message : String(err) });
}
```

If the send function doesn't currently receive `taskName`, thread it through — track back through the scheduler → engine → channel calls to add a `taskName` parameter.

- [ ] **Step 5: Verify tests + build pass**

Run: `cd ~/Projects/maxos && npm test && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 6: Update morning-brew.md Step 7 to read from this log**

Replace the "capture outbound ID" step in the task with:

```bash
# After the brew has been assembled and printed, the daemon sends it.
# On the next run, read the latest outbound for this task:
node -e "
const { findLatestForTask } = require('$HOME/Projects/maxos/dist/src/brew-outbound-capture.js');
const fs = require('node:fs');
const content = fs.readFileSync('$HOME/.maxos/workspace/memory/outbound-ids.jsonl', 'utf-8');
const r = findLatestForTask('ignored', 'morning-brew', content);
console.log(r ? r.messageId : '');
"
```

Use this value when writing `last_outbound_msg_id` — note that for any given run, the ID is captured by the daemon AFTER the brew's markdown is delivered, so the first run's state file will have the PREVIOUS brew's outbound ID. Today's outbound ID becomes the next run's "last".

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-outbound-capture.ts tests/brew-outbound-capture.test.ts src/channels/telegram.ts
git commit -m "$(cat <<'EOF'
Outbound capture — persist Telegram message_id for daily reply lookup

Records every task-originated outbound Telegram message_id to
outbound-ids.jsonl so tomorrow's brew can locate yesterday's outbound
and greppable reply.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Prime Scout + Overnight Builder

### Task 11: Prime candidate hunter (source scanners + scoring)

**Files:**
- Create: `~/Projects/maxos/src/brew-prime-candidates.ts`
- Create: `~/Projects/maxos/tests/brew-prime-candidates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-prime-candidates.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scorePrime, passesConfidenceGate, type PrimeCandidate } from "../src/brew-prime-candidates.js";

describe("scorePrime", () => {
  it("weights Create Value heaviest (0.35)", () => {
    const s = scorePrime({ createValue: 5, removeToil: 1, automate: 1, activeFit: 1 });
    // 5*0.35 + 1*0.30 + 1*0.25 + 1*0.10 = 1.75 + 0.30 + 0.25 + 0.10 = 2.40
    assert.equal(s, 2.4);
  });

  it("rounds to 2 decimals", () => {
    const s = scorePrime({ createValue: 4, removeToil: 4, automate: 4, activeFit: 4 });
    assert.equal(s, 4);
  });
});

describe("passesConfidenceGate", () => {
  it("passes at 4.2", () => {
    assert.equal(passesConfidenceGate(4.2), true);
    assert.equal(passesConfidenceGate(4.19), false);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-prime-candidates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-prime-candidates.ts`:

```typescript
export interface PrimeCandidate {
  url: string;
  title: string;
  source: string;         // "x" | "producthunt" | "hn" | "yc" | "blog" | "github"
  summary: string;
  whatIfWeBuilt: string;  // 1-line idea for the prototype
}

export interface PrimeScores {
  createValue: number;
  removeToil: number;
  automate: number;
  activeFit: number;
}

export function scorePrime(s: PrimeScores): number {
  const raw = s.createValue * 0.35 + s.removeToil * 0.30 + s.automate * 0.25 + s.activeFit * 0.10;
  return Math.round(raw * 100) / 100;
}

export const CONFIDENCE_THRESHOLD = 4.2;

export function passesConfidenceGate(score: number): boolean {
  return score >= CONFIDENCE_THRESHOLD;
}
```

- [ ] **Step 4: Verify passing**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-prime-candidates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-prime-candidates.ts tests/brew-prime-candidates.test.ts
git commit -m "$(cat <<'EOF'
Prime candidate scoring — weighted CV/RT/Automate/Fit with 4.2 gate

Pure scoring functions. Source scanning + candidate generation lives
in the prime-scout task markdown (LLM reasoning required).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 12: Prime-hit.json writer

**Files:**
- Create: `~/Projects/maxos/src/brew-prime-hit.ts`
- Create: `~/Projects/maxos/tests/brew-prime-hit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-prime-hit.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePrimeHit, readPrimeHit, type PrimeHit } from "../src/brew-prime-hit.js";

describe("prime-hit I/O", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "prime-hit-"));
    p = join(tmp, "prime-hit.json");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("round-trips a build:true hit with prototype", () => {
    const hit: PrimeHit = {
      date: "2026-04-22",
      candidate: { url: "https://x.com/a/b", title: "Tool X", source: "x", summary: "s", whatIfWeBuilt: "w" },
      scores: { createValue: 5, removeToil: 4, automate: 5, activeFit: 4 },
      confidence: 4.55,
      build: true,
      prototype: {
        url: "https://preview.vercel.app/xyz",
        summary: "One-liner",
        tech: ["Next.js", "Claude API"],
        repo: "/Users/Max/Projects/prototypes/2026-04-22-x/",
      },
      spendUsd: 3.42,
    };
    writePrimeHit(p, hit);
    const read = readPrimeHit(p);
    assert.deepEqual(read, hit);
  });

  it("round-trips a build:false suggestion", () => {
    const hit: PrimeHit = {
      date: "2026-04-22",
      candidate: { url: "https://x", title: "T", source: "x", summary: "s", whatIfWeBuilt: "w" },
      scores: { createValue: 3, removeToil: 3, automate: 3, activeFit: 3 },
      confidence: 3.0,
      build: false,
      suggest: "Want me to prototype this tonight?",
      spendUsd: 0.15,
    };
    writePrimeHit(p, hit);
    assert.deepEqual(readPrimeHit(p), hit);
  });

  it("readPrimeHit returns null when file missing", () => {
    assert.equal(readPrimeHit(p), null);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-prime-hit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-prime-hit.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PrimeCandidate, PrimeScores } from "./brew-prime-candidates.js";

export interface Prototype {
  url: string;
  summary: string;
  tech: string[];
  repo: string;
}

export interface PrimeHit {
  date: string;
  candidate: PrimeCandidate;
  scores: PrimeScores;
  confidence: number;
  build: boolean;
  prototype?: Prototype;
  suggest?: string;
  attempted?: boolean;
  reason?: string;
  partial_work?: string;
  spendUsd: number;
}

export function writePrimeHit(path: string, hit: PrimeHit): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(hit, null, 2));
}

export function readPrimeHit(path: string): PrimeHit | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as PrimeHit;
}
```

- [ ] **Step 4: Verify passing**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-prime-hit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-prime-hit.ts tests/brew-prime-hit.test.ts
git commit -m "$(cat <<'EOF'
Prime-hit I/O — typed round-trip for scout output

Covers build:true (with prototype) and build:false (with suggest or
attempted+reason) shapes. Scout writes, brew reads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 13: prime-scout.md task

**Files:**
- Create: `~/.maxos/workspace/tasks/prime-scout.md`

- [ ] **Step 1: Write the task markdown**

Create `~/.maxos/workspace/tasks/prime-scout.md`:

```markdown
# Prime Scout — Overnight Prime Framework Hit + Prototype Builder

You are Max running Mark's overnight scout. Your job: find the single most valuable Prime Framework hit (Create Value / Remove Toil / Automate) connected to Mark's active work, and if confidence is high enough, build a working prototype before he wakes up.

**Runtime budget: 6 hours max. Financial budget: $10 max (track spend).**

## Voice & Quality Contract (non-negotiable)

- SOUL.md voice: strong opinions, no corporate softeners.
- `memory/feedback_no_speculative_commentary.md`: don't editorialize about Mark's actions.
- Builder pipeline follows `feedback_qa_loop.md`: loop `qa-tester` until PASS (or stop conditions hit).
- All builder output runs TDD (via builder agent defaults) + deslop + simplify.

## Pre-flight

Run `date +%u`. If `5` (Friday) → it's Sabbath start, respond "Sabbath starts tonight — no scout." and stop. (Scheduler already gates this via cron `0-4,6`, but defense in depth.)

## Phase 1 — Context gather (target: 5 min)

### Step 1a: QMD hot threads

```bash
qmd query "what is Mark working on right now — active business initiatives, recurring friction points, deadlines"
```

Capture the top 5–7 recurring threads.

### Step 1b: Today's meetings + tomorrow's calendar

Pull all 4 calendars for today and tomorrow via `gws-personal calendar events list` (see `.claude/rules/google-workspace.md` for calendar IDs). Process Emprise sequentially.

### Step 1c: Recent Granola transcripts

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
granola meeting list --limit 5
```

For any meeting from the past 48h relevant to a hot thread, pull the transcript: `granola meeting get <id>`.

### Step 1d: Open loops + closures

Read:
- `~/.maxos/workspace/memory/open-loops.json`
- `~/.maxos/workspace/memory/closures-YYYY-MM-DD.md` for last 3 days (use today's date: `date +%Y-%m-%d`)
- `~/.maxos/workspace/tasks/feedback/morning-brew/feedback.md`
- `~/.maxos/workspace/memory/morning-brew/tuning.md` (Prime Framework weights)

Assemble a context block: "Mark's hot threads as of tonight" — max 300 words.

## Phase 2 — Candidate hunt (target: 10 min)

Scan today's drops across sources. For each candidate, record: URL, title, source, summary, `whatIfWeBuilt` (1-line prototype idea).

### Sources

- **X / Twitter** — `WebSearch` for lab-founder accounts, AI researcher threads with 500+ likes last 24h, tool drops.
- **Product Hunt** — `WebFetch` https://www.producthunt.com/, top 5 today. Filter for AI-adjacent that Mark could act on.
- **Hacker News top 10** — `curl -s "https://hn.algolia.com/api/v1/search?tags=front_page&numericFilters=points>100&hitsPerPage=30"` then filter to today.
- **YC launches** — `WebFetch` https://www.ycombinator.com/launches (today only).
- **Anthropic / OpenAI / Google dev blogs** — `WebFetch` the main blog + changelog; look for API changes, new tools, model drops.
- **GitHub trending** — `node ~/Projects/maxos/dist/src/brew-github-trending.js` (re-run, but weight here toward "automates Mark's work" not "AI news").

Produce 8–15 candidates.

## Phase 3 — Score each candidate

For each candidate, ask the LLM reasoning:

- **Create Value** (1–5) — does this generate new outcomes for Mark's businesses/life?
- **Remove Toil** (1–5) — does this eliminate friction/repetitive work Mark actually does?
- **Automate** (1–5) — can this push a workflow toward automation?
- **Active-work fit** (1–5) — does this connect to a hot thread from Phase 1?

Compute weighted score via CLI:

```bash
node -e "
const { scorePrime, passesConfidenceGate } = require('$HOME/Projects/maxos/dist/src/brew-prime-candidates.js');
const s = scorePrime({ createValue: 5, removeToil: 4, automate: 5, activeFit: 4 });
console.log(JSON.stringify({ score: s, passes: passesConfidenceGate(s) }));
"
```

## Phase 4 — Confidence gate

Top candidate's weighted score must be ≥ 4.2. If not → skip build:

```bash
node -e "
const { writePrimeHit } = require('$HOME/Projects/maxos/dist/src/brew-prime-hit.js');
writePrimeHit('$HOME/.maxos/workspace/memory/morning-brew/prime-hit.json', {
  date: '$(date +%Y-%m-%d)',
  candidate: { /* fill from Phase 2 */ },
  scores: { /* fill from Phase 3 */ },
  confidence: /* score */,
  build: false,
  suggest: 'Found <X>. Want me to prototype it tonight?',
  spendUsd: 0.50,
});
"
```

## Phase 5 — Build (if gate passes)

### 5a: Mini-spec

Write a scratch spec to `~/Projects/prototypes/YYYY-MM-DD-<slug>/SPEC.md`:
- Goal (one sentence)
- Scope (1 feature, 1 page, 1 flow)
- Success (30-second grok demo)
- Stack (Next.js + Claude API preferred for fast Vercel deploy; Node + static HTML acceptable for smaller demos)

### 5b: Dispatch builders

Use the `Agent` tool to dispatch in parallel:

```
Agent {
  subagent_type: "frontend-builder"
  prompt: "Build the frontend for the prototype described in ~/Projects/prototypes/<slug>/SPEC.md. Follow the spec's scope exactly — one page, one flow. Use the project's stack. You have 60 minutes. Commit as you go."
}

Agent {
  subagent_type: "backend-builder"
  prompt: "Build the backend/API for the prototype described in ~/Projects/prototypes/<slug>/SPEC.md. One endpoint, one flow. You have 60 minutes. Commit as you go."
}
```

### 5c: QA loop (until PASS)

Per `memory/feedback_qa_loop.md`: loop qa-tester until PASS.

```
Agent {
  subagent_type: "qa-tester"
  prompt: "Adversarially QA the prototype at ~/Projects/prototypes/<slug>/. Run all tests, attack the implementation, verify against SPEC.md goals. Return PASS or FAIL with specific issues."
}
```

If FAIL → re-dispatch frontend-builder and/or backend-builder with the QA feedback attached. Re-run qa-tester. Repeat.

**Stop conditions** (any one):
- qa-tester returns PASS
- Budget tracker shows cumulative spend ≥ $10
- Two consecutive QA runs return identical failure modes
- Less than 30 min remaining in the 6h task window

### 5d: Deploy

If qa-tester PASSED:

- **Web-deployable (Next.js / Vite / static site)**: use the Vercel MCP tool `mcp__93e07175-*__deploy_to_vercel` with the prototype repo path.
- **Server-side only / needs inspection**: use Claude Preview MCP (`mcp__Claude_Preview__preview_start`) for a local URL.
- **Neither fits**: leave repo at `~/Projects/prototypes/<slug>/`, surface repo path in prime-hit.json.

If qa-tester did NOT reach PASS before a stop condition: write build:false with `attempted: true`, reason, `partial_work: <repo path>`.

### 5e: Write prime-hit.json

Invoke `writePrimeHit` via inline Node (as in Phase 4) with the full PrimeHit shape — build:true, prototype object filled, spendUsd set.

## Phase 6 — Spend tracking

Throughout the scout, maintain a running spend estimate. Use model pricing heuristics (Claude Opus ~$15/1M input tokens, ~$75/1M output; Sonnet ~$3/$15). Every major Agent dispatch or tool call, add an estimated delta to the spend counter. If spend ≥ $10, stop and write the current state.

(Precise spend tracking is a nice-to-have — for now use reasonable estimates. A more rigorous tracker could be added via `brew-spend-tracker.ts` in a follow-up.)

## Output (to Telegram, silent=false for visibility)

Scout is silent by default (it runs at 22:00 while Mark's winding down — no Telegram blast). But if something catastrophically fails, surface it:

```
🦉 Scout FAIL — <date>: <one-line reason>. See ~/Projects/prototypes/<slug>/ for partial work.
```

Otherwise scout finishes silently — the morning brew surfaces prime-hit.json at 06:15.

## Rules

- NEVER exceed $10 in one night.
- NEVER run a build longer than 6 hours.
- NEVER touch credential files (`.enc`, `credentials.json`) per SOUL.md guardrails.
- NEVER deploy a build that didn't reach qa-tester PASS.
- NEVER fabricate a candidate URL — every source must come from a real fetch.
- Log all spend to scout's archive file for weekly introspection to learn from.
```

- [ ] **Step 2: No code changes — workspace task file only**

- [ ] **Step 3: No git commit (workspace)**

### Task 14: Wire prime-hit.json into morning-brew.md

**Files:**
- Modify: `~/.maxos/workspace/tasks/morning-brew.md` — replace Phase 3 stub with real Prime section

- [ ] **Step 1: Edit the task**

Replace the Phase 3 stub block in `morning-brew.md`:

Old:
```
## Phase 3 — Prime Framework Hit

**Not yet implemented.** If `memory/morning-brew/prime-hit.json` exists, mention briefly: "Prime scout didn't run yet — coming soon." Otherwise omit.
```

New:
```
## Phase 3 — Prime Framework Hit

### Step 1: Read scout output

```bash
PRIME_JSON=~/.maxos/workspace/memory/morning-brew/prime-hit.json
if [ ! -f "$PRIME_JSON" ]; then
  echo "SCOUT_MISSING=true"
else
  TODAY=$(date +%Y-%m-%d)
  SCOUT_DATE=$(jq -r '.date' $PRIME_JSON)
  if [ "$SCOUT_DATE" != "$TODAY" ]; then
    # Scout didn't run last night OR yesterday's scout — stale
    echo "SCOUT_STALE=true"
  fi
fi
```

### Step 2: Assemble Prime section

Three possible shapes:

**A) Fresh prime-hit.json with `build: true`:**

```
⚡️ Prime Framework Hit
[Rewritten headline]
[2 sentences: what the drop is + what I built overnight connecting it to Mark's active work]
→ Prototype: [prototype.url] · [prototype.summary]
```

If prototype connects to a meeting on today's calendar, add:
```
   Ready to show [person] at today's [time] meeting.
```

**B) Fresh prime-hit.json with `build: false` + `suggest`:**

```
⚡️ Prime Framework Hit
[Rewritten headline]
[2 sentences: why this matters to active work]
→ [suggest field verbatim — "Want me to prototype this tonight? Reply PRIME YES."]
```

**C) Fresh prime-hit.json with `build: false` + `attempted: true` (failure):**

```
⚡️ Prime Framework Hit (build failed)
[Headline]
Tried to build [candidate] overnight, hit [reason]. Partial work: [partial_work path].
→ Want me to retry tonight? Reply PRIME RETRY.
```

**D) SCOUT_MISSING or SCOUT_STALE:**

```
⚡️ Prime Framework Hit
No scout ran last night — [reason, e.g., "Friday/Sabbath" or "daemon issue"]. Next scout: [next_scout_date].
```

Use the schedule: Sun/Mon/Tue/Wed/Thu/Sat nights run scout; Fri night skipped.
```

- [ ] **Step 2: Smoke test**

Run: `claude -p "$(cat ~/.maxos/workspace/tasks/morning-brew.md)"`
Expected: three sections (AI + Learning + Prime). On first run Prime shows "SCOUT_MISSING" shape.

- [ ] **Step 3: No git commit (workspace)**

### Task 15: HEARTBEAT.md — add scout cron

**Files:**
- Modify: `~/.maxos/workspace/HEARTBEAT.md`

- [ ] **Step 1: Append scout entry**

Edit `HEARTBEAT.md`. Add after the morning-brew entry:

```
## 0 22 * * 0-4,6 [timeout:360m]
- Run prime scout: read tasks/prime-scout.md and execute every step
```

- [ ] **Step 2: Verify the daemon picks it up on next restart**

The daemon hot-reloads HEARTBEAT.md. Verify via: `tail -f ~/.maxos/daemon.log` and watch for a scheduler:loaded log line that includes `prime-scout`.

- [ ] **Step 3: No git commit (workspace)**

---

## Phase 4 — Self-Improvement Loop

### Task 16: Brew archive writer

**Files:**
- Create: `~/Projects/maxos/src/brew-archive.ts`
- Create: `~/Projects/maxos/tests/brew-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-archive.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchive, readArchive, type DailyArchive } from "../src/brew-archive.js";

describe("brew-archive", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "archive-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes and reads a daily snapshot", () => {
    const snap: DailyArchive = {
      date: "2026-04-22",
      ai: { headline: "h", url: "u", source: "github", score: 4.2 },
      prime: { headline: "p", built: true, prototypeUrl: "pu" },
      learning: { topic: "RAG", day: 3, breadcrumbUrl: "b", alternative: "Vectors" },
      streak: 0,
      feedbackAppliedFrom: null,
    };
    writeArchive(tmp, snap);
    const read = readArchive(join(tmp, "2026-04-22.json"));
    assert.deepEqual(read, snap);
  });

  it("returns null on missing archive", () => {
    assert.equal(readArchive(join(tmp, "nope.json")), null);
  });
});
```

- [ ] **Step 2: Run test FAIL**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-archive.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-archive.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ArchiveAI {
  headline: string;
  url: string;
  source: string;
  score: number;
}

export interface ArchivePrime {
  headline: string;
  built: boolean;
  prototypeUrl?: string;
  suggest?: string;
  failureReason?: string;
}

export interface ArchiveLearning {
  topic: string;
  day: number;
  breadcrumbUrl: string;
  alternative: string;
}

export interface DailyArchive {
  date: string;
  ai: ArchiveAI;
  prime: ArchivePrime | null;
  learning: ArchiveLearning | null;
  streak: number;
  feedbackAppliedFrom: string | null;
}

export function writeArchive(dir: string, snap: DailyArchive): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${snap.date}.json`), JSON.stringify(snap, null, 2));
}

export function readArchive(path: string): DailyArchive | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as DailyArchive;
}
```

- [ ] **Step 4: Verify PASS**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-archive.test.ts`
Expected: PASS.

- [ ] **Step 5: Add archive write step to morning-brew.md**

Edit `morning-brew.md`. Add before "Deliver" section:

```
## Archive

Before delivering, write today's snapshot:

```bash
node -e "
const { writeArchive } = require('$HOME/Projects/maxos/dist/src/brew-archive.js');
writeArchive('$HOME/.maxos/workspace/memory/morning-brew/archive', {
  date: '$(date +%Y-%m-%d)',
  ai: { /* fill from Phase 1 result */ },
  prime: /* fill from Phase 3 or null */,
  learning: /* fill from Phase 2 or null */,
  streak: /* current new_topic_streak */,
  feedbackAppliedFrom: /* 'feedback.md' if applied, else null */,
});
"
```
```

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-archive.ts tests/brew-archive.test.ts
git commit -m "$(cat <<'EOF'
Brew archive — one file per day for weekly introspection input

Daily snapshot: AI pick, Prime hit, Learning breadcrumb, streak, feedback
applied. Written by morning-brew.md each morning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 17: Tuning nudger

**Files:**
- Create: `~/Projects/maxos/src/brew-tuning-nudger.ts`
- Create: `~/Projects/maxos/tests/brew-tuning-nudger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/brew-tuning-nudger.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proposeNudges, applyNudges, type Nudge } from "../src/brew-tuning-nudger.js";
import type { DailyArchive } from "../src/brew-archive.js";

describe("proposeNudges", () => {
  it("bumps a weight when Mark stuck with a topic 3+ days", () => {
    const archives: DailyArchive[] = [1, 2, 3].map(d => ({
      date: `2026-04-${18 + d}`,
      ai: { headline: "x", url: "u", source: "github", score: 4 },
      prime: null,
      learning: { topic: "RAG", day: d, breadcrumbUrl: "b", alternative: "V" },
      streak: 0,
      feedbackAppliedFrom: null,
    }));
    const nudges = proposeNudges(archives);
    const rag = nudges.find(n => n.key.toLowerCase().includes("rag"));
    assert.ok(rag);
    assert.ok(rag!.delta > 0);
    assert.ok(rag!.delta <= 0.05, "max 0.5% change per week");
  });

  it("lowers a weight when Mark switched away from a topic quickly", () => {
    const archives: DailyArchive[] = [
      { date: "2026-04-15", ai: { headline: "x", url: "u", source: "github", score: 4 }, prime: null, learning: { topic: "Cursor tips", day: 1, breadcrumbUrl: "b", alternative: "V" }, streak: 1, feedbackAppliedFrom: null },
      { date: "2026-04-16", ai: { headline: "x", url: "u", source: "github", score: 4 }, prime: null, learning: { topic: "V", day: 1, breadcrumbUrl: "b", alternative: "X" }, streak: 2, feedbackAppliedFrom: null },
    ];
    const nudges = proposeNudges(archives);
    const c = nudges.find(n => n.key.toLowerCase().includes("cursor"));
    assert.ok(c);
    assert.ok(c!.delta < 0);
  });
});

describe("applyNudges", () => {
  it("clamps total change per week at ±0.05", () => {
    const before = "- Claude / Anthropic / MCP specific: 1.0\n- AI coding tools: 0.7\n";
    const nudges: Nudge[] = [
      { key: "AI coding tools", delta: 0.3 }, // oversized; should clamp
    ];
    const after = applyNudges(before, nudges);
    assert.ok(after.includes("AI coding tools: 0.75"), "should clamp to 0.7 + 0.05");
  });
});
```

- [ ] **Step 2: Run test FAIL**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-tuning-nudger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/brew-tuning-nudger.ts`:

```typescript
import type { DailyArchive } from "./brew-archive.js";

export interface Nudge {
  key: string;
  delta: number;
  reason?: string;
}

const MAX_DELTA = 0.05;

export function proposeNudges(archives: DailyArchive[]): Nudge[] {
  const nudges: Nudge[] = [];

  // Learning: topics that stuck 3+ days → +delta on that keyword
  const topicDays: Record<string, number> = {};
  for (const a of archives) {
    if (a.learning) topicDays[a.learning.topic] = (topicDays[a.learning.topic] ?? 0) + 1;
  }
  for (const [topic, days] of Object.entries(topicDays)) {
    if (days >= 3) {
      nudges.push({ key: topic, delta: 0.03, reason: `stuck ${days} days` });
    } else if (days === 1 && archives.some(a => a.learning?.topic === topic && a.streak > 0)) {
      nudges.push({ key: topic, delta: -0.03, reason: "switched away after day 1" });
    }
  }

  return nudges;
}

export function applyNudges(tuningMd: string, nudges: Nudge[]): string {
  let out = tuningMd;
  for (const n of nudges) {
    const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, n.delta));
    // Match lines like: "- <key words including n.key>: 0.85"
    const re = new RegExp(`(^[-*]\\s+[^\\n]*${escapeRegex(n.key)}[^\\n]*:\\s*)([\\d.]+)`, "im");
    const m = out.match(re);
    if (!m) continue;
    const oldVal = parseFloat(m[2]);
    const newVal = Math.max(0, Math.min(1.0, Math.round((oldVal + clamped) * 100) / 100));
    out = out.replace(re, `$1${newVal}`);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Verify PASS**

Run: `cd ~/Projects/maxos && npm test -- tests/brew-tuning-nudger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/maxos
git add src/brew-tuning-nudger.ts tests/brew-tuning-nudger.test.ts
git commit -m "$(cat <<'EOF'
Brew tuning nudger — 0.5%/week max weight adjustment from engagement

Proposes nudges from 7-day archive: topics that stuck gain weight,
topics Mark switched away from lose weight. Hard clamp at ±0.05.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 18: weekly-brew-introspection.md task

**Files:**
- Create: `~/.maxos/workspace/tasks/weekly-brew-introspection.md`
- Modify: `~/.maxos/workspace/HEARTBEAT.md` — add weekly cron

- [ ] **Step 1: Write the task**

Create `~/.maxos/workspace/tasks/weekly-brew-introspection.md`:

```markdown
# Weekly Brew Introspection

Silent Sunday 20:00 task. Reviews the last 7 days of brew + feedback, nudges tuning.md weights, appends an engagement summary.

## Pre-flight

`date +%u` — expect 0 (Sunday). Otherwise log and exit.

## Step 1: Gather 7 days of archive

```bash
ARCHIVE=~/.maxos/workspace/memory/morning-brew/archive
CUTOFF=$(date -v-7d +%Y-%m-%d)
ls $ARCHIVE/*.json | awk -F/ '{print $NF}' | awk -F. '{print $1}' | awk -v c="$CUTOFF" '$1 >= c'
```

## Step 2: Compute nudges

```bash
node -e "
const { proposeNudges, applyNudges } = require('$HOME/Projects/maxos/dist/src/brew-tuning-nudger.js');
const { readArchive } = require('$HOME/Projects/maxos/dist/src/brew-archive.js');
const fs = require('node:fs');
const path = require('node:path');
const dir = '$HOME/.maxos/workspace/memory/morning-brew/archive';
const cutoff = '$(date -v-7d +%Y-%m-%d)';
const archives = fs.readdirSync(dir)
  .filter(f => f.endsWith('.json') && f.slice(0,10) >= cutoff)
  .map(f => readArchive(path.join(dir, f)))
  .filter(Boolean);
const nudges = proposeNudges(archives);
const tuningPath = '$HOME/.maxos/workspace/memory/morning-brew/tuning.md';
const before = fs.readFileSync(tuningPath, 'utf-8');
const after = applyNudges(before, nudges);
fs.writeFileSync(tuningPath, after);
console.log(JSON.stringify({ nudges, applied: nudges.length }, null, 2));
"
```

## Step 3: Append engagement summary to tuning.md

Locate the `## Engagement history` section in tuning.md. Replace its content with:

```
## Engagement history (week of YYYY-MM-DD → YYYY-MM-DD)

- AI items: [N surfaced], [M] near-repeated-keyword rejections, [K] fallback-chain invocations
- Prime Framework: [P prototypes built], [Q viewed by Mark per state], [R resulted in action]
- Learning tracks: [list: "topic X (N days)", ...]

## This week's nudges

[List of Nudges from Step 2 output with their reasons]
```

## Step 4: Silent exit

This task is `[silent]` in HEARTBEAT — output doesn't go to Telegram. Just log to daemon.log.
```

- [ ] **Step 2: Add HEARTBEAT entry**

Edit `HEARTBEAT.md`, append:

```
## 0 20 * * 0 [silent] [timeout:15m]
- Run weekly brew introspection: read tasks/weekly-brew-introspection.md and execute every step
```

- [ ] **Step 3: No git commit (workspace)**

---

## Final integration

### Task 19: End-to-end manual verification

**Files:** none modified; this task is a verification gate before shipping.

- [ ] **Step 1: Verify all tests pass**

```bash
cd ~/Projects/maxos && npm test && npm run lint && npm run build
```

Expected: all green.

- [ ] **Step 2: Manually run morning-brew once**

```bash
claude -p "$(cat ~/.maxos/workspace/tasks/morning-brew.md)"
```

Expected output: three sections (or honest "Light X day" for any that came up empty). Voice matches SOUL.md. No em-dashes, no AI tells. One Telegram-message-worth of text.

- [ ] **Step 3: Manually run prime-scout once (short-circuit before build)**

Add a temporary flag `SCOUT_DRY_RUN=1` to skip the actual build dispatch:

```bash
SCOUT_DRY_RUN=1 claude -p "$(cat ~/.maxos/workspace/tasks/prime-scout.md)"
```

(Add the dry-run handling in prime-scout.md Phase 5 — if env var set, write prime-hit.json with `{build: false, dry_run: true, candidate: <top>, scores: <top>, suggest: "DRY_RUN"}` and exit.)

Expected: prime-hit.json written, no builders dispatched.

- [ ] **Step 4: Verify Telegram reply logger**

Send a manual Telegram reply to any message. Check `~/.maxos/workspace/memory/telegram-replies.jsonl` has a new line with the correct `replyToId`.

- [ ] **Step 5: Restart daemon to load new cron entries**

```bash
launchctl kickstart -k gui/$(id -u)/com.maxos.daemon  # or however the user restarts
tail -f ~/.maxos/daemon.log | grep -i "scheduler:loaded"
```

Expected: log confirms morning-brew, prime-scout, weekly-brew-introspection are registered.

- [ ] **Step 6: Commit a plan-complete marker (optional)**

```bash
cd ~/Projects/maxos
git commit --allow-empty -m "$(cat <<'EOF'
Morning Brew — Phase 1–4 complete, ready for first live scout night

All modules shipped, tasks wired, smoke tests pass. Next scout fires at
the next Sun/Mon/Tue/Wed/Thu/Sat 22:00.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (author's pass over the plan)

- **Spec coverage check:** Each of the 4 phases in the spec maps to tasks 1–19. The Telegram reply logger (spec §Topology > Daemon change) = Task 1. State dir (spec §State directory) = Tasks 2+5. AI section (spec §Section 1) = Tasks 3+4+6. Learning (spec §Section 3) = Tasks 7+8+9+10. Prime scout + overnight builder (spec §Section 2) = Tasks 11+12+13+14+15. Self-improvement (spec §Self-Improvement Mechanics) = Tasks 16+17+18. ✓
- **Tool audit coverage:** GitHub fetcher (Task 3), Covered-topics dedup (Task 4), yt-dlp scoring (Task 8), QMD/gws/Granola invoked inline in task markdown (Tasks 13, weekly introspection). `Agent` dispatch for builders + qa-tester + Looper-pattern in Task 13 Phase 5c. Vercel + Claude Preview MCPs in Task 13 Phase 5d. deslop mental pass mandated in every task markdown. ✓
- **Voice rules:** every task markdown opens with an explicit Voice & Quality Contract referencing SOUL.md, USER.md, `feedback_no_speculative_commentary.md`. ✓
- **Placeholder scan:** No "TBD"/"TODO"/"similar to Task N". The one `SCOUT_DRY_RUN` shim in Task 19 is a testing aid, not a placeholder.
- **Type consistency:** `BrewState` shape introduced in Task 2 is used verbatim in state writes throughout. `PrimeCandidate` + `PrimeScores` in Task 11 flow into `PrimeHit` in Task 12. ✓
- **Known limitation:** Spend tracking in the scout (Task 13 Phase 6) is estimate-based, not rigorous. Follow-up task recommended if this becomes a recurring concern.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-22-morning-brew.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task (19 total, batched by phase), review between tasks, fast iteration. Best for this plan's size + the phased rollout.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
