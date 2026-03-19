---
name: status-report
description: Generate a structured status report by collecting git changes, Claude Code session history, and main group agent insights for a given timeframe. Triggers on "status report", "weekly report", "status update", "/status-report".
---

# Status Report

Generate a structured status report that merges three data sources:
1. **Git changes** on the current branch during the timeframe
2. **Claude Code session history** from local JSONL files
3. **Main group agent report** requested via the AdminChannel REST API

The final report answers: what was completed, top priorities, what's next, key decisions, blockers, and action items.

## Phase 1: Collect Inputs

Ask the user for the **timeframe** using `AskUserQuestion` if not already provided:

> What timeframe should this report cover?
> Examples: "this week", "last 7 days", "2026-03-10 to 2026-03-17", "since Monday"

Parse the answer into a `--since` date string for git and a start/end timestamp range for filtering JSONL sessions.

Acknowledge and confirm:

> Generating status report for: {timeframe}
> I'll collect git changes, Claude Code session history, and request a report from the main group agent.

## Phase 2: Collect Git Changes

Run git log on the current branch for the given timeframe. Summarize the changes by theme/area.

```bash
# Get commits in the timeframe
git log --since="{since_date}" --oneline --no-merges

# Get detailed diff stats
git log --since="{since_date}" --stat --no-merges

# Get the list of changed files
git log --since="{since_date}" --name-only --no-merges --pretty=format:""
```

**Summarize:**
- Group commits by area/theme (e.g., "container system", "channel support", "testing")
- Note key files changed and why
- Count: N commits, M files changed

## Phase 3: Collect Claude Code Session History

Claude Code stores session transcripts as JSONL files at:
```
~/.claude/projects/{encoded-project-path}/*.jsonl
```

The project path is encoded by replacing `/` with `-` (with leading `-`). For example:
```
/Users/slesarenko/Projects/github/input-output-hk/learning/repos/nanoclaw
→ -Users-slesarenko-Projects-github-input-output-hk-learning-repos-nanoclaw
```

### 3a. Find and filter sessions

```bash
# Find the project directory
PROJECT_CLAUDE_DIR="$HOME/.claude/projects/-$(echo "$PWD" | sed 's|^/||; s|/|-|g')"

# List session files modified within the timeframe
find "$PROJECT_CLAUDE_DIR" -maxdepth 1 -name "*.jsonl" -newer /tmp/since_marker
```

To create the marker file for `find -newer`:
```bash
touch -t "{YYYYMMDDhhmm}" /tmp/since_marker
```

### 3b. Parse session content

Each line in a JSONL file is a JSON object with:
```json
{
  "type": "user" | "assistant",
  "timestamp": "2026-03-19T15:37Z",
  "message": {
    "role": "user" | "assistant",
    "content": "..."
  }
}
```

For each session file within the timeframe:
1. Read the first and last few user messages to understand what the session was about
2. Extract the first `user` message as the session topic/goal
3. Note the timestamp range (first message → last message)

**Summarize:**
- List each session with: date, topic/goal (from first user message), rough outcome
- Group by theme if multiple sessions relate to the same work area
- Count: N sessions, approximate total interactions

### 3c. Alternative: use git log of Claude Code conversations

If JSONL parsing is too complex or files are very large, fall back to summarizing based on git branch activity and commit messages, which already capture the outcomes of Claude Code sessions.

## Phase 4: Request Main Group Agent Report

Use the AdminChannel REST API to ask the main group agent for its perspective on the timeframe.

### 4a. Find the main group JID

```bash
# Query registered groups
curl -s http://localhost:9877/groups | jq 'to_entries[] | select(.value.isMain == true) | .key'
```

If no main group is found, skip this phase and note it in the report.

### 4b. Send the report request

```bash
MAIN_JID="<main group JID from above>"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

curl -s -X POST http://localhost:9877/messages \
  -H 'Content-Type: application/json' \
  -d "{
    \"jid\": \"$MAIN_JID\",
    \"content\": \"@{assistant_name} Please create a brief status report covering the period {timeframe}. Summarize: what you worked on, key decisions made, any blockers or issues encountered, and what's pending. Keep it concise — bullet points preferred. Wrap your entire response in a single message.\",
    \"sender\": \"admin:status-report-skill\",
    \"sender_name\": \"Status Report Skill\"
  }"
```

The `{assistant_name}` should be discovered from the `/health` endpoint:
```bash
ASSISTANT_NAME=$(curl -s http://localhost:9877/health | jq -r '.assistantName')
```

### 4c. Wait for the response

Use long-polling on the `/responses` endpoint:

```bash
curl -s "http://localhost:9877/responses?jid=$MAIN_JID&since=$TIMESTAMP&awaitCount=1&timeout=120000"
```

This will block for up to 2 minutes waiting for the agent's response. The response JSON:
```json
{
  "responses": [{ "jid": "...", "text": "...", "timestamp": "..." }],
  "timedOut": false
}
```

Extract the `text` from the first response. If `timedOut` is true, note that the agent did not respond in time and proceed without its input.

**Important:** The main group agent processes messages asynchronously. The container needs to spin up, process the prompt, and stream back results. 2 minutes is usually enough, but for cold starts it may take longer. If it times out, retry once with another 120s timeout before giving up.

## Phase 5: Merge and Generate Report

Combine all collected data into a single structured report. Use the following template:

```markdown
# Status Report: {timeframe}

Generated: {current date}
Branch: {current git branch}

## What Went Well / Completed

{Merge git commit themes + Claude Code session outcomes + agent report completions.
Group by work area. Each item should be a concrete accomplishment.}

- **{Area 1}:** {what was done, with specific details}
- **{Area 2}:** {what was done}
- ...

## Top 3 Priorities for Next Week

{Infer from: incomplete work in sessions, TODOs in recent commits, agent report pending items.
Be specific and actionable.}

1. {Priority with context}
2. {Priority with context}
3. {Priority with context}

## Next Big Thing on the Horizon

{Identify from: branch name themes, large uncommitted work, agent report forward-looking items.
One paragraph describing the strategic direction.}

## Key Decisions, Blockers & Risks

{Extract from: agent report blockers, session discussions about trade-offs, git reverts or repeated changes.}

- **Decision:** {what was decided and why}
- **Blocker:** {what's blocking and who can help}
- **Risk:** {what could go wrong}

## Action Items & Follow-ups

{Concrete next steps. Include carry-overs from previous work and new items discovered during this period.}

- [ ] {Action item with owner/context}
- [ ] {Action item}
- ...

---
*Sources: git log ({N} commits), Claude Code sessions ({M} sessions), main group agent report*
```

### Merging guidelines

- **Deduplicate:** If git commits and session history describe the same work, combine them into one bullet
- **Prioritize specifics:** Use commit messages for concrete details, session history for context/reasoning, agent report for strategic view
- **Be concise:** Each bullet should be 1-2 sentences max
- **Use the agent report** to fill gaps — the agent has memory of conversations, scheduled tasks, and group interactions that git/sessions don't capture

## Phase 6: Present the Report

Output the full report to the user. Then ask:

> Here's your status report. Would you like me to:
> 1. Save it to a file (e.g., `reports/status-{date}.md`)
> 2. Adjust any section
> 3. Send it to a specific group via the agent

## Troubleshooting

### AdminChannel not running

If `curl http://localhost:9877/health` fails:
- NanoClaw host process may not be running
- Check with: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
- The skill can still generate a partial report from git + sessions without the agent report

### No main group registered

If `/groups` returns no group with `isMain: true`:
- Skip Phase 4 entirely
- Note in the report: "Agent report unavailable — no main group registered"

### JSONL files too large to parse

Session files can be several MB. If reading them is slow:
- Only read the first 50 and last 50 lines of each file
- Or fall back to Phase 3c (git-based summary)

### Agent response timeout

If the agent doesn't respond within the timeout:
- The container may need to start (cold start ~30s)
- Retry once with a fresh POST + long-poll
- If still no response, proceed with git + session data only

### ADMIN_CHANNEL_PORT is non-default

Check the port from config:
```bash
grep ADMIN_CHANNEL_PORT .env 2>/dev/null || echo "9877 (default)"
```
