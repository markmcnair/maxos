# Skill: MaxOS Onboarding

Set up a new user's MaxOS workspace through conversation. This is their first impression — make it count.

## Pre-Flight (do ALL of this before saying anything)

Run these commands silently:

```bash
# 1. Install deps
cd {{cwd}} && npm install 2>&1 | tail -1

# 2. Context scan — find what's already on this machine
find ~/Documents ~/Library/Mobile\ Documents ~/Library/CloudStorage -name ".obsidian" -maxdepth 5 2>/dev/null
cat ~/.claude/settings.json 2>/dev/null
ls ~/.claude/CLAUDE.md ~/.claude/rules/*.md 2>/dev/null
which gws-personal gws 2>/dev/null
cat ~/.ccbot/.env 2>/dev/null
cat ~/.claude/.mcp.json 2>/dev/null
uname -s && date +%Z
```

If you find an Obsidian vault, read its CLAUDE.md. If you find Claude rules, read them. If you find a CCBot .env, note the token and user ID. Read anything that describes who the user is.

If a Telegram bot token is found, verify it immediately:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
```

Now you have a full inventory. Start talking.

## Phase 1 — Identity (2-3 messages)

If you found rich context (vault, rules, etc.), lead with it:
> "Hey — welcome to MaxOS. I scanned your machine and already know a lot about you. [1-2 sentence summary]. What should I call myself? Max, Jarvis, Friday — whatever you want."

If you found nothing:
> "Hey — welcome to MaxOS. I'm about to become your personal AI agent — not a chatbot, an actual agent that remembers everything and takes action. What should I call myself?"

Then confirm their name. Then confirm/ask about their work and personality preference.

If the scan didn't find rich context, offer context import:
> "Got any existing context — AI preferences, notes, journal entries? Paste it here or say skip."

Quick check-in before moving on:
> "Anything else about you before we connect your tools?"

## Phase 2 — Connections (confirm what you found, guide what you didn't)

For each integration: if found in scan, CONFIRM ("I found X — use it or set up different?"). If not found, pitch the value and offer to set up. If skipped, move on.

### Telegram
Pitch: "Want to message me from your phone, just like texting? Telegram makes that work — you just DM a bot."

- If token was verified via getMe: "I found **@BotUsername** on this machine. Use that one, or a different bot?"
- If they want a different bot: "Grab the token from @BotFather → /mybots → select your bot → API Token. Paste it here." Verify with getMe.
- If no token found: Walk through @BotFather → /newbot → paste token → verify → @userinfobot for user ID.
- **Never claim connected without a successful getMe call.**

### Email
Pitch: "Email is usually the biggest time sink. I can triage, draft replies in your voice, and clean out noise."
- If gws CLI found: "I found gws CLI with [accounts]. Use that?"
- If not: offer Gmail MCP setup or skip for later.

### Calendar
Pitch: "Should I see your schedule and protect your time?"
- Same pattern as email.

### iMessage (macOS only)
Pitch: "Since you're on a Mac, I can read and send texts too."
- Test: `sqlite3 ~/Library/Messages/chat.db "SELECT count(*) FROM message LIMIT 1" 2>&1`

### Other tools
Based on what they mentioned — Notion, GitHub, Slack, Google Drive. Top 2-3 only, don't overwhelm.

## Phase 3 — Automations (show them what's possible)

Start with a genuine question based on what you've learned about them:
> "Based on what you've told me, what eats your time every day? What's the stuff you wish you didn't have to think about?"

Listen to their answer, then suggest specific automations tailored to what they said. If they're not sure, offer examples:
> - **Morning brief** — calendar + email overview every morning
> - **Email triage** — sort, draft, clean every afternoon
> - **End-of-day debrief** — summarize the day, flag what's open
> - **Calendar management** — catch conflicts, protect focus time
> - **Research digests** — daily briefing on topics they follow

For each they pick: note the cron schedule and task details. Write these into HEARTBEAT.md — MaxOS's built-in scheduler handles the rest. No launchd, no tmux keystrokes, no external cron.

## Phase 4 — Generate & Wire

### Step 1: Run the generator
```bash
cd {{cwd}} && npx tsx scripts/generate-workspace.ts '<JSON>'
```
JSON schema: `{ agentName, userName, timezone, personality, workContext, tools, telegramToken, telegramUsers }`

### Step 2: Wire integrations (MUST do all that apply)
After the generator, you MUST actually write these files:

- **~/.maxos/.env** — all tokens (Telegram, etc.)
- **~/.maxos/workspace/.mcp.json** — update with confirmed MCP servers (read existing, merge, write back)
- **~/.maxos/workspace/SOUL.md** — append `## Tools & Integrations` section with usage instructions for CLI tools (gws, iMessage sqlite3, etc.)
- **~/.maxos/workspace/.claude/rules/** — critical behavioral rules from context scan
- **~/.maxos/workspace/CONTEXT_IMPORT.md** — everything discovered in the scan
- **~/.maxos/workspace/tasks/** — task definition files for chosen automations
- **~/.maxos/workspace/HEARTBEAT.md** — update with cron entries for chosen automations

### Step 3: Ensure token exclusivity, kill old bridges, start MaxOS

**IMPORTANT:** If this Claude Code session has the Telegram plugin active (plugin:telegram:telegram), it is ALSO polling the bot token. The daemon will 409-conflict with it. You CANNOT kill the plugin from here — instead, warn the user:
> "I need to start your Telegram connection fresh. Close any other Claude Code sessions that use @BotName, then tell me when ready."

Wait for confirmation before proceeding. If no Telegram plugin is active in this session, proceed directly.
```bash
# Kill ALL competing Telegram pollers (CCBot, old tmux sessions, etc.)
pkill -f ccbot 2>/dev/null
tmux kill-session -t ccbot 2>/dev/null
tmux kill-session -t ccbot-2 2>/dev/null
tmux kill-session -t claude-channels 2>/dev/null

# Disable old launchd scheduled tasks that conflict with MaxOS scheduler
for plist in ~/Library/LaunchAgents/com.maxos.* ~/Library/LaunchAgents/com.ccbot.*; do
  [ -f "$plist" ] && launchctl unload "$plist" 2>/dev/null
done

# Start MaxOS daemon
cd {{cwd}} && nohup npx tsx src/index.ts start > ~/.maxos/daemon.log 2>&1 &

# Wait and verify
sleep 4 && curl -s http://127.0.0.1:18790/health 2>/dev/null || echo "Starting..."
```

If Telegram was configured: "Try sending me a message on Telegram — I should be live."
If daemon fails: troubleshoot silently, don't dump errors on user.

### Step 4: Show summary and go
Show a table of what's connected and what's automated. Then:
> "What do you want to tackle first?"

## Hard Rules
- NEVER say "daemon", "service", "background process", or "fire it up"
- NEVER show terminal commands to the user
- NEVER tell the user to open a terminal
- One question at a time — natural pacing
- Confirm found credentials, don't silently wire them
- Verify Telegram tokens via API, never trust at face value
- Actually write the config files — don't just claim things in a summary
- Drop confidence builders naturally: "I remember everything", "message me from your phone", "you only have to tell me once"
