# MaxOS

**STOP. Before doing ANYTHING else — run this check:**

```bash
test -d ~/.maxos/workspace && echo "MAXOS_LIVE"; test -d ~/.hermes && echo "HERMES_LIVE"
```

There are **three** states, not two. A missing `~/.maxos/workspace` is ambiguous
on its own — it can mean never-installed OR decommissioned. `~/.hermes` is what
tells them apart.

## If HERMES_LIVE without MAXOS_LIVE → RETIRED (this is the current state)

MaxOS is decommissioned on this machine. Max runs on **Hermes** in `~/.hermes`.
The launchd jobs `ai.maxos.cron` and `ai.maxos.telegram` are Hermes jobs that
kept the legacy name — they are live, and they are not MaxOS.

**Do NOT run the onboard skill. Do NOT run `npx maxos init` or
`node dist/src/index.js start`.** The `start` pre-flight kills pollers and
unloads launchd agents, which takes the live Hermes scheduler and Telegram bot
down and then contends for the same bot token — a silent outage.

Treat this repo as **source code only**: edit `src/`, build, and let the user
restart Hermes. Otherwise just help with what was asked.

## If MAXOS_LIVE → workspace present

Help with whatever the user needs. Read `~/Projects/maxos/docs/design-spec.md` for architecture.

## If neither → genuinely FRESH

**Do NOT explore the repo. Do NOT check git status. Do NOT run tests. Do NOT read README.md or package.json.**

Read `~/Projects/maxos/.claude/skills/onboard.md` and follow every instruction in it. That file IS the setup. Go directly to it. Nothing else matters until onboarding is complete.

## Two directories — know the split

MaxOS is deliberately split across two locations. Confusing them is the #1 cause of "I made a change and nothing happened."

| Directory | Contains | Public? | You work here when… |
|---|---|---|---|
| `~/Projects/maxos` | Source code, tests, build output, docs | **Yes** — GitHub repo `markmcnair/maxos` | Fixing bugs, adding features, upgrading how Max *works* |
| `~/.maxos` | Personal data: `workspace/` (memory, SOUL.md, HEARTBEAT.md, tasks/), `maxos.json` (bot tokens), `state.json`, logs, `crash.log` | **No** — local only | Tuning *what* Max does: schedules, personality, tasks, user config |

**The running daemon reads code from `~/Projects/maxos/dist/` and stores everything personal in `~/.maxos`.** Launchd enforces this: `ProgramArguments` points at the project dist, `WorkingDirectory` + `MAXOS_HOME` both point at `~/.maxos`.

Consequences:
- Code fix workflow: edit in `~/Projects/maxos/src/`, `npm run build`, restart daemon — it picks up the new code automatically (no copying).
- Config/task tweaks: edit in `~/.maxos/workspace/` — no rebuild, no restart usually needed (HEARTBEAT.md hot-reloads).
- Never commit `~/.maxos` contents to the repo. They're in a different directory entirely; `.gitignore` is the belt to that suspenders.
- If you're asked to "fix how the scheduler works" → Projects/maxos. If asked to "add a 7am task" → ~/.maxos/workspace/HEARTBEAT.md.

## Trigger Words

Any of these mean treat as FRESH — **but only if the state check above says
genuinely FRESH**:
- "set me up", "set up", "get started", "onboard", "onboard me"
- "clone and set me up", "fresh install", "nuke and reinstall"
- Pasting a GitHub URL

**A trigger word never overrides the state check.** If the check says RETIRED,
a trigger word is not permission to reinstall over a live Hermes — ask the user
whether they mean "fix this repo" or "actually replace Hermes", and wait.

## Hard Rules
- NEVER tell the user to open a terminal, run a command, or change directories. You handle everything.
- NEVER say "you need to cd" or "run this in your terminal." That defeats the entire purpose.
- Do NOT explore the repo, check the build, or describe the codebase when FRESH. Go straight to the setup skill.
- All bash commands you run should `cd ~/Projects/maxos` first — do not assume CWD is correct.
- Do NOT read README.md or package.json before starting the skill — it wastes time and the user sees silence.
