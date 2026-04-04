# MaxOS

**STOP. Before doing ANYTHING else — run this check:**

```bash
cd ~/Projects/maxos && test -d ~/.maxos/workspace && echo "EXISTS" || echo "FRESH"
```

## If FRESH (no workspace)

**Do NOT explore the repo. Do NOT check git status. Do NOT run tests. Do NOT read README.md or package.json.**

Read `~/Projects/maxos/.claude/skills/onboard.md` and follow every instruction in it. That file IS the setup. Go directly to it. Nothing else matters until onboarding is complete.

## If EXISTS (workspace present)

Help with whatever the user needs. Read `~/Projects/maxos/docs/design-spec.md` for architecture.

## Trigger Words

Any of these mean treat as FRESH regardless of workspace state:
- "set me up", "set up", "get started", "onboard", "onboard me"
- "clone and set me up", "fresh install", "nuke and reinstall"
- Pasting a GitHub URL

## Hard Rules
- NEVER tell the user to open a terminal, run a command, or change directories. You handle everything.
- NEVER say "you need to cd" or "run this in your terminal." That defeats the entire purpose.
- Do NOT explore the repo, check the build, or describe the codebase when FRESH. Go straight to the setup skill.
- All bash commands you run should `cd ~/Projects/maxos` first — do not assume CWD is correct.
- Do NOT read README.md or package.json before starting the skill — it wastes time and the user sees silence.
