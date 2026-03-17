# Extension C: Dynamic ContainerInput

**Status:** Iteration 1 complete (privilege resolution + tool gating + mount scoping + migration + tests)
**Branch:** `digital-twin`
**Date:** 2026-03-16
**Depends on:** Extension A (Sender Identity Store)

## Goal

Thread sender identity and privilege from the host's identity store (Extension A) through to the container agent-runner, enabling per-sender tool filtering and mount scoping. Each container invocation carries the sender's identity and an effective privilege level that gates which tools the agent can use and which secrets are injected.

This implements NFR-PRIV-01 and NFR-PRIV-02 from the digital twin PRD: "The agent's capabilities must be scoped to the privilege level of the sender" and "Sensitive tools (Gmail, GitHub) must not be accessible to non-owner senders."

## Design Decisions

### Two-Mode Privilege Model

The system supports two distinct modes based on how a chat activates the agent:

**Mode 1 — Privilege-aware chats** (`requiresTrigger !== false`):
The @-mention serves as a **privilege boundary**. All messages trigger execution, but:
- @-mention messages get individual invocation at the sender's privilege level
- Non-mention messages are batched into a single invocation at the session floor privilege

Each segment gets its own container invocation (or piped `query()` call) with a different tool set, providing code-enforced privilege isolation.

**Mode 2 — Every-message chats** (`requiresTrigger === false`, including main group):
Privilege is the minimum across all senders who have ever participated in the session. If an external user joins, the entire session degrades. The main group is always overridden to `'owner'`.

### Privilege Ordering

```
owner (2) > colleague (1) > external (0)
```

- `minPrivilege()` utility returns the least privileged of its arguments
- Unmapped senders default to `'external'` (principle of least privilege)
- `is_from_me` messages are always treated as `'owner'`

### Message Segmentation Algorithm (Mode 1)

`splitMessagesByPrivilege(messages, sessionFloorPrivilege)` walks messages chronologically:

1. Accumulate consecutive non-mention messages into a batch
2. When a mention is found:
   - Flush the accumulated batch as a segment at session floor privilege
   - Emit the mention as its own segment at the sender's privilege
3. After all messages, flush any remaining batch as a final segment

**Example:** Messages: `[msg1(external), msg2(colleague), @Andy(owner), msg3(colleague)]`
- Segment 1: `[msg1, msg2]` at session floor → restricted tools
- Segment 2: `[@Andy(owner)]` at owner privilege → full tools including Gmail
- Segment 3: `[msg3]` at session floor → restricted tools

**Context continuity:** Session resume (`sessionId`) preserves full conversation history across invocations. Each segment's agent sees all prior turns via session history.

### Session Privilege Floor

- Stored in `router_state` table with key `privilege_floor:{groupFolder}`
- Value is the privilege level string (`'owner'`, `'colleague'`, or `'external'`)
- Only degrades — never increases without an explicit session reset
- Resets via `/migrate-session` or similar session reset mechanisms
- Different groups have independent floors

### Privilege-to-Tool Mapping

| Tool | Owner | Colleague | External |
|------|-------|-----------|----------|
| Bash, Read, Glob, Grep | Yes | Yes | Yes |
| WebSearch, WebFetch | Yes | Yes | Yes |
| mcp__nanoclaw__* | Yes | Yes | Yes |
| TodoWrite, ToolSearch, Skill | Yes | Yes | Yes |
| Write, Edit, NotebookEdit | Yes | Yes | No |
| Task, TaskOutput, TaskStop | Yes | Yes | No |
| TeamCreate, TeamDelete, SendMessage | Yes | Yes | No |
| mcp__gmail__* | Yes | No | No |

**Rationale:**
- External users get read-only tools — they can search and browse but not modify files or orchestrate agents
- Colleagues get everything except Gmail — they shouldn't access the owner's personal email
- Owner gets the full tool set

### ContainerInput Interface Changes

Three new optional fields:

```typescript
senderIdentity?: {
  personId: string;
  displayName: string;
};
privilegeLevel?: PrivilegeLevel;
allowedTools?: string[];
```

**Key distinction:** `senderIdentity` is **informational only** — it tells the agent who triggered the invocation but carries no privilege data. `privilegeLevel` is the **effective security gate** that determines tool access. These are separate because the effective privilege may differ from the sender's raw privilege (e.g., session floor degradation, main group override to owner).

### IPC Protocol Extension

Piped messages to active containers now include optional privilege fields:

```json
{
  "type": "message",
  "text": "...",
  "privilegeLevel": "colleague",
  "allowedTools": ["Bash", "Read", "Glob", "Grep", "..."]
}
```

The agent-runner reads `allowedTools` from piped messages and uses them for the next `query()` call. This enables dynamic privilege changes per message without container re-spawning.

### Mount Security Model

Gmail credentials (`~/.gmail-mcp`) are **always mounted** into containers regardless of privilege level. Access is gated by `allowedTools` in the SDK `query()` call — if `mcp__gmail__*` isn't in the tool list, the agent cannot invoke Gmail even though the credentials are on the filesystem.

**Rationale:** Mounting always avoids container re-spawning when privilege changes dynamically via piped IPC messages. The MCP servers are started once at container init and reused across `query()` calls; the SDK's `allowedTools` list is the enforcement point.

GH_TOKEN is injected as an environment variable only for `owner`-privilege invocations (falls back to `isMain` check for backward compatibility).

### Task Creator Identity Inheritance

Scheduled tasks capture the creator's identity at creation time:
- `creator_sender`: the sender ID who created the task (NULL for legacy tasks)
- `creator_privilege`: the privilege level at creation time (defaults to `'owner'`)

At execution time, the task's `creator_privilege` is used to determine `allowedTools`, ensuring that a task created by a colleague cannot access Gmail even when running unattended.

### Backward Compatibility

All new fields are optional throughout the pipeline:
- Old `ContainerInput` without privilege fields works unchanged (falls back to `isMain`-based gating)
- Old IPC messages without `allowedTools`/`privilegeLevel` use the container's original tool list
- Old tasks without `creator_sender`/`creator_privilege` default to owner privilege
- The agent-runner falls back to the hardcoded full tool list when `allowedTools` is absent

## What Was Implemented

### 1. Privilege-to-tool mapping (`src/privilege-tools.ts`)

Pure function module: `getAllowedToolsForPrivilege(privilege: PrivilegeLevel): string[]`

Returns a fresh copy of the tool list for each privilege level. Three immutable base arrays ensure the mapping is never accidentally mutated.

### 2. Two-mode privilege resolver (`src/privilege-resolver.ts`)

- `minPrivilege(...levels)` — returns the least privileged level
- `splitMessagesByPrivilege(messages, sessionFloorPrivilege)` — Mode 1 segmentation
- `resolveSessionPrivilege(messages, groupFolder)` — Mode 2 session floor resolution
- `getSessionFloorPrivilege(groupFolder, messages)` — convenience wrapper for Mode 1 floor access

### 3. Migration 003: Privilege Fields (`src/migrations/003-privilege-fields.ts`)

Adds `creator_sender` (TEXT, nullable) and `creator_privilege` (TEXT, default 'owner') columns to `scheduled_tasks`. Registered in `src/migrations/index.ts`.

### 4. ContainerInput extension (`src/container-runner.ts`)

- Added `senderIdentity`, `privilegeLevel`, `allowedTools` to `ContainerInput` interface
- `buildVolumeMounts` always mounts Gmail credentials (removed `isMain` guard)
- `buildContainerArgs` gates GH_TOKEN by `privilegeLevel` instead of `isMain`
- Agent-runner source always synced (fixed staleness from cached copies)

### 5. Agent-runner dynamic tools (`container/agent-runner/src/index.ts`)

- Mirrored new `ContainerInput` fields
- `allowedTools` from ContainerInput overrides hardcoded list (with fallback)
- `drainIpcInput()` returns structured `IpcMessage` objects with optional `allowedTools`/`privilegeLevel`
- `waitForIpcMessage()` merges IPC messages and propagates privilege fields
- Query loop updates `containerInput.allowedTools` per piped message

### 6. Database layer (`src/db.ts`)

`createTask` INSERT statement extended with `creator_sender` and `creator_privilege` columns.

### 7. Group queue (`src/group-queue.ts`)

`sendMessage` extended with optional `privilegeLevel` and `allowedTools` parameters, included in the IPC JSON payload.

### 8. Orchestrator wiring (`src/index.ts`)

- `processGroupMessages` implements two-mode logic:
  - Mode 1: `splitMessagesByPrivilege` → process each segment with appropriate privilege
  - Mode 2: `resolveSessionPrivilege` → single invocation at session floor (main group always owner)
- `runAgent` extended with `privilegeLevel`, `allowedTools`, `senderInfo` parameters
- Piping path in `startMessageLoop` resolves privilege per message batch and includes it in IPC payload

### 9. Task scheduler (`src/task-scheduler.ts`)

`runTask` uses `task.creator_privilege` (defaulting to `'owner'`) to set `privilegeLevel` and `allowedTools` in the ContainerInput.

### 10. IPC task creation (`src/ipc.ts`)

`processTaskIpc` accepts `creator_sender` and `creator_privilege` in the IPC data, passes them to `createTask`.

### 11. ScheduledTask type (`src/types.ts`)

Added optional `creator_sender` and `creator_privilege` fields to the `ScheduledTask` interface.

## Files Created

| File | Purpose |
|------|---------|
| `src/privilege-tools.ts` | Privilege-to-tool-list mapping |
| `src/privilege-tools.test.ts` | 13 tests for tool set correctness |
| `src/privilege-resolver.ts` | Two-mode privilege resolution |
| `src/privilege-resolver.test.ts` | 30 tests for segmentation and floor degradation |
| `src/migrations/003-privilege-fields.ts` | DB migration for task creator fields |
| `src/migrations/003-privilege-fields.test.ts` | 5 tests for migration correctness |
| `docs/extensions/C-dynamic-container-input.md` | This document |

## Files Modified

| File | Changes |
|------|---------|
| `src/container-runner.ts` | Extended ContainerInput, mount/args privilege gating, staleness fix |
| `src/container-runner.test.ts` | 3 new tests for privilege field acceptance |
| `container/agent-runner/src/index.ts` | Mirrored ContainerInput, dynamic allowedTools, IpcMessage struct |
| `src/index.ts` | Two-mode processGroupMessages, privilege-aware runAgent and piping |
| `src/db.ts` | createTask with creator columns |
| `src/group-queue.ts` | sendMessage with privilege info |
| `src/task-scheduler.ts` | Task execution uses creator_privilege |
| `src/ipc.ts` | Task creation captures creator identity |
| `src/types.ts` | ScheduledTask creator fields |
| `src/migrations/index.ts` | Registered migration 003 |

## Test Coverage

- **privilege-tools.test.ts**: 13 tests — tool set per privilege level, array isolation, strict ordering
- **privilege-resolver.test.ts**: 30 tests — segmentation, floor degradation, persistence, independence
- **003-privilege-fields.test.ts**: 5 tests — column creation, defaults, idempotency, round-trip
- **container-runner.test.ts**: 3 new tests — privilege field acceptance in ContainerInput
- All 494 tests pass (33 test files)
