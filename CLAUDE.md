# MaxOS

## First Thing — Every Time

```bash
test -d ~/.maxos/workspace && echo "EXISTS" || echo "FRESH"
```

**FRESH** → Run the onboarding: `Skill("onboard")`
**EXISTS** → Help with whatever the user needs. Read `docs/design-spec.md` for architecture.

If the user says "set me up", "get started", or pastes a GitHub URL → treat as FRESH.

Do NOT explore the repo, check the build, or describe the codebase when the result is FRESH. Go straight to the skill.
