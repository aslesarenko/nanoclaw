---
name: integration-test
description: Run Extension C privilege system integration tests. Collaborative step-by-step test session with user sending Telegram messages when instructed. Triggers on "integration test", "test privileges", "test extension c", "run integration tests".
---

# Integration Test — Extension C Privilege System

Runs a full integration test session for the Extension C privilege system. Tests privilege resolution, tool gating, floor degradation, multi-segment processing, and task creator inheritance.

**This is a collaborative test.** Claude runs setup SQL, checks logs, verifies outcomes. The user sends Telegram messages when instructed, then says "done" to proceed.

**Required argument:** none (runs all phases by default)

## Prerequisites

- NanoClaw host service running
- Telegram bot connected (`@morphic_ai_bot`)
- Docker running (for container agents)
- Two Telegram accounts available:
  - Owner account (`65404254`)
  - Colleague account (`5297353510`)
- NanoclawGroup (`tg:-5271470635`) registered as Mode 1 group

## How It Works

1. **Setup** — seeds identity store, resets floors, verifies prerequisites
2. **Automated tests** — DB inserts, log checks, DB verification (no user interaction)
3. **User-driven tests** — tells user exactly what to send and where, waits for "done"
4. **Verification** — checks host logs, container logs, DB state after each test
5. **Issues review** — checks `docs/extensions/extension-c-test-issues.md`, updates statuses
6. **Self-reflection** — proposes skill improvements if issues found
7. **Report** — summary of pass/fail per test

## Verification Commands

Use these throughout testing:

```bash
# Host logs (extract path from plist)
LOG_FILE=$(grep -A1 'StandardOutPath' ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>.*/\1/' || echo "logs/nanoclaw.log")

# Privilege floors
sqlite3 store/messages.db "SELECT * FROM router_state WHERE key LIKE 'privilege_floor%';"

# Identity store
sqlite3 store/messages.db "SELECT * FROM known_persons;"
sqlite3 store/messages.db "SELECT * FROM sender_mappings;"

# Active containers
docker ps --filter "name=nanoclaw"

# Task creator fields
sqlite3 store/messages.db "SELECT id, creator_sender, creator_privilege FROM scheduled_tasks ORDER BY created_at DESC LIMIT 5;"
```

## Phase 0: Setup

### 0A. Verify prerequisites

```bash
# Host is running
pgrep -f "nanoclaw" || echo "ERROR: nanoclaw not running"

# Telegram bot is connected
LOG_FILE=$(grep -A1 'StandardOutPath' ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>.*/\1/')
grep "Telegram bot connected" "$LOG_FILE" | tail -1

# Docker is running
docker info > /dev/null 2>&1 && echo "Docker OK" || echo "ERROR: Docker not running"

# NanoclawGroup exists
sqlite3 store/messages.db "SELECT jid, name, folder, requires_trigger FROM registered_groups WHERE jid = 'tg:-5271470635';"
```

If any prerequisite fails, stop and instruct the user to fix it.

### 0B. Seed identity store (idempotent)

```sql
-- Owner identity
INSERT OR IGNORE INTO known_persons (id, display_name, privilege, notes, created_at, updated_at)
VALUES ('alex-owner', 'Alex Owner', 'owner', 'Primary owner account', datetime('now'), datetime('now'));

INSERT OR REPLACE INTO sender_mappings (sender_id, person_id, channel, added_at)
VALUES ('65404254', 'alex-owner', 'telegram', datetime('now'));

-- Colleague identity
INSERT OR IGNORE INTO known_persons (id, display_name, privilege, notes, created_at, updated_at)
VALUES ('alex-colleague', 'Alex Colleague', 'colleague', 'Secondary account for testing', datetime('now'), datetime('now'));

INSERT OR REPLACE INTO sender_mappings (sender_id, person_id, channel, added_at)
VALUES ('5297353510', 'alex-colleague', 'telegram', datetime('now'));
```

### 0C. Reset stale state

```sql
DELETE FROM router_state WHERE key LIKE 'privilege_floor:%';
```

### 0D. Verify setup

```bash
sqlite3 store/messages.db "SELECT sm.sender_id, kp.display_name, kp.privilege FROM sender_mappings sm JOIN known_persons kp ON sm.person_id = kp.id;"
```

Expected: Two rows — `65404254|Alex Owner|owner` and `5297353510|Alex Colleague|colleague`.

---

## Phase 1: Mode 2 Baseline — Main Group

Main group is always Mode 2 (`requiresTrigger=false`), `isMain=true`. Owner privilege is forced regardless of floor.

### Test 1.1: Owner message in main group

| Step | Who | Action |
|------|-----|--------|
| 1 | Claude | Confirm setup complete, check DB state |
| 2 | **User** | Send in **main** chat (tg:65404254): `Hello, list the tool names you have available` |
| 3 | **User** | Say "done" when agent responds |
| 4 | Claude | Verify results |

**Pass criteria:**
- Host log: NO `Processing privilege segment` (Mode 2 doesn't use segmentation)
- DB: `privilege_floor:main` = `owner`
- Agent lists full tool set

### Test 1.2: Main group ignores degraded floor

| Step | Who | Action |
|------|-----|--------|
| 1 | Claude | `UPDATE router_state SET value = 'external' WHERE key = 'privilege_floor:main';` |
| 2 | **User** | Send in **main** chat: `What privilege level are you running at?` |
| 3 | **User** | Say "done" when agent responds |
| 4 | Claude | Verify agent still at owner privilege |
| 5 | Claude | Cleanup: `DELETE FROM router_state WHERE key = 'privilege_floor:main';` |

**Pass criteria:**
- Agent confirms owner privilege (main group override at `src/index.ts:321-322`)

---

## Phase 2: Mode 1 Basics — NanoclawGroup (owner account)

NanoclawGroup is Mode 1 (`requiresTrigger=1`). Telegram trigger: user types `@morphic_ai_bot`, channel auto-translates to `@AlexTwin <message>` which matches `TRIGGER_PATTERN = ^@AlexTwin\b`.

### Test 2.1: Owner @-mention triggers owner privilege

| Step | Who | Action |
|------|-----|--------|
| 1 | Claude | Reset floor: `DELETE FROM router_state WHERE key = 'privilege_floor:telegram_nanoclaw-group';` |
| 2 | **User** | Send in **NanoclawGroup** from **owner account** (65404254): `@morphic_ai_bot list your available tools` |
| 3 | **User** | Say "done" when agent responds |
| 4 | Claude | Verify results |

**Pass criteria:**
- Host log: `Processing privilege segment` with `privilege: 'owner'`, `isMention: true`
- DB: `privilege_floor:telegram_nanoclaw-group` = `owner`
- Agent lists full tools

### Test 2.2: Message without trigger is not processed

| Step | Who | Action |
|------|-----|--------|
| 1 | **User** | Send in **NanoclawGroup** from **owner account**: `Can you hear me without a trigger?` (no @mention) |
| 2 | **User** | Wait 15 seconds, then say "done" |
| 3 | Claude | Verify no processing |

**Pass criteria:**
- Host log: `Telegram message stored` + `New messages count: 1` but NO `Processing messages`, NO `Processing privilege segment`, NO `Spawning container`

### Test 2.3: Accumulated context + mention produces two segments

The unprocessed message from 2.2 is still in queue.

| Step | Who | Action |
|------|-----|--------|
| 1 | **User** | Send in **NanoclawGroup** from **owner account**: `@morphic_ai_bot what was my previous message?` |
| 2 | **User** | Say "done" when agent responds |
| 3 | Claude | Verify TWO `Processing privilege segment` entries |

**Pass criteria:**
- Segment 1: `isMention: false`, `messageCount: 1` (context batch)
- Segment 2: `isMention: true`, `messageCount: 1` (the @mention)
- Both at `privilege: 'owner'`
- Segment 2 processes immediately after segment 1 (early-resolve fix)
- Agent references the previous "Can you hear me?" message

---

## Phase 3: Multi-Sender Privilege Differentiation

### Test 3.1: Colleague @-mention gets colleague privilege (no Gmail)

| Step | Who | Action |
|------|-----|--------|
| 1 | Claude | Reset floor and clear session for clean state |
| 2 | **User** | Send in **NanoclawGroup** from **colleague account** (5297353510): `@morphic_ai_bot check my recent emails` |
| 3 | **User** | Say "done" when agent responds |
| 4 | Claude | Verify results |

**Pass criteria:**
- Host log: `Processing privilege segment` with `privilege: 'colleague'`, `isMention: true`
- DB: `privilege_floor:telegram_nanoclaw-group` = `colleague`
- Agent indicates Gmail is NOT available (MCP server not connected for colleague privilege)

### Test 3.2: Owner @-mention after colleague gets full tools

| Step | Who | Action |
|------|-----|--------|
| 1 | **User** | Send in **NanoclawGroup** from **owner account** (65404254): `@morphic_ai_bot list your tools, do you have Gmail?` |
| 2 | **User** | Say "done" when agent responds |
| 3 | Claude | Verify results |

**Pass criteria:**
- Host log: `Processing privilege segment` with `privilege: 'owner'`, `isMention: true`
- Agent has full tools including Gmail MCP

**Known issue (ISSUE-005):** Agent may report Gmail unavailable due to session history from Test 3.1 where Gmail was not connected. This is a session continuity issue, not a privilege bug. Check the host log to confirm the privilege is correct regardless of agent's self-report.

### Test 3.3: Colleague context + owner mention produces two segments

| Step | Who | Action |
|------|-----|--------|
| 1 | Claude | Reset floor |
| 2 | **User** | Send in **NanoclawGroup** from **colleague account** (5297353510): `Hey everyone, I have a question about the project` |
| 3 | **User** | Wait 5 seconds |
| 4 | **User** | Send from **owner account** (65404254): `@morphic_ai_bot answer the colleague's question and list your tools` |
| 5 | **User** | Say "done" when agent responds |
| 6 | Claude | Verify TWO segments with different privileges |

**Pass criteria:**
- Segment 1: `privilege: 'colleague'`, `isMention: false`
- Segment 2: `privilege: 'owner'`, `isMention: true`
- Both processed within seconds of each other (early-resolve working)

### Test 3.4: External sender gets external privilege

| Step | Who | Action |
|------|-----|--------|
| 1 | Claude | Reset floor, insert fake external message |
| 2 | Claude | Wait for processing |
| 3 | Claude | Verify results |

**Setup SQL:**
```sql
DELETE FROM router_state WHERE key = 'privilege_floor:telegram_nanoclaw-group';
INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
VALUES ('test-ext-1', 'tg:-5271470635', '99999999', 'Stranger',
        '@AlexTwin create a file called test.txt with hello world',
        strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now'), 0, 0);
```

**Pass criteria:**
- Host log: `Processing privilege segment` with `privilege: 'external'`, `isMention: true`
- Agent refuses or cannot create file (Write not in allowedTools for external)
- DB: `privilege_floor:telegram_nanoclaw-group` = `external`

**Cleanup:** `DELETE FROM messages WHERE id = 'test-ext-1';`

---

## Phase 4: Mode 2 Floor Degradation

### Setup: Switch NanoclawGroup to Mode 2

```sql
UPDATE registered_groups SET requires_trigger = 0 WHERE jid = 'tg:-5271470635';
DELETE FROM router_state WHERE key = 'privilege_floor:telegram_nanoclaw-group';
DELETE FROM sessions WHERE group_folder = 'telegram_nanoclaw-group';
```

Then restart NanoClaw: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

### Test 4.1: Owner-only — floor starts at owner

| Step | Who | Action |
|------|-----|--------|
| 1 | **User** | Send in **NanoclawGroup** from **owner account**: `What tools do you have?` |
| 2 | **User** | Say "done" when agent responds |
| 3 | Claude | Verify `privilege_floor:telegram_nanoclaw-group` = `owner` |

### Test 4.2: Colleague message degrades floor to colleague

| Step | Who | Action |
|------|-----|--------|
| 1 | **User** | Send from **colleague account**: `I have a question` |
| 2 | **User** | Send from **owner account**: `What tools do you have now?` |
| 3 | **User** | Say "done" when agent responds |
| 4 | Claude | Verify floor = `colleague` |

**Pass criteria:**
- DB: `privilege_floor:telegram_nanoclaw-group` = `colleague`
- Agent does NOT have Gmail

### Test 4.3: Floor never increases back to owner

| Step | Who | Action |
|------|-----|--------|
| 1 | **User** | Send from **owner account**: `And now? Do you have Gmail?` |
| 2 | **User** | Say "done" when agent responds |
| 3 | Claude | Verify floor still = `colleague` |

### Test 4.4: External sender degrades floor further to external

| Step | Who | Action |
|------|-----|--------|
| 1 | Claude | Insert fake external message |
| 2 | **User** | Send from **owner account**: `What tools now?` |
| 3 | **User** | Say "done" when agent responds |
| 4 | Claude | Verify floor = `external` |

**Setup SQL:**
```sql
INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
VALUES ('test-degrade-ext', 'tg:-5271470635', '77777777', 'Stranger',
        'Hello from outside', strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '+1 second'), 0, 0);
```

**Cleanup:** `DELETE FROM messages WHERE id = 'test-degrade-ext';`

### Cleanup: Restore Mode 1

```sql
UPDATE registered_groups SET requires_trigger = 1 WHERE jid = 'tg:-5271470635';
DELETE FROM router_state WHERE key = 'privilege_floor:telegram_nanoclaw-group';
DELETE FROM sessions WHERE group_folder = 'telegram_nanoclaw-group';
```

Restart NanoClaw: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

---

## Phase 5: Task Creator Privilege Inheritance

### Test 5.1: Owner-created task inherits owner privilege

| Step | Who | Action |
|------|-----|--------|
| 1 | **User** | Send in **NanoclawGroup** from **owner account**: `@morphic_ai_bot schedule a one-time task for 2 minutes from now: say "Task privilege test complete" in this chat` |
| 2 | **User** | Say "done" when agent confirms task creation |
| 3 | Claude | Check `scheduled_tasks` for `creator_privilege = 'owner'` |
| 4 | Both | Wait ~2 minutes for task execution |
| 5 | Claude | Verify task container ran and completed |

**Pass criteria:**
- `creator_privilege = 'owner'` in `scheduled_tasks`
- Task fires and sends message to NanoclawGroup
- Task status = `completed`

### Test 5.2: Legacy tasks default to owner

```bash
sqlite3 store/messages.db "SELECT id, creator_sender, creator_privilege FROM scheduled_tasks WHERE creator_sender IS NULL OR creator_sender = '';"
```

**Pass criteria:** All legacy tasks have `creator_privilege = 'owner'`

---

## Phase 6: Final Cleanup

After all tests:

```sql
-- Clean up test messages
DELETE FROM messages WHERE id IN ('test-ext-1', 'test-degrade-ext', 'test-3priv-ext');

-- Reset floors
DELETE FROM router_state WHERE key LIKE 'privilege_floor:%';

-- Ensure NanoclawGroup is back to Mode 1
UPDATE registered_groups SET requires_trigger = 1 WHERE jid = 'tg:-5271470635';
```

Restart NanoClaw to pick up clean state.

---

## Phase 7: Issues Review

Read `docs/extensions/extension-c-test-issues.md` and review each issue:

1. For each issue with status `open`:
   - Check if the issue is still reproducible based on current test results
   - If fixed, update status to `fixed` with date and context
   - If still present, keep as `open`

2. For any NEW issues discovered during this test run:
   - Add a new entry with full context following the existing format
   - Include: title, status, date, severity, context, impact, and a prompt for fix

3. Report the issues summary to the user.

---

## Phase 8: Self-Reflection

After all tests complete, review how the execution went:

### What to reflect on

1. **Unexpected issues** — Did any step fail or require a workaround?
2. **Missing information** — Was any context missing that had to be figured out on the fly?
3. **Test coverage gaps** — Are there scenarios not covered?
4. **Timing or ordering** — Did any test depend on state from a previous test unexpectedly?
5. **Skill gaps** — Should any step be added, removed, or reordered?

### Output

If issues were found:

> **Skill self-reflection:** During this test run I encountered:
>
> 1. {Issue} — **Proposed fix:** {change to SKILL.md}
> 2. {Issue} — **Proposed fix:** {change to SKILL.md}
>
> Would you like me to apply these improvements?

If no issues:

> **Skill self-reflection:** Test run completed without skill issues. No updates needed.

---

## Phase 9: Report

Present a summary table of all test results:

```
| Test | Phase | Result | Notes |
|------|-------|--------|-------|
| 1.1  | Mode 2 baseline | PASS/FAIL | ... |
| 1.2  | Main override | PASS/FAIL | ... |
| ...  | ... | ... | ... |
```

Include:
- Total pass/fail count
- Issues found/resolved this run
- Open issues remaining

---

## Test Matrix Reference

| Test | Group | Mode | Privilege | Verifies |
|------|-------|------|-----------|----------|
| 1.1 | main | 2 | owner | Main group baseline, full tools |
| 1.2 | main | 2 | owner | Main group override ignores floor |
| 2.1 | NanoclawGroup | 1 | owner | Owner mention triggers owner privilege |
| 2.2 | NanoclawGroup | 1 | — | Non-trigger messages ignored |
| 2.3 | NanoclawGroup | 1 | owner | Two-segment context + mention |
| 3.1 | NanoclawGroup | 1 | colleague | Colleague mention, no Gmail |
| 3.2 | NanoclawGroup | 1 | owner | Owner after colleague, full tools |
| 3.3 | NanoclawGroup | 1 | col+owner | Mixed: colleague context + owner mention |
| 3.4 | NanoclawGroup | 1 | external | Simulated external, Write blocked |
| 4.1 | NanoclawGroup | 2 | owner | Floor starts at owner |
| 4.2 | NanoclawGroup | 2 | colleague | Colleague degrades floor |
| 4.3 | NanoclawGroup | 2 | colleague | Floor never increases |
| 4.4 | NanoclawGroup | 2 | external | External degrades further |
| 5.1 | NanoclawGroup | 1 | owner | Task inherits creator privilege |
| 5.2 | — | — | owner | Legacy tasks default to owner |

## Critical Files

- `src/index.ts:265-344` — Mode 1/2 branching and segment processing
- `src/privilege-resolver.ts` — Floor computation, segmentation
- `src/privilege-tools.ts` — Tool set per privilege level
- `src/identity.ts` — resolveIdentity() sender -> person lookup
- `container/agent-runner/src/index.ts` — allowedTools usage, MCP gating, IPC
- `src/container-runner.ts` — Container lifecycle, early-resolve for streaming

## Troubleshooting

### Agent doesn't respond to trigger

Check that `@morphic_ai_bot` in Telegram is auto-translated to `@AlexTwin` by the channel. Verify with:
```bash
sqlite3 store/messages.db "SELECT content FROM messages WHERE chat_jid = 'tg:-5271470635' ORDER BY timestamp DESC LIMIT 1;"
```
The content should start with `@AlexTwin`.

### Container doesn't spawn

Check host logs for errors after `Processing messages`. Common causes:
- Docker not running
- Container image not built (`./container/build.sh`)
- Session file corrupt (clear with `DELETE FROM sessions WHERE group_folder = '...';`)

### Floor doesn't degrade

The floor is computed in `resolveSessionPrivilege()` using `getSessionFloorPrivilege()`. Check that `router_state` table has the correct key format: `privilege_floor:{groupFolder}`.

### Fake messages not picked up

Ensure timestamp format matches ISO format with `T` and `Z`: `strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now')`. Space-separated timestamps from `datetime('now')` won't match the polling cursor.

### Gmail available to colleague

Check that `container/agent-runner/src/index.ts` conditionally excludes the Gmail MCP server when `allowedTools` doesn't include `mcp__gmail__*`. The fix (ISSUE-004) uses a spread operator to conditionally include the gmail MCP config.
