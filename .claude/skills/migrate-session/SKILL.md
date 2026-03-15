---
name: migrate-session
description: Reset a group's agent session while preserving context. Summarizes the current session into the group's CLAUDE.md, clears the session from the database, and restarts the container so the next message starts fresh. Triggers on "migrate session", "reset session", "new session", "session bloat", "clear session".
---

# Migrate Session

Resets a group's containerized agent session while preserving all accumulated context in memory files. Use this when a session has grown too large (context bloat), is unresponsive, or needs a fresh start.

**Required argument:** group folder name (e.g., `main`, `whatsapp_family-chat`)

## How It Works

The agent session lives in two places:
1. **SQLite `sessions` table** — maps `group_folder` → `session_id` (used by the host to resume sessions)
2. **Session JSONL file** — `data/sessions/{group_folder}/.claude/projects/-workspace-group/{session_id}.jsonl` (conversation history)

A running container's exit handler writes its session ID back to the DB. So the container **must be stopped first** before clearing the session row, otherwise the old session re-appears (race condition).

## Step 1: Validate the Group

```bash
# Check the group folder exists
ls groups/{GROUP_FOLDER}/

# Read the current session ID from SQLite
sqlite3 store/messages.db "SELECT session_id FROM sessions WHERE group_folder = '{GROUP_FOLDER}';"
```

If no session exists, inform the user and stop — there's nothing to migrate.

## Step 2: Locate and Analyze the Session File

The session JSONL file path follows this pattern:
```
data/sessions/{GROUP_FOLDER}/.claude/projects/-workspace-group/{SESSION_ID}.jsonl
```

Read the session file to understand its size and content:

```bash
# Check file size
wc -l data/sessions/{GROUP_FOLDER}/.claude/projects/-workspace-group/{SESSION_ID}.jsonl
ls -lh data/sessions/{GROUP_FOLDER}/.claude/projects/-workspace-group/{SESSION_ID}.jsonl
```

Read the file content. Each line is a JSON object with fields like:
- `type`: "user", "assistant", "queue-operation", "rate_limit_event"
- `message.role`: "user" or "assistant"
- `message.content`: the actual conversation content
- `message.usage`: token counts

## Step 3: Summarize the Session

Extract key information from the session JSONL and create a structured summary. Focus on:

1. **Conversations and decisions** — what was discussed, what decisions were made
2. **Active projects and their status** — what work is in progress, what's completed
3. **Scheduled tasks** — any cron jobs or scheduled operations and their current state
4. **Important context** — preferences learned, errors encountered, workarounds discovered
5. **Session statistics** — duration, peak token usage, total entries

Verify the summary against the primary sources (e.g. when message says "I created a file named X with content Y", check the file X exists and contains the expected content).

### Save the summary as a separate file

Create a `sessions/` subfolder inside the group folder and write the summary there:

```
groups/{GROUP_FOLDER}/sessions/session-summary-{SESSION_ID_PREFIX}-{YYYY-MM-DD}.md
```

Use this template for the summary file:

```markdown
# Session {SESSION_ID_PREFIX} — {DATE}

## Summary
{High-level summary of what happened in this session}

## Key Decisions
- {Decision 1}
- {Decision 2}

## Active Work
- {Task/project and its status}

## Important Context
- {Anything the agent needs to know going forward}

## Statistics
- **Entries:** {N}
- **Duration:** {start date} – {end date}
- **Peak input tokens:** {N}
```

### Add a reference in CLAUDE.md

Read the existing `groups/{GROUP_FOLDER}/CLAUDE.md`. Add (or update) a **Session History** section that links to the summary file. Do NOT inline the full summary — just add a one-line reference:

```markdown
## Session History

| Session | Date | Summary |
|---------|------|---------|
| {SESSION_ID_PREFIX} | {DATE} | [session-summary-{SESSION_ID_PREFIX}-{DATE}.md](sessions/session-summary-{SESSION_ID_PREFIX}-{DATE}.md) — {one-line description} |
```

If a Session History table already exists, append a new row. Do NOT overwrite existing rows — they form a history of past migrations.

## Step 4: Stop the Running Container

Check if there's a running container for this group and stop it:

```bash
# Find running container for this group
docker ps --format '{{.Names}}' --filter "name=nanoclaw-" | grep -i "{GROUP_FOLDER}"

# If found, stop it gracefully
docker stop {CONTAINER_NAME}

# Wait for it to exit
docker wait {CONTAINER_NAME} 2>/dev/null || true
```

**Critical:** The container must be fully stopped before proceeding to Step 5. If the container's exit handler runs after the session is cleared, it will re-write the old session ID back to the database.

## Step 5: Clear the Session from the Database

Delete the session row from SQLite:

```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{GROUP_FOLDER}';"
```

Verify it's gone:

```bash
sqlite3 store/messages.db "SELECT * FROM sessions WHERE group_folder = '{GROUP_FOLDER}';"
```

This should return empty. The next time a message triggers this group, the host will create a brand-new session.

## Step 6: Restart the Host Service

Restart the NanoClaw host process so it picks up the cleared session state:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
# systemctl --user restart nanoclaw
```

## Step 7: Verify

Confirm the migration succeeded:

```bash
# No session should exist for this group
sqlite3 store/messages.db "SELECT * FROM sessions WHERE group_folder = '{GROUP_FOLDER}';"

# The host should be running
pgrep -f "nanoclaw" || echo "WARNING: nanoclaw not running"

# The session summary file should exist for this specific session
ls groups/{GROUP_FOLDER}/sessions/session-summary-{SESSION_ID_PREFIX}-*.md

# The CLAUDE.md should reference this specific session summary
grep "session-summary-{SESSION_ID_PREFIX}" groups/{GROUP_FOLDER}/CLAUDE.md
```

Report to the user:
- Old session ID (truncated) and size
- Summary of what was preserved
- Confirmation that the session was cleared
- Next message to this group will start a fresh session

## Troubleshooting

### Session reappears after clearing
The container was still running when the session was deleted. Stop the container first (Step 4), then re-run Step 5.

### Container won't stop
```bash
# Force kill if graceful stop fails
docker kill {CONTAINER_NAME}
```

### Session file not found
The session may have already been cleared or the path format may differ. Check:
```bash
find data/sessions/{GROUP_FOLDER}/ -name "*.jsonl" 2>/dev/null
```

### CLAUDE.md doesn't exist
Create it with the migration summary as the first content:
```bash
# The skill will create the file if it doesn't exist
```

### Host service won't restart
Check logs:
```bash
tail -50 logs/nanoclaw.log
# macOS: check launchd logs
log show --predicate 'processImagePath contains "nanoclaw"' --last 5m
```

## Step 8: Self-Reflection

After the migration is complete (or if it failed partway), review how the execution went and suggest improvements to this skill.

### What to reflect on

1. **Unexpected issues** — Did any step fail or require a workaround not covered by the Troubleshooting section? Did a command produce unexpected output?
2. **Missing information** — Was any context missing from the SKILL.md that you had to figure out on the fly (e.g., a path that differed from the documented pattern, a new edge case)?
3. **Summary quality** — Was the session JSONL easy to parse? Were there message types or structures not documented in Step 2?
4. **Timing or ordering** — Did the container stop cleanly? Did the race condition protection (stop before delete) work as expected?
5. **Skill gaps** — Is there a step that should be added, removed, or reordered?

### Output

If any issues were encountered, present them to the user as a proposed skill update:

> **Skill self-reflection:** During this migration I encountered the following issues:
>
> 1. {Issue description} — **Proposed fix:** {what to change in SKILL.md}
> 2. {Issue description} — **Proposed fix:** {what to change in SKILL.md}
>
> Would you like me to apply these improvements to the `/migrate-session` skill?

If the user approves, edit `.claude/skills/migrate-session/SKILL.md` with the improvements and re-run the tests.

If the migration went smoothly with no issues, briefly note that:

> **Skill self-reflection:** Migration completed without issues. No skill updates needed.
