# MaxOS recovery procedures

When something's wrong, this is the runbook. Each entry: **symptom → fast diagnostic → recovery commands**. Designed so you can copy-paste fixes from your phone if needed.

Always start with the same first step: `node ~/Projects/maxos/dist/src/doctor.js`. The doctor runs 11 checks and almost always names the actual problem.

---

## Daemon won't start

**Symptom**
- `/status` doesn't reply in Telegram.
- `curl http://127.0.0.1:18790/health` returns connection refused.
- `launchctl print gui/$(id -u)/com.maxos.daemon` shows state ≠ running.

**Fast diagnostic**

```bash
launchctl print gui/$(id -u)/com.maxos.daemon | grep -E "state|last exit code"
tail -50 ~/.maxos/daemon.stderr.log
```

**Most common causes + fixes**

1. **Port 18790 is held by a zombie process.** Restart will fail with `EADDRINUSE`.

   ```bash
   lsof -ti :18790 | xargs kill -9
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

2. **HEARTBEAT.md has a syntax error.** Daemon starts then crashes during cron parse.

   ```bash
   tail -100 ~/.maxos/daemon.stderr.log | grep -i heartbeat
   # Open the offending file and check the cron expression on the failing line
   nano ~/.maxos/workspace/HEARTBEAT.md
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

3. **dist/ is stale or missing.** Code changed but never compiled.

   ```bash
   cd ~/Projects/maxos && npm run build
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

4. **state.json is corrupt** (rare — daemon load() catches JSON errors and falls back to empty state, but a write race can poison the file).

   ```bash
   # The daily backup runs at 5:30 AM; restore from the most recent
   ls -la ~/.maxos/state.*.json
   cp ~/.maxos/state.YYYY-MM-DD.json ~/.maxos/state.json
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

5. **node binary moved or NVM upgraded.** `launchd.plist` hardcodes the node path.

   ```bash
   which node                                                       # find current node
   launchctl print gui/$(id -u)/com.maxos.daemon | grep -A1 program # see what plist points at
   # If they differ, edit ~/Library/LaunchAgents/com.maxos.daemon.plist with the right path
   launchctl unload ~/Library/LaunchAgents/com.maxos.daemon.plist
   launchctl load ~/Library/LaunchAgents/com.maxos.daemon.plist
   ```

---

## Telegram silent — daemon up, no messages reach Mark

**Symptom**
- `/status` doesn't reply.
- `curl http://127.0.0.1:18790/health` shows `channels: [{ name: "telegram", healthy: false }]`.

**Fast diagnostic**

```bash
node ~/Projects/maxos/dist/src/doctor.js --fast        # daemon check shows healthy=false
tail -100 ~/.maxos/daemon.stderr.log | grep -iE "telegram|409|polling"
```

**Most common causes + fixes**

1. **Competing Telegram poller** (two processes claiming the same bot). Telegram returns 409 conflict.

   ```bash
   # Kill anything calling getUpdates besides the daemon
   ps aux | grep -iE "telegram|getUpdates" | grep -v grep
   kill <competing-PID>
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

2. **TELEGRAM_BOT_TOKEN expired or revoked**. Check the bot is still alive via getMe.

   ```bash
   TOKEN=$(grep ^TELEGRAM_BOT_TOKEN= ~/.maxos/.env | cut -d= -f2-)
   curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | python3 -m json.tool
   ```

   If `ok: false`, regenerate the token via @BotFather, update `~/.maxos/.env`, restart daemon.

3. **Network blip during long-poll**. The adapter retries with exponential backoff; if it's been silent for >5 minutes, force-restart.

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

---

## Scheduler hung — scheduled tasks stop firing

**Symptom**
- `/status` shows "0 task(s) fired in last 6h" or stale `Last 6 scheduled runs`.
- The doctor's `recent-task-activity` check FAILs.

**Fast diagnostic**

```bash
node ~/Projects/maxos/dist/src/doctor.js
# Look at /status detail for tasks marked as disabled / failing
```

**Most common causes + fixes**

1. **Circuit breaker disabled tasks after 3 consecutive failures.**

   ```bash
   # See which tasks are disabled
   python3 -c "import json; d=json.load(open('/Users/Max/.maxos/state.json')); print(d['scheduler'].get('disabled', []))"

   # Re-enable a task by deleting it from the disabled array, then restart
   # Or run via the daemon API:
   curl -X POST -H "Content-Type: application/json" -d '{"name":"<task-slug>"}' \
     http://127.0.0.1:18790/api/cron/enable
   ```

2. **The daemon process is alive but the cron loop is wedged.** Rare — caused by an unhandled rejection deep in a runner.

   ```bash
   # Check for unhandled rejections in stderr
   tail -200 ~/.maxos/daemon.stderr.log | grep -i "unhandledRejection\|UnhandledPromiseRejection"
   # Force restart
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

3. **HEARTBEAT.md was edited and the new file is invalid.** The watchFile reload happens every 5s; bad cron expressions silently drop tasks.

   ```bash
   # Compare expected vs loaded task count
   tail -50 ~/.maxos/daemon.stdout.log | grep scheduler_loaded
   # The taskCount should match the bullet-points-with-cron count in HEARTBEAT.md
   grep -cE "^- " ~/.maxos/workspace/HEARTBEAT.md
   ```

---

## Brief / brew / debrief missed today

**Symptom**
- The 6:00 brief, 6:15 brew, or 16:35 debrief didn't land in Telegram.
- The xx:33 critical-task watchdog should have fired an alert about it.

**Fast diagnostic**

```bash
# Was it skipped due to concurrency?
grep skipped_concurrency ~/.maxos/daemon.stdout.log | tail -5
# Was it skipped due to circuit breaker?
grep -E "circuit_breaker|disabled" ~/.maxos/daemon.stdout.log | tail -10
# What does state say about its lastRun?
python3 -c "import json; d=json.load(open('/Users/Max/.maxos/state.json')); 
for k,v in d['scheduler']['lastRun'].items():
    if 'brief' in k.lower() or 'brew' in k.lower() or 'debrief' in k.lower():
        print(k, '→', v)"
```

**Recovery: fire it manually as a one-shot**

```bash
FIRE_AT=$(node -e "console.log(Date.now() + 5000)")
curl -X POST -H "Content-Type: application/json" \
  -d "{\"fireAt\":${FIRE_AT},\"prompt\":\"Run the morning brief: read tasks/morning-brief.md and execute every step\",\"silent\":false}" \
  http://127.0.0.1:18790/api/oneshot
```

Replace the prompt body for `morning-brew`, `shutdown-debrief`, etc.

---

## Loops re-appearing after Mark drops them

**Symptom**
- Morning brief surfaces a loop you explicitly closed yesterday.
- Or: a Google Task you deleted shows back up.

**Fast diagnostic**

```bash
# Is it in dropped-loops.md?
grep -i "<topic-keyword>" ~/.maxos/workspace/memory/dropped-loops.md
# Is it still in open-loops.json?
cat ~/.maxos/workspace/memory/open-loops.json | python3 -m json.tool
# Did closures-to-loops drop it on the next cycle?
grep -i "<topic-keyword>" ~/.maxos/workspace/memory/closures-*.md
```

**Recovery**

1. Add an explicit drop entry to `dropped-loops.md`:

   ```bash
   echo '- **<Topic Title>** — dropped '"$(date +%Y-%m-%d)"'. Reason: <why>.' >> ~/.maxos/workspace/memory/dropped-loops.md
   ```

2. Manually edit `open-loops.json` to remove the offending entry.
3. The daemon's startup-prune (`gateway:pruned_dropped_loops`) handles this on next restart, OR the closure-watcher's xx:33 cycle runs `applyDropDecisionsToLoops` against today's closures.

---

## OpenRouter / scout failing

**Symptom**
- Scout output says "no fresh scout" in the brew.
- Doctor's `openrouter` check FAILs.

**Fast diagnostic**

```bash
node ~/Projects/maxos/dist/src/openrouter-smoke.js
```

The smoke test surfaces the actual error: rate-limit, model-deprecated, key-revoked, network.

**Most common causes**

1. **Free-tier rate limit hit.** Wait 5-15 minutes, retry.

2. **Model returns null content** — usually means `reasoning: { exclude: true }` or `max_tokens >= 200` is missing in some prototype's code. Re-read `tasks/prime-scout.md` § "Reasoning-model gotcha".

3. **Key revoked or rotated.**

   ```bash
   # Update the env file
   nano ~/.maxos/.env  # set OPENROUTER_API_KEY
   # Daemon picks up env on restart
   launchctl kickstart -k gui/$(id -u)/com.maxos.daemon
   ```

---

## gws-personal / Google Workspace auth expired

**Symptom**
- Calendar pulls fail in morning brief.
- `gws-personal gmail +triage` returns `invalid_grant` or `Token has been expired or revoked`.

**Fast diagnostic**

```bash
gws-personal auth status
```

**Recovery**

The weekly auto-reauth job (`scripts/gws-auto-reauth.sh`) runs Sunday — usually catches this before Mark notices. Manual fix:

```bash
gws-personal auth login
# Browser opens, sign in, accept scopes. Done.
```

For Emprise:

```bash
gws-emprise auth login
```

**Important:** The daemon NEVER runs `auth login` itself (it would hang waiting for browser input). Mark always handles re-auth manually.

---

## Granola CLI not authenticated

**Symptom**
- `granola-sync` task surfaces "Authentication required" in shutdown debrief.
- Meeting prep / reply lookup misses recent meetings.

**Fast diagnostic**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
granola meeting list --limit 1
```

**Recovery**

Open the Granola desktop app on the Mac. The CLI uses the desktop app's auth token; opening the app refreshes it.

If that doesn't work, sign out and back in inside the Granola desktop app.

---

## Notion sync producing duplicates again

**Symptom**
- Two pages with the same name appear in Notion.
- Mark's edits to a vault file aren't reflected.

**Fast diagnostic**

```bash
# Check sync state for orphan mappings
python3 -c "import json; s=json.load(open('/Users/Max/.maxos/workspace/services/notion-sync/state.json'))
for db,info in s['databases'].items():
    print(db, ':', len(info.get('files', {})), 'files')"
```

**Recovery**

The sync now does title-dedup before creating pages. If you still see duplicates:

1. Manually delete (archive) the duplicate page in Notion.
2. Find the entry in `services/notion-sync/state.json` and update `notionPageId` to the surviving page's id, clear `contentHash` so the next sync re-pushes.
3. Force a sync: `cd ~/.maxos/workspace/services/notion-sync && node sync.mjs`

---

## Voice violations spiking

**Symptom**
- `/status violations` shows >30 violations in 24h.
- Daily digest at 21:25 calls it out.

**Diagnostic + recovery**

The mandate in SOUL.md instructs the agent to apply deslop discipline before sending. If it's not holding:

```bash
# See what's getting flagged
node ~/Projects/maxos/dist/src/voice-violations-summary.js
# See the actual messages with violations
tail -10 ~/.maxos/workspace/memory/voice-violations.jsonl | python3 -m json.tool
```

If a specific phrase keeps appearing, add it to `~/.maxos/workspace/voice/anti-patterns.md` so the scanner catches it explicitly. The session-start pickup will reinforce the ban on the next chat session reset.

---

## Workspace git backup stopped working

**Symptom**
- Doctor's `workspace-git` check shows "last commit XXh ago" with X > 30.

**Diagnostic + recovery**

```bash
cd ~/.maxos/workspace
git status                     # any merge conflicts?
git log -3 --oneline           # last commits
# Manually run the snapshot
git add -A && git commit -m "manual snapshot $(date '+%Y-%m-%d %H:%M')"
```

If the repo is wedged, easiest is to nuke and re-init (you don't lose anything because all real data is the working tree, not git):

```bash
rm -rf ~/.maxos/workspace/.git
cd ~/.maxos/workspace && git init -q && git add -A && \
  git -c user.email=maxos@localhost -c user.name=MaxOS commit -q -m "re-init $(date '+%Y-%m-%d')"
```

---

## Disk full

**Symptom**
- Tasks fail with `ENOSPC: no space left on device`.

**Fast diagnostic**

```bash
df -h ~/.maxos
du -sh ~/.maxos/workspace/memory/archive/    # journal archive
du -sh ~/.maxos/state.*.json                  # state backups
du -sh ~/.maxos/workspace/.git/                # workspace git history
du -sh ~/.maxos/inbox/                        # downloaded media
```

**Recovery — least-risky cleanup, in order**

```bash
# 1. Old inbox attachments (downloads from Telegram media)
find ~/.maxos/inbox -mtime +30 -delete
# 2. Old state snapshots (rotation already prunes >7d, but verify)
find ~/.maxos -maxdepth 1 -name 'state.*.json' -mtime +7 -delete
# 3. Old journal archives
ls ~/.maxos/workspace/memory/archive/ | head
# 4. Workspace git gc
cd ~/.maxos/workspace && git gc --aggressive --prune=now
```

---

## Nuclear option: clean restart

When everything's wrong and you just want a working daemon:

```bash
# 1. Stop everything
launchctl unload ~/Library/LaunchAgents/com.maxos.daemon.plist 2>/dev/null
lsof -ti :18790 | xargs kill -9 2>/dev/null
pkill -f "dist/src/index.js" 2>/dev/null

# 2. Verify state files are sane (don't delete them — they have your data)
node ~/Projects/maxos/dist/src/doctor.js --fast

# 3. Rebuild
cd ~/Projects/maxos && npm run build

# 4. Start
launchctl load ~/Library/LaunchAgents/com.maxos.daemon.plist
sleep 5
curl -s http://127.0.0.1:18790/health
```

This is non-destructive — workspace files, memory, state, .env all stay untouched. You're just bouncing the daemon process.

---

## Where to get more signal

When the doctor + this runbook don't tell you enough:

| File | What it tells you |
|---|---|
| `~/.maxos/daemon.stdout.log` | Every gateway log line — task fires, deliveries, prunes, watchdog hits |
| `~/.maxos/daemon.stderr.log` | Exceptions, unhandled rejections, Claude CLI subprocess errors |
| `~/.maxos/crash.log` | Daemon-level events: starts, stops, watchdog timeouts |
| `~/.maxos/state.json` | Live scheduler state — failures, disabled tasks, lastRun map |
| `~/.maxos/workspace/memory/voice-violations.jsonl` | Every outbound that breached the deslop rules |
| `~/.maxos/workspace/memory/outbound-events.jsonl` | Every Telegram send, with timing + status |
| `~/.maxos/workspace/memory/brief-issues.jsonl` | Every brief / debrief / brew that was missing required sections |
| `~/.maxos/workspace/memory/closures-*.md` | What MaxOS believes Mark closed each day |

When you find something the runbook doesn't cover, add it here. Future-you will thank present-you.
