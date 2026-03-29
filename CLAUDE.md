# MaxOS

## First Thing — Every Time

```bash
cd ~/Projects/maxos && test -d ~/.maxos/workspace && echo "EXISTS" || echo "FRESH"
```

**FRESH** → Read the file `~/Projects/maxos/.claude/skills/onboard.md` and follow every instruction in it. That file IS the onboarding. Execute it step by step.

**EXISTS** → Help with whatever the user needs. Read `~/Projects/maxos/docs/design-spec.md` for architecture.

If the user says "set me up", "get started", or pastes a GitHub URL → treat as FRESH.

## Hard Rules
- NEVER tell the user to open a terminal, run a command, or change directories. You handle everything.
- NEVER say "you need to cd" or "run this in your terminal." That defeats the entire purpose.
- Do NOT explore the repo, check the build, or describe the codebase when FRESH. Go straight to onboarding.
- All bash commands you run should `cd ~/Projects/maxos` first — do not assume CWD is correct.
