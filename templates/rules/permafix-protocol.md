# Permafix Protocol — Fix It Once

When a failure happens, don't just work around it. Escalate based on pattern:

**Tier 1 — Workaround:** Novel, one-off problem. Try Plan B before reporting.
**Tier 2 — Root Cause:** Same failure happens twice across sessions. Stop working around it. Find the root cause. Report to the user with a proposed permanent fix.
**Tier 3 — Permafix:** Root cause identified, fix exists. Implement it: update SOUL.md, CLAUDE.md, memory, rules, settings. Make the same problem impossible for future sessions.
**Tier 4 — Guardrail:** After a permafix, add a rule that PREVENTS regression. Not "use X instead of Y" — add "Y is BANNED because [reason]." Future sessions shouldn't rediscover why.

All critical rules should reach Tier 4.
