# Skill: MaxOS Setup

Connect tools, discover automations, and wire up a MaxOS workspace. This is the intelligent half of onboarding — `npx maxos init` handles identity and workspace generation; this skill handles everything that benefits from judgment.

**IMPORTANT:** Go directly to Pre-Flight. Do NOT read README.md, package.json, or other repo files first — this skill has everything you need.

## Pre-Flight

**Step 0: Say something FIRST.** Before running any commands, greet the user so they know you're alive:
> "Setting up your tools and connections. Scanning your machine — one sec."

Then run these commands (batch what you can):

```bash
# 1. Check if workspace exists (did the user run `npx maxos init`?)
ls ~/.maxos/workspace/SOUL.md ~/.maxos/workspace/USER.md ~/.maxos/maxos.json 2>/dev/null

# 2. Context scan — find what's already on this machine
find ~/Documents ~/Library/Mobile\ Documents ~/Library/CloudStorage -name ".obsidian" -maxdepth 5 2>/dev/null
cat ~/.claude/settings.json 2>/dev/null
ls ~/.claude/CLAUDE.md ~/.claude/rules/*.md 2>/dev/null
compgen -c 2>/dev/null | grep '^gws-' || ls ~/bin/gws-* /usr/local/bin/gws-* 2>/dev/null | xargs -n1 basename 2>/dev/null
cat ~/.ccbot/.env 2>/dev/null
cat ~/.claude/.mcp.json 2>/dev/null
uname -s && date +%Z
```

If you find an Obsidian vault, read its CLAUDE.md. If you find Claude rules, read them. If you find a CCBot .env, note the token and user ID. Read anything that describes who the user is.

If a Telegram bot token is found (in .env or CCBot config), verify it immediately:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
```

### If workspace already exists (init was run)

Read `~/.maxos/workspace/SOUL.md` and `~/.maxos/workspace/USER.md` to understand the agent's identity and user profile. Confirm briefly:
> "I see you've already set up [agentName] for [userName]. Let's connect your tools."

Skip to **Phase 1 — Connections**.

### If NO workspace exists (init was not run)

The user skipped `npx maxos init` and came straight to Claude Code. You need to collect identity info first, then generate the workspace before connecting tools.

1. Collect: agent name, user name, timezone, personality, work context, tools, context import (optional)
2. If Telegram: token + user ID (verify with getMe)
3. Ask primary channel preference
4. Run the generator:
   ```bash
   cd ~/Projects/maxos && npm install 2>&1 | tail -1
   cd ~/Projects/maxos && npx tsx scripts/generate-workspace.ts '<JSON>'
   ```
   JSON schema: `{ agentName, userName, timezone, personality, workContext, tools, telegramToken, telegramUsers, primaryChannel, contextImport }`

   **CRITICAL: `telegramUsers` must be an array of string IDs, NOT objects.**
   - **RIGHT:** `"telegramUsers": ["123456789"]`
   - **WRONG:** `"telegramUsers": [{"id": 123456789, "name": "Alice"}]`

Then proceed to Phase 1.

## Phase 1 — Connections (confirm what you found, guide what you didn't)

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
- GWS wrappers were already discovered in pre-flight. Each wrapper is a separate Google account. Confirm ALL of them with the user: "I found gws-personal and gws-emprise. Want both connected?"
- **PATH fix:** If wrappers are in `~/bin/` but `which gws-personal` fails, the daemon won't find them either. Add to PATH before verifying:
  ```bash
  export PATH="$HOME/bin:$PATH"
  ```
  The MaxOS engine automatically adds `~/bin` to the subprocess PATH, so this only matters for verification during onboarding.
- **Verify EACH wrapper actually works** before confirming:
  ```bash
  export PATH="$HOME/bin:$PATH"
  gws-personal gmail +triage 2>&1 | head -5
  gws-emprise gmail +triage 2>&1 | head -5    # if exists
  ```

  #### If a wrapper fails auth

  **CREDENTIAL FILE GUARDRAIL — READ THIS BEFORE TOUCHING ANYTHING**

  Some gws wrappers (especially secondary accounts like `gws-emprise`) use fragile credential file swap techniques — moving `.enc` files, copying plaintext credentials, running gws, then restoring. **You MUST NOT:**
  - Move, copy, rename, or delete any `.enc` file
  - Move, copy, rename, or delete `credentials.json` or `credentials-*.json`
  - Run `openssl`, `python3 -c "from cryptography..."`, or any decryption command on credential files
  - Attempt to "fix" a wrapper by manipulating its credential storage

  **These operations WILL corrupt the user's auth for ALL accounts, not just the broken one.**

  **What you CAN do for a failing wrapper:**
  1. Run `gws-personal auth status 2>&1` to check token status
  2. If token is expired/invalid, run `auth login` and open the browser URL:
     ```bash
     # Capture the auth URL from the login command
     AUTH_OUTPUT=$(gws-personal auth login 2>&1 &)
     sleep 3
     # Extract and open the URL (macOS)
     AUTH_URL=$(echo "$AUTH_OUTPUT" | grep -o 'https://accounts.google.com/[^ ]*')
     [ -n "$AUTH_URL" ] && open "$AUTH_URL"
     ```
  3. Tell the user: "A Google sign-in page should have opened. Complete the sign-in and let me know when done."
  4. After user confirms, verify again with `+triage`.

  **If `auth login` doesn't work for a wrapper** (common with secondary accounts that use credential file swaps):
  - **Do NOT try to debug the wrapper's internals.** Report to the user:
    > "I can connect [wrapper-personal] but [wrapper-secondary] uses a custom auth setup I shouldn't touch during setup. You'll want to verify that one manually after we're done — just run `gws-secondary gmail +triage` to test it."
  - Mark it as "needs manual verification" and move on. Do NOT block setup on a secondary account.

  **The priority is: leave all accounts in the SAME state they were in before setup. Breaking a working account to fix a broken one is unacceptable.**

- If not found: offer Gmail MCP setup or skip for later.

### Calendar
Pitch: "Should I see your schedule and protect your time?"
- Same gws wrappers serve calendar. Verify with actual API call:
  ```bash
  gws-personal calendar +agenda 2>&1 | head -5
  ```
  If broken, use the same safe auth flow as email (auth login + browser open). **Same credential file guardrail applies — NEVER manipulate .enc or credentials files.**

### iMessage (macOS only)
Pitch: "Since you're on a Mac, I can read and send texts too."
- Test: `sqlite3 ~/Library/Messages/chat.db "SELECT count(*) FROM message LIMIT 1" 2>&1`

### Granola (meeting notes)
If Granola.app is running (`pgrep -i granola`):
- **CC connectors (mcp__*Granola*) do NOT transfer to the daemon.** They are per-project.
- Check for the CLI (may be installed via nvm — use full PATH):
  ```bash
  export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  which granola 2>/dev/null && granola --version 2>&1
  ```
- If found: verify auth with `granola meeting list --limit 1 2>&1`. If auth fails, run `granola auth login`.
- If NOT found: `npm install -g granola-cli` to install it, then verify auth.
- The daemon's engine PATH includes the nvm bin dir, so `granola` will work in scheduled tasks.
- The granola-sync task must use `granola` CLI via Bash, NOT mcp__*Granola* tools.

### Other tools
Based on what they mentioned — Notion, GitHub, Slack, Google Drive. Top 2-3 only, don't overwhelm.

### ⚠️ MCP Connector Warning
Claude Code connectors (installed via the Claude UI) are NOT available in the MaxOS daemon. The daemon runs its own Claude sessions from `~/.maxos/workspace/`, which has its own `.mcp.json`. If a task needs a tool that's only available as a connector, rewrite it to use a CLI alternative via Bash. Common examples:
- Granola → use `granola-cli` instead of `mcp__*Granola*` tools
- Google Drive → use `gws` CLI or the drive MCP server

### Primary Channel
If not already set by `init`, ask:
> "When you say 'send me something' or I need to proactively reach you — what's the default? Telegram, iMessage, email?"

Whatever they pick becomes the `primaryChannel` in USER.md and gets written into SOUL.md's "How to reach" section.

### Final check before moving on

After confirming the tools above, one last question before launching:
> "Any other tools you want connected before we go live? Another email account, Notion, GitHub, Slack — now's the time."

If they mention something, wire it up (verify it works). If any tool from earlier is still pending (e.g., a gws wrapper mid-auth flow), resolve it now. Once they say they're good, move on.

## Phase 2 — Discover & Plan Automations

Before asking the user what they want, **discover what they already have**. This is critical — they may have scheduled tasks, routines, or automations that need to be ported, not rebuilt from scratch.

**IMPORTANT: Phase 2 is DISCOVERY ONLY. Do NOT write any files yet.** All file writes happen in Phase 3 after confirming with the user. Record what you find and what the user wants — Phase 3 will write everything.

### Scan for existing automations
```bash
# OpenClaw scheduled tasks
ls ~/.openclaw/tasks/ 2>/dev/null; cat ~/.openclaw/tasks/*.md 2>/dev/null
cat ~/.openclaw/schedule.json 2>/dev/null; cat ~/.openclaw/config.json 2>/dev/null

# Obsidian vault scheduled tasks (if vault was found in pre-flight)
find <VAULT_PATH>/Work/Scheduled\ Tasks -name "*.md" 2>/dev/null
# READ each file found — these contain full task definitions

# Existing cron jobs
crontab -l 2>/dev/null

# Launchd scheduled tasks (user agents)
ls ~/Library/LaunchAgents/*.plist 2>/dev/null | grep -v com.apple

# CCBot config
cat ~/.ccbot/tasks.json 2>/dev/null; cat ~/.ccbot/schedule.json 2>/dev/null
```

**READ every task file you find.** Extract: task name, schedule/frequency, what it does, and any prompts/instructions. These are the user's existing automations — they expect them to keep working. **Keep all of this in your context — you'll write the files in Phase 3.**

### Present what you found
> "I found [N] existing automations on your machine: [list them with schedule and description]. Want me to port all of these into MaxOS, or do you want to tweak anything first?"

### Then offer starter automations

After discovering existing automations, ALSO offer these three starter automations to ALL users (even those with no existing tasks). If the user already has a ported version of one of these, skip that one.

> "MaxOS comes with a few automations most people love. Want me to set any of these up?"
>
> **Morning brief** (6:00 AM) — Calendar overview + email scan + what's on deck today. [Want to see an example?]
> **Email triage** (3:55 PM) — Sort inbox, draft replies, clean out noise. [Want to see an example?]
> **Shutdown debrief** (4:25 PM) — Summarize the day, flag what's open, prep for tomorrow. [Want to see an example?]
>
> "Yes to all, pick and choose, or skip — your call."

If the user wants to see an example, show a sample output for that automation. If they accept, note it for Phase 3. If they decline, move on.

### Then ask what else is new
> "Anything else you want automated that you don't already have?"

Suggest additional ideas based on what you've learned about them (only if relevant):
> - **Calendar management** — catch conflicts, protect focus time
> - **Research digests** — daily briefing on topics they follow
> - **Weekly review** — reflect on the week, set intentions for next

### What you should have recorded by end of Phase 2

A list of all automations to create (ported + new + starter), each with:
- Task name (e.g., `morning-brief`, `email-triage`)
- Schedule (cron expression)
- Full task prompt content (from source files or generic defaults)

**Do NOT write any files.** Phase 3 handles all writes.

## Phase 3 — Wire Everything

### Step 0: Protected time windows

The template creates a default sleep window (22:00–06:00). Before wiring automations, confirm and extend:

> "Scheduled tasks won't fire during protected windows. Right now I have:
> - **Sleep:** 10 PM – 6 AM (no messages)
>
> Do you have any recurring off-limits times? Examples: a full day off, weekly family dinner, focus blocks, etc."

Whatever the user confirms, update `~/.maxos/maxos.json` — read it, modify `scheduler.protectedWindows`, write it back. Format:
```jsonc
{ "name": "family-time", "day": "sunday" }                   // full day
{ "name": "focus-block", "day": "wednesday", "start": "14:00" } // day + start (until midnight)
{ "name": "sleep", "start": "22:00", "end": "06:00" }       // time range (overnight OK)
```

If the user doesn't want any changes, move on — the default sleep window is already set.

### Step 1: Write integration config and task files

After the user confirms their automations, write everything:

- **~/.maxos/.env** — update with any new tokens (Telegram, etc.). Read existing first, merge, don't overwrite.
- **~/.maxos/workspace/.mcp.json** — update with confirmed MCP servers (read existing, merge, write back)
- **~/.maxos/workspace/SOUL.md** — append `## Tools & Integrations` section with usage instructions for CLI tools (gws, iMessage sqlite3, etc.)
- **~/.maxos/workspace/.claude/rules/** — critical behavioral rules from context scan
- **~/.maxos/workspace/CONTEXT_IMPORT.md** — everything discovered in the scan (if not already created by init)

#### Task files and HEARTBEAT.md

Write all the automations you recorded in Phase 2:

1. **Write each task file** to `~/.maxos/workspace/tasks/<task-name>.md`. Include ALL the detail from the source task — don't truncate or summarize. But **strip out any delivery/transport instructions** (see rules below).

2. **Update HEARTBEAT.md** — the generator already created it with default entries (45-min checkpoint, QMD maintenance). **Append** your task entries after the existing content. Do NOT overwrite the file — read it first, then append.

**Default task file contents (use these if no source task was found):**

**tasks/morning-brief.md:**
> Check today's calendar events across all connected calendars. Scan email inbox for anything urgent or time-sensitive. List today's scheduled tasks. Output a brief day overview: what's on the calendar, what needs attention, and 1-3 priorities for the day. Keep it scannable — bullet points, not paragraphs.

**tasks/email-triage.md:**
> Pull all inbox messages. For each message, categorize: reply needed, FYI/read later, or delete/unsubscribe. Draft short replies for anything that needs a response. Archive or label messages that don't need action. Output a summary: what was handled, what needs the user's eyes, and any drafts waiting for review.

**tasks/shutdown-debrief.md:**
> Summarize what happened today: tasks completed, decisions made, conversations had. Flag anything left open or unfinished. Check tomorrow's calendar for early commitments. Output a brief end-of-day summary and a short list of what's queued for tomorrow.

**CRITICAL: HEARTBEAT.md format rules:**
- Headings MUST be exactly 5-field cron: `minute hour day month dayofweek`
- Each entry should be a SHORT one-liner referencing the task file
- `## 0 6 * * 0-5` = 6:00 AM daily except Saturday
- `## 55 15 * * 0-5` = 3:55 PM daily except Saturday
- `## 25 16 * * 0-5` = 4:25 PM daily except Saturday
- `## Every 45 minutes` = natural language (also supported)

**WRONG:** `## 0 15 55 * * 0-5` (6 fields — parser will reject this)
**RIGHT:** `## 55 15 * * 0-5` (5 fields — minute first, then hour)

**HEARTBEAT.md entries should be SHORT — one line that references the task file:**
```markdown
## 0 6 * * 0-5
- Run the morning brief: read tasks/morning-brief.md and execute every step

## 55 15 * * 0-5
- Run email triage: read tasks/email-triage.md and execute every step

## 25 16 * * 0-5
- Run shutdown debrief: read tasks/shutdown-debrief.md and execute every step
```

**NOT long multi-line prompts pasted into HEARTBEAT.md.** The full instructions live in `workspace/tasks/`. HEARTBEAT.md is the schedule, `tasks/` is the content.

**DO NOT create "journal checkpoint" tasks.** The generator already created the 45-min checkpoint. Don't duplicate it.

**DO NOT include delivery instructions in task prompts.** The daemon automatically delivers task output to the user via their primary channel. Task prompts should NOT contain:
- "Send to chat_id 123456789" or any chat_id references
- "Deliver via Telegram" or "send via Telegram reply tool"
- curl/WebFetch calls to the Telegram Bot API
- Any mention of how to deliver the result

When porting tasks from other systems (Obsidian vault, OpenClaw, launchd), **strip out any delivery/transport instructions** from the original prompt. The daemon's delivery pipeline makes them unnecessary.

**DO NOT create RemoteTriggers or scheduled tasks on claude.ai.** MaxOS IS the scheduler. Everything goes through HEARTBEAT.md — local, reliable, no sandboxed cloud environments.

### Step 2: macOS file access permissions

On macOS, the system blocks apps from reading protected folders unless explicitly allowed. The MaxOS daemon needs this to work. Check and guide the user through it:

```bash
# Check if we're on macOS
if [ "$(uname -s)" = "Darwin" ]; then
  # 1. Test protected path access from THIS session
  ls ~/Library/CloudStorage/ 2>/dev/null | head -1
  ls ~/Library/Mobile\ Documents/ 2>/dev/null | head -1
  ls ~/Documents/ 2>/dev/null | head -1
  sqlite3 ~/Library/Messages/chat.db "SELECT 1" 2>/dev/null
  echo "File access check complete"

  # 2. Check ALL node binaries in the TCC database for FDA status.
  # IMPORTANT: Do NOT use `which node` — it returns a shim/symlink that won't
  # match TCC's stored canonical paths. Query TCC directly for any node entry.
  echo "--- Node FDA entries in TCC ---"
  sqlite3 /Library/Application\ Support/com.apple.TCC/TCC.db \
    "SELECT client, auth_value FROM access WHERE service='kTCCServiceSystemPolicyAllFiles' AND client LIKE '%node%'" 2>/dev/null
  echo "--- End TCC check ---"
fi
```

**How to interpret the TCC output:**
- `auth_value=2` means **FDA GRANTED** — that node binary is good
- `auth_value=0` means **FDA DENIED** — needs to be re-granted
- No output at all means **no node binary has ever been added to FDA**

**If ANY node binary shows auth_value=2, FDA is fine.** Tell the user:
> "Node has Full Disk Access — scheduled tasks will be able to read iMessage and protected files. ✓"

Then move on. Do NOT ask the user to do anything.

**Only if ALL entries show auth_value=0, or there are NO entries at all**, tell the user:

> "The MaxOS daemon needs Full Disk Access for the node binary (it runs outside your terminal). One-time fix:
> 1. Open **System Settings → Privacy & Security → Full Disk Access**
> 2. Click the **+** button, press Cmd+Shift+G
> 3. Paste: `[resolve the actual path with: readlink -f $(which node)]`
> 4. Toggle it on
>
> Without this, iMessage will work in Claude Code but silently fail in scheduled tasks."

**Do NOT skip this check.** But do NOT block the user if FDA is already granted. The #1 mistake here is flagging a problem that doesn't exist because the check used the wrong path.

### Step 3: Build, install globally, start daemon, verify

```bash
# Build
cd ~/Projects/maxos && npx tsc 2>&1 | tail -3

# Install globally so `maxos` CLI works everywhere (run-at, cron, status, etc.)
cd ~/Projects/maxos && npm link 2>&1 | tail -3

# Start (pre-flight is automatic — kills pollers, disables plugins, waits for Telegram lock)
cd ~/Projects/maxos && node dist/src/index.js start &
disown

# Wait and verify health
sleep 5 && curl -s http://127.0.0.1:18790/health 2>/dev/null || echo "Starting..."
```

**⚠️ DO NOT use `install-service`.** That creates a launchd plist with a stripped environment. Use `start` directly — it inherits the shell's PATH (including nvm, claude, etc.).

**⚠️ DO NOT manually kill pollers, disable plugins, or unload launchd agents.** The `start` command's pre-flight handles all of that deterministically. If you duplicate this work, you risk race conditions.

Once health check passes, verify the user actually receives messages:
```bash
# Read the bot token and user ID from config
TELEGRAM_BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN ~/.maxos/.env 2>/dev/null | cut -d= -f2)
TELEGRAM_USER_ID=$(cat ~/.maxos/maxos.json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['channels']['telegram']['allowedUsers'][0])" 2>/dev/null)
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_USER_ID}&text=MaxOS is live. You're connected." 2>/dev/null
```
Then: "I just sent you a test message on Telegram — check if you got it."

**Do NOT claim Telegram is working until the user confirms they received the test message.** A healthy daemon doesn't guarantee messages reach the user (wrong user ID, bot blocked, etc.).

If daemon fails: check `~/.maxos/daemon.log`, troubleshoot silently, don't dump errors on user.

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
