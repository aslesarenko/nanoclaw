# Extension H: Observability Layer (Basic)

**Status:** Iteration 0 complete (trace recording + migration + query API + integration + tests + timing fix)
**Branch:** `digital-twin`
**Date:** 2026-03-13

## Goal

Add structured trace recording at key lifecycle points (message processing, task execution) for queryable observability, satisfying NFR-OBS-01 (structured, queryable logs), NFR-OBS-02 (end-to-end reasoning traces), and NFR-OBS-03 (per-interaction metadata). Each trace captures timing, identity, and status metadata in a `traces` SQLite table.

## What was implemented

### 1. Observability types (`src/types.ts`)

Added trace-related types:

- `TraceType` — `'message' | 'task'` discriminator for the two trace sources
- `TraceStatus` — `'success' | 'error' | 'timeout'` for outcome classification
- `Trace` — full trace record with traceId, type, groupFolder, chatJid, sender, channel, status, durationMs, error, tokenCount, toolCalls, createdAt

### 2. Migration 002 (`src/migrations/002-observability.ts`)

Creates the `traces` table with indexes on `group_folder`, `created_at`, and `type`. Purely additive DDL — no existing tables are modified. Follows the versioned migration pattern established by migration 001.

### 3. Observability module (`src/observability.ts`)

Core API for recording and querying traces:

- `generateTraceId()` — produces `tr-{uuid}` identifiers via `crypto.randomUUID()`
- `startTrace(type, groupFolder, chatJid, opts?)` — begins a trace, returns a `TraceContext` with start time
- `endTrace(ctx, status, error?)` — finalizes a trace: computes duration, persists to DB, returns the `Trace`
- `recordTrace(trace)` — direct insert (used by `endTrace` internally, also exported)
- `getTrace(traceId)` — lookup by ID
- `getTracesByGroup(groupFolder, limit?)` — filter by group, newest-first
- `getTracesByType(type, limit?)` — filter by type, newest-first
- `getRecentTraces(limit?)` — all traces, newest-first

Design decisions:
- **Synchronous writes** — better-sqlite3 single-row inserts are sub-millisecond, no async complexity needed
- **`startTrace`/`endTrace` pattern** — minimizes integration code (2 lines per callsite) while ensuring duration is always computed correctly
- **`TraceContext` is module-internal** — not exported to `types.ts` since it's an implementation detail

### 4. Integration points

**`src/index.ts` — `processGroupMessages()`:**
- `startTrace()` after early returns (no messages / no trigger), before actual work begins
- `endTrace()` at each of three return paths: success, error-after-output, error-with-rollback

**`src/task-scheduler.ts` — `runTask()`:**
- `startTrace()` at function entry, immediately after `startTime`
- `endTrace()` at each of three exit points: invalid folder, group not found, normal completion

### 5. Tests

- `src/migrations/002-observability.test.ts` — 4 tests: table creation, indexes, idempotency, column round-trip
- `src/observability.test.ts` — 16 tests: CRUD operations, query filters, ordering, limits, startTrace/endTrace lifecycle, placeholder fields, ID generation

## Architecture decisions

1. **No container-runner.ts changes** — message and task traces already wrap the full container lifecycle. Adding traces inside the container runner would create duplicate/nested traces with no additional information.

2. **Placeholder fields** — `tokenCount` and `toolCalls` are explicitly null. The gap analysis notes these exist inside the container and aren't available from the host. Future iterations will add container-side instrumentation to populate them.

3. **TraceStatus includes 'timeout'** — the container runner distinguishes timeouts from errors. While the current integration only uses 'success' and 'error' (timeouts surface as errors at the message/task level), the type is ready for future container-level traces.

4. **Default query limit of 100** — prevents unbounded queries while being generous enough for typical inspection. All query functions accept an explicit limit override.

5. **Streaming-callback trace recording** — Message traces are recorded in the streaming callback when the agent signals completion (`result.status === 'success'` or `'error'`), not after container exit. Containers stay alive for up to `IDLE_TIMEOUT` (30 min) waiting for follow-up messages, so deferring trace recording to container exit would delay traces by up to 30 minutes. A `traceEnded` flag prevents double-recording, with a fallback after container exit for edge cases (crash, no streaming status).

6. **Piped-message traces** — When a message is piped to an already-active container via IPC (bypassing `processGroupMessages()`), a lightweight trace is recorded with near-zero duration. This serves as an audit record that the message was received and routed. The container processes it asynchronously under the original container's trace.

## File inventory

### New files

| File | Purpose |
|------|---------|
| `src/observability.ts` | Core module: trace CRUD API + startTrace/endTrace helpers |
| `src/migrations/002-observability.ts` | Migration creating traces table + indexes |
| `src/observability.test.ts` | Unit tests for observability module (16 tests) |
| `src/migrations/002-observability.test.ts` | Migration tests (4 tests) |
| `docs/extensions/H-observability-layer.md` | This document |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Added `TraceType`, `TraceStatus`, `Trace` types |
| `src/migrations/index.ts` | Registered migration 002 in `allMigrations` |
| `src/index.ts` | Added `startTrace`/`endTrace` calls in `processGroupMessages()` streaming callback and `startMessageLoop()` piping path |
| `src/task-scheduler.ts` | Added `startTrace`/`endTrace` calls in `runTask()` |

## Deferred to future iterations

- **Token counting** — requires container-side instrumentation to capture token usage from the Claude Agent SDK
- **Tool call tracking** — requires container-side instrumentation to count MCP tool invocations
- **Container-level traces** — traces inside `runContainerAgent()` for spawn/close events
- **Trace querying API** — HTTP or CLI interface for the agent manager (Extension L)
- **Audience-adaptive trace detail** — different trace verbosity for different consumers
- **Trace retention / cleanup** — automatic pruning of old traces to manage database size
