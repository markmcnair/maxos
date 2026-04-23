# Morning Brew — Design Spec

**Date:** 2026-04-22
**Status:** Approved by Mark 2026-04-22 — ready for implementation planning
**Replaces:** `tasks/ai-briefing.md`

## Goal

Deliver a single daily brief at 06:15 CT (Sun–Fri) with three sections, each containing exactly one high-confidence item:

1. **AI** — the single most relevant AI drop for Mark's context (GitHub-trending-first, with fallback chain)
2. **Prime Framework Hit** — the single most valuable Create Value / Remove Toil / Automate opportunity, ideally with a prototype already built overnight
3. **Learning** — one bite-sized breadcrumb on a learning track, with an A/B "continue *this topic* or switch to *specific named alternative*" question (both options always concrete)

The skill is **self-healing and self-improving**. Every dimension of picking — topics, sources, depth — has a deterministic feedback signal and improves week over week without Mark having to tune it manually.

## Non-Goals

- Not a newsletter. 30-second read max. If content is weak, brew delivers less.
- Not a book-recommendation engine in the Prime Framework section. Prime Framework = low-friction, baller-move automation opportunities tied to Mark's active work.
- Not a replacement for morning brief (`morning-brief.md`). Brew runs 15 min after morning brief and stays focused on its three sections.

## Topology

### Tasks (scheduled in HEARTBEAT.md)

| Task file | Cron | Purpose |
|---|---|---|
| `tasks/morning-brew.md` | `15 6 * * 0-5` `[timeout:10m]` | Reads prior state + scout output, assembles and delivers the three-section brief |
| `tasks/prime-scout.md` | `0 22 * * 0-4,6` `[timeout:360m]` | Evening scout: picks Prime Framework candidate, orchestrates overnight build via builder agents, writes `prime-hit.json`. Runs Sun–Thu + Sat nights; skips only Fri night (Sabbath). |
| `tasks/weekly-brew-introspection.md` | `0 20 * * 0` `[silent] [timeout:15m]` | Reviews last 7 days of brew state + feedback, nudges `tuning.md` heuristics |

### Scheduling gates

- **Brew**: Sun–Fri 06:15. Saturday = Sabbath, no brew.
- **Scout**: Sun/Mon/Tue/Wed/Thu/Sat nights at 22:00. Only Fri night is skipped (Sabbath begins 17:30 Fri).
  - Thu night scout runs while Mark is asleep — doesn't interfere with date night — delivers prototype for Fri morning brew.
  - Sat night scout (post-Sabbath-sundown) delivers prototype for Sun morning brew.
- **Every brew day has a preceding scout.** The only reason a brew arrives without a prototype is scout failure, low confidence, or scheduler-timeout exhaustion — all reported honestly inline.

Pairing:

| Brew day | Scout source |
|---|---|
| Mon | Sun night |
| Tue | Mon night |
| Wed | Tue night |
| Thu | Wed night |
| Fri | Thu night |
| Sun | Sat night |

### Daemon change

One small change to `src/channels/telegram.ts`: when an inbound message has `reply_to_message`, append one JSONL line to `~/.maxos/workspace/memory/telegram-replies.jsonl`:

```json
{"ts":1714000000000,"msgId":"67890","replyToId":"12345","conversationId":"dm:mark","body":"A"}
```

Tomorrow's brew reads this log to find Mark's reply to yesterday's brew. Deterministic bridge across fresh task sessions.

### State directory: `~/.maxos/workspace/memory/morning-brew/`

```
state.json              # breadcrumb track, streak counter, last outbound msg_id
covered-topics.md       # rolling 30-day log of AI hits (anti-repeat)
prime-hit.json          # today's scout output (candidate, prototype URL, or failure reason)
tuning.md               # picker heuristics — human-readable, nudged weekly
archive/YYYY-MM-DD.json # one file per brew delivery (full snapshot)
```

### Feedback folder

`~/.maxos/workspace/tasks/feedback/morning-brew/feedback.md` — freeform corrections from Mark, read on every run before picking. Same pattern as `morning-brief` feedback.

## Section 1: AI

### Pick order

**GitHub Trending is the primary source.** Fallback chain only if GitHub doesn't clear the confidence gate.

1. Fetch `https://github.com/trending?since=daily` — top 25 repos.
2. Filter to AI/ML by description keywords: `LLM, RAG, agent, MCP, Claude, model, embedding, vector, prompt, inference, fine-tun, eval, benchmark, training, dataset, framework`.
3. Score each candidate on four axes (each 1–5, scored against Mark's context via QMD + `tuning.md`):
   - **Stack fit** — Claude Code, MCP, Node/TS, Python, Notion/Obsidian integrations, Granola, gws
   - **Active project fit** — Emprise Growth, Kingdom Coffee Roasters, business-brain RAG idea, Options Omega, MaxOS itself
   - **Actionable today** — can Mark install / use / fork this TODAY
   - **Novelty** — near-match check against `covered-topics.md` (last 30 days, semantic similarity via embedding or QMD)
4. Weighted score: `(Stack × 0.35) + (Active-project × 0.30) + (Actionable × 0.20) + (Novelty × 0.15)`.
5. **Confidence gate**: winner must score ≥ 3.8/5 AND pass the near-match check.
6. **Fallback chain** if the gate fails — try each in order, first to clear wins:
   1. X / Twitter — AI researcher / lab founder accounts, last 24h, high-engagement threads
   2. YouTube — AI channels with high view:subscriber ratio, uploads in last 48h
   3. Hacker News — top 30 front page, AI-tagged
   4. Reddit — r/LocalLLaMA, r/ClaudeAI, r/MachineLearning top posts last 24h
   5. Product Hunt — top 5 today filtered by AI
7. Log winner to `covered-topics.md`:
   ```
   2026-04-22 · github.com/user/repo · [RAG, Granola, MCP]
   ```

### Why GitHub-first

Mark's context is overwhelmingly "tools I can install or fork today." GitHub's hit rate for that is higher than discourse-platforms like X or Reddit. The fallback chain exists for days where GitHub trending is noise (which happens).

### Output for AI section

```
🧠 AI
[Rewritten headline tailored to Mark]
[2 sentences: what it is + why it matters to YOU specifically]
→ Action: [specific, e.g., "Clone and test against your Granola archive"]
Source: [URL] · [signal, e.g., "3.2k stars today · trending #2"]
```

## Section 2: Prime Framework Hit

### Scout flow (evening, ~22:00)

**Phase 1 — Context gather** (~5 min)

- QMD semantic search: "what is Mark working on right now?" → hot threads
- Read: today's Granola meetings, tomorrow's calendar (all 4), `memory/open-loops.json`, `memory/closures-YYYY-MM-DD.md` for last 3 days, `tasks/feedback/morning-brew/feedback.md`
- Assemble a context block — top 5–7 active initiatives, their current friction points, any deadlines

**Phase 2 — Candidate hunt** (~10 min)

Scan today's drops across:
- X / Twitter — AI lab announcements, tool drops from builder-founders Mark follows
- Product Hunt — top 5 today
- Hacker News — front page top 10
- Y Combinator Launches / news blog
- Anthropic / OpenAI / Google dev blogs
- GitHub trending (different from AI section — weighted here for "could I automate Mark's work with this")

Produce 8–15 candidates with: URL, what it is, who made it, what problem it solves.

**Phase 3 — Score**

For each candidate, score against Mark's active work (each axis 1–5):
- **Create Value** — does this generate new outcomes for Mark's businesses/life?
- **Remove Toil** — does this eliminate friction/repetitive work Mark actually does?
- **Automate** — can this push a workflow toward automation?
- **Active-work fit** — does this connect to a hot thread from Phase 1?

Weighted: `(CreateValue × 0.35) + (RemoveToil × 0.30) + (Automate × 0.25) + (ActiveFit × 0.10)`.

**Phase 4 — Confidence gate**

Top candidate must score ≥ 4.2/5. If not → write:
```json
{
  "date": "2026-04-22",
  "candidate": {"title": "...", "url": "...", "why": "..."},
  "confidence": 3.7,
  "build": false,
  "suggest": "Found X. Want me to prototype it tomorrow?"
}
```
Brew will surface the suggestion; Mark's A/B-style reply can trigger tomorrow's build.

**Phase 5 — Build** (if gate passes)

1. **Spec**: scout writes a mini-spec to a scratch file:
   - Goal: one sentence
   - Scope: 1 feature, 1 page, 1 flow
   - Success: 30-second grok test — Mark sees it, gets the value immediately
   - Constraints: Mark's stack (Node/TS, React or plain HTML, Vercel deploy preferred)
2. **Dispatch builders** via the `Agent` tool:
   - `frontend-builder` and `backend-builder` in parallel, each handed the relevant slice of the spec
   - Builders use TDD + deslop + simplify skills automatically (per their agent definitions)
3. **QA loop — runs until PASS** (per `memory/feedback_qa_loop.md`):
   - After builders report complete, dispatch `qa-tester` for adversarial QA
   - If FAIL → re-dispatch builders with QA feedback attached, re-run QA
   - Loop continues until `qa-tester` returns PASS
   - **Stop conditions** (any one triggers fallback):
     - Two consecutive QA runs return identical failure modes (can't make progress — approach is wrong)
     - Scout's 6h scheduler timeout approaching (<30 min remaining)
   - On stop without PASS → fall back to "concept + starter repo" delivery with a note explaining what was attempted
4. **Deploy** (on PASS):
   - Web-deployable? → Vercel MCP (`mcp__*__deploy_to_vercel`)
   - Not web-deployable? → Claude Preview MCP → local URL
   - Neither? → commit to `~/Projects/prototypes/YYYY-MM-DD-<slug>/` and surface repo path
5. **Write `prime-hit.json`**:
   ```json
   {
     "date": "2026-04-22",
     "candidate": {"title": "...", "url": "...", "why": "..."},
     "confidence": 4.5,
     "build": true,
     "prototype": {
       "url": "https://prime-hit-kingdom-coffee-rag.vercel.app",
       "summary": "One-line explainer Mark reads in the brew",
       "tech": ["Next.js", "Claude API", "..."],
       "repo": "~/Projects/prototypes/2026-04-22-kingdom-coffee-rag/"
     }
   }
   ```

### Runtime cap

Scout inherits the cron's `[timeout:360m]` — 6 hours hard ceiling. **No dollar cap.** The daemon spawns `claude --print` under Mark's Claude Code OAuth subscription, so sub-agent dispatches run on the subscription's rate limit, not a billable API meter. The only quota is the subscription itself, which the 6h scheduler timeout naturally bounds.

### Scope discipline

**Prototype = ONE feature, ONE page, ONE flow.** Not a product. 30-second grok test: Mark sees it, understands the value, can decide "apply this to X client" or "dismiss."

If the candidate's core idea genuinely needs more than that, scout downgrades to "concept + starter repo" — writes a `README.md` explaining the idea and a skeleton project structure, no forced build.

### Failure fallback

Any build failure at any stage → `prime-hit.json`:
```json
{
  "build": false,
  "attempted": true,
  "reason": "backend-builder failed validation: ...",
  "candidate": {...},
  "partial_work": "~/Projects/prototypes/2026-04-22-slug-wip/"
}
```
Brew reports honestly: "Tried to build X overnight, hit Y. Want me to retry tonight?"

### Output for Prime Framework section

With prototype:
```
⚡️ Prime Framework Hit
[Headline]
[2 sentences: connection to active work, what I built overnight]
→ Prototype: [URL] · [1-line summary]
   Ready to show Daniel at today's 2pm meeting.
```

Without prototype (concept-only or failure):
```
⚡️ Prime Framework Hit
[Headline]
[2 sentences: why this matters now]
→ Want me to prototype this tonight? Reply PRIME YES.
```

## Section 3: Learning Breadcrumb

### `state.json` shape

```json
{
  "current_track": {
    "topic": "RAG databases for business brains",
    "started": "2026-04-19",
    "breadcrumbs_delivered": [
      {
        "date": "2026-04-19",
        "type": "video",
        "url": "https://youtube.com/watch?v=xxx",
        "title": "RAG in 10 min",
        "why_picked": "5× views:subs, 98% likes, practitioner channel"
      }
    ],
    "next_planned": {"type": "tutorial", "intent": "first hands-on RAG build"}
  },
  "alternative_offered": {
    "topic": "vector databases deep-dive",
    "one_line_pitch": "came up in your last Kingdom Coffee meeting — no prior track",
    "why_picked": "high QMD affinity with recent journals + no overlap with RAG track"
  },
  "last_outbound_msg_id": "12345",
  "last_ab_question": "continue RAG or switch to vector DBs?",
  "new_topic_streak": 2,
  "awaiting_response": true,
  "last_updated": "2026-04-22T06:15:00-05:00"
}
```

**Both options in the A/B are always concrete and pre-picked.** The current track's next breadcrumb AND a specific alternative topic are selected each run, so Mark's "B" isn't a vague "find me something new" — it's "switch to this exact thing."

### Daily flow

1. Grep `telegram-replies.jsonl` for a reply matching `last_outbound_msg_id`.
2. Parse Mark's reply:
   - `/^a\b|continue|yes|go/i` → continue (`streak = 0`, advance breadcrumb)
   - `/^b\b|new|switch/i` → rotate topic (`streak += 1`)
   - Ambiguous → ask Mark to clarify in today's brew, don't advance
   - No reply → hold track, **do not** increment streak counter (probably just busy)
3. Pick next breadcrumb:
   - If continuing: use `current_track.next_planned`
   - If rotating: promote `alternative_offered` → `current_track`, its first breadcrumb is today's delivery
4. **Pick tomorrow's alternative** (always):
   - Use `tuning.md` + QMD query "things Mark has been thinking about recently that he doesn't know yet"
   - Must be materially different from `current_track.topic` (no near-overlap)
   - Store in `alternative_offered` so tomorrow's A/B question is concrete on both sides
5. **First breadcrumb on any new topic = YouTube video** with quality bar:
   - 5–15 min length
   - views:subs ratio > 5× (non-subscribers watching = non-echo-chamber signal)
   - >90% like ratio
   - Published within last 6 months
   - Channel authority check — practitioner (3Blue1Brown-tier), not faceless AI-aggregator
6. **Progressive breadcrumbs**: video → tutorial article → hands-on project → deeper reading → advanced/edge-case topics
7. Update state, write archive, include in brew.

### Streak warning

If `new_topic_streak >= 5`, brew prepends to Learning section:

```
⚠️ 5 days of new topics — my picker is weak. What DO you want to learn?
```

Deterministic, no LLM reasoning needed. Forces Mark's explicit feedback.

### Output for Learning section

Every day includes the A/B question — both options are always concrete:

```
📚 Learning — [topic name] (day N)
[Breadcrumb description]
→ [URL] · [quality metrics, e.g., "4.8M views · 98% likes · 3Blue1Brown"]

Continue [current topic] or switch to [alternative topic — one-line pitch]? Reply A or B.
```

Example:
```
📚 Learning — RAG databases for business brains (day 3)
Hands-on: build your first RAG index in 20 min against a sample dataset.
→ https://youtu.be/xxx · 2.1M views · 97% likes · LangChain official

Continue RAG or switch to vector DB internals (came up in Kingdom Coffee meeting)? Reply A or B.
```

## Output Format (Full Brew)

Single Telegram message. Three sections. ≤30 lines total.

```
☕️ Morning Brew — Wed, Apr 22

🧠 AI
[Headline]
[2 sentences]
→ Action: [specific]
Source: [URL] · [signal]

⚡️ Prime Framework Hit
[Headline]
[2 sentences]
→ [Prototype: URL · summary] OR [Want me to prototype this tonight?]

📚 Learning — [topic] (day N)
[Description]
→ [URL] · [metrics]

Continue [topic] or switch to [specific alternative]? Reply A or B.
```

Streak warning (if triggered) prepends to Learning section before the topic line.

## Self-Improvement Mechanics

Four mechanisms stacked:

| Mechanism | Signal source | How it's applied |
|---|---|---|
| `feedback.md` | Mark's freeform corrections | Read at start of every brew run; applied before picking |
| Streak counter | A/B Telegram replies | Deterministic — drives streak warning + confidence nudge |
| Daily archive | Each brew writes `archive/YYYY-MM-DD.json` | 7-day rolling history for introspection |
| Weekly introspection | Sunday 20:00 task | Reads 7 days of archive + feedback + closures; nudges `tuning.md` |

### `tuning.md` example

```markdown
## Morning Brew Tuning — v1.4 (updated 2026-04-20)

### AI picker weights
- Claude / Anthropic / MCP specific: 1.0
- Business RAG / LLM wrapper: 0.9
- AI agent orchestration: 0.85
- Open-source model releases: 0.75
- AI coding tools: 0.7
- Consumer AI apps: 0.3
- AI policy / regulation: 0.2

### Learning picker
- First breadcrumb on new topic: always YouTube video
- Preferred channels (high engagement history): 3Blue1Brown, Fireship, Yannic Kilcher, ...
- Avoid: consumer AI hype channels, "X killer" titles

### Engagement history (last 7 days)
- AI items: 3 surfaced, Mark acted on 2, 1 ignored
- Prime Framework: 2 prototypes built, both opened, 1 used with a client
- Learning tracks: "RAG" (4 days, still going), "MCP internals" (2 days, switched)

### This week's nudges
- Bumped "Business RAG" weight 0.85 → 0.9 (Mark has mentioned Kingdom Coffee RAG 3x)
- Lowered "AI coding tools" 0.75 → 0.7 (Mark rejected 2 Cursor-related hits in a row)
```

### Weekly introspection algorithm

Input: last 7 days of `archive/*.json`, `telegram-replies.jsonl`, `feedback.md`, `closures-*.md`.

Output: updated `tuning.md` with:
- Weight changes (≤ ±0.05 per weight per week — "0.5% better" discipline)
- New entries to "preferred channels" / "avoid" lists
- Engagement summary

Mark can read `tuning.md` at any time and edit it directly. His edits win over algorithmic nudges.

## HEARTBEAT.md changes

**Remove:**
```
## 15 6 * * 0-5
- Run the AI briefing: read tasks/ai-briefing.md and execute every step
```

**Add:**
```
## 15 6 * * 0-5
- Run morning brew: read tasks/morning-brew.md and execute every step

## 0 22 * * 0-4,6 [timeout:360m]
- Run prime scout: read tasks/prime-scout.md and execute every step

## 0 20 * * 0 [silent] [timeout:15m]
- Run weekly brew introspection: read tasks/weekly-brew-introspection.md and execute every step
```

## File structure delta

**Create:**
- `tasks/morning-brew.md` (replaces `ai-briefing.md`)
- `tasks/prime-scout.md`
- `tasks/weekly-brew-introspection.md`
- `tasks/feedback/morning-brew/feedback.md` (starter)
- `memory/morning-brew/state.json` (starter)
- `memory/morning-brew/covered-topics.md` (empty)
- `memory/morning-brew/tuning.md` (v1 baseline)
- `memory/morning-brew/archive/` (empty dir)

**Modify:**
- `src/channels/telegram.ts` — add inbound reply logger
- `HEARTBEAT.md` — swap cron entries
- `memory/MEMORY.md` — add pointer so future sessions know about the brew system

**Archive:**
- Move `tasks/ai-briefing.md` → `tasks/archive/ai-briefing-v1.md` (keep for reference; daemon won't run archived tasks)

## Voice & Quality Standards

Brew output is for Mark's eyes only — but the bar is higher, not lower. Every brew run and every builder pipeline output must conform to:

### Voice

- **`SOUL.md`** — Jarvis with opinions, strong takes, no corporate openers, no "Great question!", no disclaimer-stacking. Commit to picks.
- **`USER.md`** — brevity is mandatory. One line per item where possible. Match Mark's ADHD-friendly "show me what to do now, not everything" pattern.
- **`memory/feedback_no_speculative_commentary.md`** (authoritative) — brew NEVER editorializes about Mark's actions without direct evidence. No "you haven't X", no "this is rotting", no "you didn't reply." If the state file or kit doesn't prove it, don't assert it. Neutral facts only (e.g., "Day 3 of RAG track" — not "you've been lazy about RAG").
- Headlines are always rewritten in Mark's voice — never copy-pasted from source titles.

### Quality

- Every brew delivery runs through the **`deslop`** skill before send — zero tolerance for em dashes, adverbs, AI-tell phrases, "delve/furthermore/moreover" patterns. If the brew fails deslop, regenerate that section.
- Builder pipeline enforces **TDD** (via `superpowers:test-driven-development` — auto-applied inside `frontend-builder`/`backend-builder`), **`simplify`** skill on final pass, and **`superpowers:verification-before-completion`** before any "done" claim.
- Builder dispatch uses **`Looper`** pattern for the frontend↔backend↔qa cycle until PASS (per `feedback_qa_loop.md`).

## Tools per phase

Best-in-class tool for each operation — planner should honor these choices unless there's a specific reason to deviate:

| Operation | Primary tool | Fallback |
|---|---|---|
| GitHub trending fetch | `WebFetch` on `github.com/trending?since=daily` | `defuddle` skill (clean markdown extraction) |
| X / Twitter scan | `WebSearch` (Twitter API is gated) | Bash curl with nitter mirror |
| YouTube metadata (views, likes, channel subs) | `yt-dlp --print "%(view_count)s %(like_count)s %(channel_follower_count)s %(upload_date)s"` | `mcp__Claude_in_Chrome` for rendered page |
| Hacker News top posts | Algolia HN API via Bash curl (`hn.algolia.com/api/v1/search`) | `WebFetch` on `news.ycombinator.com` |
| Reddit top posts | Bash curl on `reddit.com/r/{sub}/top.json?t=day` | `WebFetch` + `defuddle` |
| Product Hunt today | `WebFetch` on producthunt.com + `defuddle` | `WebSearch` |
| Article content extraction | `defuddle` skill (clean markdown) | `WebFetch` raw |
| QMD semantic search (vault) | `qmd query "..."` | `qmd search "..."` (keyword) |
| Calendar (all 4) | `gws-personal calendar events list` | n/a — no MCP per `rules/google-workspace.md` |
| Email scan | `gws-personal gmail users messages list` / `gws-emprise ...` | n/a — no MCP per rules |
| Granola transcripts | `granola meeting list/get` via Bash | `mcp__*__get_meetings` (deferred) |
| iMessage context | `~/.maxos/workspace/tools/imessage-scan` | direct `sqlite3` on `chat.db` |
| Sub-agent dispatch (builders) | `Agent` tool → `frontend-builder`, `backend-builder`, `qa-tester` | n/a |
| QA loop pattern | `looper` skill | manual loop in scout |
| Prototype preview (local URL) | `mcp__Claude_Preview__preview_start` | dev-server via Bash |
| Prototype deploy (production URL) | `mcp__93e07175-*__deploy_to_vercel` | Claude Preview local URL |
| Prototype testing (browser validation) | `webapp-testing` skill (Playwright) | `mcp__Claude_in_Chrome` |
| Telegram delivery | Existing daemon channel (auto) | n/a — direct API would bypass safety |
| Telegram reply capture | New inbound logger in `src/channels/telegram.ts` → JSONL | n/a — deterministic bridge is required |
| Output deslop pass | `deslop` skill on brew draft before send | n/a — required pre-send |

**Tool rules that must be enforced:**

- **NEVER** use `mcp__*Google_Calendar__*` or `mcp__*Gmail__*` (banned per `rules/google-workspace.md` — causes session crashes). Always gws CLI.
- **NEVER** run `gws auth login` from the daemon (hangs forever). On auth errors: report the command to Mark, continue with what you have.
- **NEVER** touch credential files (`.enc`, `credentials.json`) per `SOUL.md` Credential File Guardrail.
- **Process Emprise gws operations sequentially** — credential file swap is not atomic.
- All Bash commands in tasks must `cd ~/Projects/maxos` or use absolute paths first.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scout picks a bad candidate → waste overnight build | Confidence gate (≥4.2/5) is the primary safeguard; wasted run is at worst one night of idle CPU |
| Builder pipeline runs away | Same-failure-twice detection + 6h scheduler timeout |
| Telegram reply logger misses a reply (bug or race) | Brew treats missing reply as "hold" (no penalty), logs the miss for manual check |
| Mark replies with something unexpected (neither A nor B) | Regex parse falls through to "ambiguous" → asks in today's brew to clarify |
| Near-match check (30-day dedup) false-negatives same topic | 3-keyword tag system + semantic similarity ≥ 0.85 threshold; Mark can manually add to `covered-topics.md` to force dedup |
| Overnight build deploys something broken to Vercel | qa-tester PASS required before deploy; on Vercel error, fall back to Claude Preview or repo-only |
| Scout's 6h window exhausts without a usable build | Explicit "ran out of time, partial work at <path>" message in brew — honest reporting, not silent failure |
| Sabbath/date-night gate drift | Deterministic cron schedule (cron days 0-3 for scout = Sun–Wed) — hard-coded, can't accidentally run |

## Open questions (for Mark before implementation)

None blocking — all decisions resolved in conversation. Any questions after review go inline here.

## Implementation plan

Handed off to `superpowers:writing-plans` skill after Mark approves this spec.

### Likely phasing (planner's call)

The plan may split into three phases for safer rollout — not a hard requirement, but a hint for the planner:

- **Phase 1 — Brew shell + daily cycle**: replace `ai-briefing.md` with `morning-brew.md` (AI section only, no Prime Framework, no Learning). Add the Telegram reply logger to the daemon. Add state directory and archive. Validates the core pipeline end-to-end.
- **Phase 2 — Learning breadcrumb**: add Learning section with A/B loop, streak counter, `state.json` track, first YouTube picker.
- **Phase 3 — Prime scout + overnight builder**: add `prime-scout.md`, builder agent orchestration, Vercel deploy, `prime-hit.json`. Highest-risk phase.
- **Phase 4 — Self-improvement loop**: add `weekly-brew-introspection.md` and `tuning.md` nudge algorithm.

Each phase is independently shippable; brew degrades gracefully when later phases aren't live yet (e.g., brew without `prime-hit.json` just omits that section).
