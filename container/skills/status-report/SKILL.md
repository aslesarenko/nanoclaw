---
name: status-report
description: Generate a structured status report by collecting git changes, Claude Code session history, and agent activity for a given timeframe. Triggers on "status report", "weekly report", "status update", "/status-report".
---

# Status Report (Container Agent)

Generate a structured status report that merges multiple data sources into a single cohesive document.

**Data sources:**
1. **Git changes** on the current branch during the timeframe
2. **Claude Code session history** from the project's JSONL files
3. **Your own memory and context** from this group's CLAUDE.md and conversation history

## Phase 1: Collect Inputs

If the user hasn't specified a timeframe, ask:

> What timeframe should this report cover?
> Examples: "this week", "last 7 days", "2026-03-10 to 2026-03-17", "since Monday"

Parse into a `--since` date for git and a timestamp range for filtering sessions.

Confirm:
> Generating status report for: {timeframe}

## Phase 2: Collect Git Changes

The project root is mounted at `/workspace/project` (main group only).

```bash
cd /workspace/project
git log --since="{since_date}" --oneline --no-merges
git log --since="{since_date}" --stat --no-merges
```

**Summarize by theme/area:**
- Group commits by work area (e.g., "container system", "channels", "testing", "skills")
- Note key files changed
- Count: N commits, M files changed

If `/workspace/project` is not available (non-main group), skip this phase and note it.

## Phase 3: Collect Claude Code Session History

Session transcripts are stored as JSONL files at:
```
/workspace/project/.claude/projects/{encoded-path}/*.jsonl
```

The project path is encoded by replacing `/` with `-` (with leading `-`). To find the right directory:

```bash
# List available project directories
ls /home/node/.claude/projects/ 2>/dev/null || echo "No session directory"
```

If the session directory is accessible (via the mounted `.claude/` volume):

```bash
# Find session files modified within the timeframe
find /home/node/.claude/projects/ -maxdepth 2 -name "*.jsonl" -newer /tmp/since_marker 2>/dev/null
```

Create the time marker:
```bash
touch -t "{YYYYMMDDhhmm}" /tmp/since_marker
```

### Parse sessions

Each JSONL line contains:
```json
{
  "type": "user" | "assistant",
  "timestamp": "2026-03-19T15:37Z",
  "message": { "role": "user" | "assistant", "content": "..." }
}
```

For each session:
1. Read the first few user messages to identify the session's topic/goal
2. Note the timestamp range
3. Summarize: date, topic, rough outcome

**If JSONL files are too large or inaccessible**, fall back to summarizing based on git commit messages which capture the outcomes of coding sessions.

## Phase 4: Collect Agent Activity

Review your own context for the timeframe:

1. **Read this group's CLAUDE.md** (`/workspace/group/CLAUDE.md`) for accumulated memory and recent decisions
2. **Check scheduled tasks** via the `list_tasks` MCP tool to see what's active/completed
3. **Review your conversation history** for key discussions, decisions, and pending items

Summarize:
- What tasks were processed
- Key decisions made in conversations
- Any blockers or issues raised
- Pending/upcoming work

## Phase 5: Merge and Generate Report

Combine all sources into a single structured report:

```markdown
# Status Report: {timeframe}

Generated: {current date}
Branch: {current git branch}

## What Went Well / Completed

{Merge git commit themes + session outcomes + agent activity.
Group by work area. Each item is a concrete accomplishment.}

- **{Area 1}:** {what was done, with specific details}
- **{Area 2}:** {what was done}

## Top 3 Priorities for Next Week

{Infer from: incomplete work, pending tasks, recent discussion themes.
Be specific and actionable.}

1. {Priority with context}
2. {Priority with context}
3. {Priority with context}

## Next Big Thing on the Horizon

{Identify from: branch name themes, large ongoing work, forward-looking items.
One paragraph on strategic direction.}

## Key Decisions, Blockers & Risks

- **Decision:** {what was decided and why}
- **Blocker:** {what's blocking and who can help}
- **Risk:** {what could go wrong}

## Action Items & Follow-ups

- [ ] {Action item with owner/context}
- [ ] {Action item}

---
*Sources: git log ({N} commits), Claude Code sessions ({M} sessions), agent memory*
```

### Merging guidelines

- **Deduplicate:** If git commits and session history describe the same work, combine into one bullet
- **Prioritize specifics:** Use commit messages for concrete details, sessions for context/reasoning, agent memory for strategic view
- **Be concise:** Each bullet 1-2 sentences max

## Phase 6: Present

Output the full report. Then ask:

> Would you like me to:
> 1. Save it to a file (e.g., `reports/status-{date}.md`)
> 2. Adjust any section
> 3. Send it to another group

## Troubleshooting

### /workspace/project not mounted

This is only available for the main group. Non-main groups skip git and session history, relying on agent memory only.

### JSONL files too large

Only read the first 50 and last 50 lines of each file, or fall back to git-based summary.

### No scheduled tasks

If `list_tasks` returns empty, skip that section of the agent activity summary.
