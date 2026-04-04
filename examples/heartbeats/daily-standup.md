# Heartbeat Tasks

## 0 6 * * 1-5 (Weekday morning brief at 6:00 AM)
- Run morning brief: Read tasks/morning-brief.md and execute every step. Deliver a concise summary of today's calendar, overnight emails, and top priorities.

## 0 10 * * 1-5 (Weekday mid-morning check at 10:00 AM)
- Check for anything that needs proactive attention. Review inbox for urgent items. If anything requires immediate action, alert the user. Otherwise, stay quiet.

## 0 14 * * 1-5 (Weekday afternoon email triage at 2:00 PM)
- Run email triage: Read tasks/email-triage.md and execute every step. Sort inbox, draft replies, flag urgent items, delete noise.

## Every 45 minutes
- Write a checkpoint to today's daily journal at memory/YYYY-MM-DD.md. Summarize what has happened since the last checkpoint. Keep it under 200 words. Append only.

## 30 16 * * 1-5 (Weekday EOD debrief at 4:30 PM)
- Run shutdown debrief: Read tasks/shutdown-debrief.md and execute every step. Summarize the day, flag open items, and prepare tomorrow's context.

## 55 5 * * * (Daily QMD maintenance at 5:55 AM)
- Run QMD maintenance: execute `qmd update && qmd embed` to re-index the workspace for semantic search.
