# Fix: Kill Group-Specific Idle Containers Before Spawning

## Problem

`cleanupOrphans()` runs **once at startup** and kills containers left over from a
*previous* host process. It does not help with idle containers created during the
*current* process lifetime.

The sequence that caused the bug (no restart involved):

1. **09:42** — Host is already running. User sends a message. Container `nanoclaw-main-1773826956911` starts.
2. **~09:57** — Agent responds. Streaming callback fires → response delivered → `state.active = false` in GroupQueue. Container stays alive in IPC-idle mode, still binding port 4000.
3. **10:00** — User sends another message. `state.active` is false → `sendMessage()` returns false → `enqueueMessageCheck()` tries to spawn a **new** container → fails: "port already allocated".

`cleanupOrphans()` ran at startup (before step 1) and saw no orphans. It never ran again.
The idle container from step 2 was created **after** startup, so `cleanupOrphans()` never
saw it.

### Why did this only become a problem recently?

The streaming mode where `state.active = false` is set while the container is still alive
is **pre-existing upstream architecture** (present since at least commit `77f7423`
"fix: pass host timezone to container", Feb 2026) — not introduced by Extension C.

The bug was latent but harmless until commit `c70171e`
("digital-twin: expose container port 4000 for db-explorer"), which added
`dbExplorerPort: 4000` to the main group config. Without a bound port, multiple idle
containers co-existing was harmless. Once the port binding was added, the idle container
started blocking the next spawn.

---

## Consequences of Killing (What Is Lost?)

### Same-process case (idle container, this fix)

`state.active = false` is set only after the streaming promise resolves, which requires
at least one `---NANOCLAW_OUTPUT_END---` marker from the container. The response has
already been delivered and `lastAgentTimestamp` already advanced. **Nothing is lost.**
`docker kill` (SIGKILL, immediate) is appropriate.

### Startup case (`cleanupOrphans()`, already in place)

**A. Container was mid-computation (agent actively running tool calls):**
- The in-progress turn is abandoned.
- The message is NOT lost — `lastAgentTimestamp` is only advanced *after* the response is
  delivered. On restart, `loadState()` restores the old cursor and `recoverPendingMessages()`
  re-enqueues the message for retry in a fresh container.
- Session history (completed turns) is preserved; the incomplete turn is ignored by the
  SDK on resume.
- `cleanupOrphans()` uses `docker stop` (SIGTERM + 10s grace). Remaining risk: tool
  calls taking >10s are force-killed; the turn is retried cleanly.

**B. Container was idle (already responded):** Nothing lost.

---

## Why Detection of "Idle vs Active" Is Unnecessary

**The container is provably always idle when we reach `killGroupContainers()`:**

Call chain: `killGroupContainers()` ← `runContainerAgent()` ← `runAgent()` ←
`processGroupMessages()` ← `runForGroup()`.

`runForGroup()` is only entered when `state.active = false`. That flag is set in the
finally block only after `processGroupMessages()` returns, which only happens after
`runContainerAgent()` resolves. In streaming mode, that promise resolves only after
`onOutput(parsed)` fires. That fires only after the container emits
`---NANOCLAW_OUTPUT_END---`. The container emits that marker when the SDK emits
`message.type === 'result'` (agent-runner `index.ts` line 508) — only after the agent
has finished generating its full response. After this: SDK cleanup messages drain →
`runQuery()` returns → session-update `writeOutput()` fires (line 586) → agent-runner
enters `waitForIpcMessage()` IPC polling loop (line 591).

**`state.active = false` ⟹ container has already responded ⟹ container is idle.**

**Why not reuse?** Clean reuse would require keeping `state.active = true` while in
idle mode, which conflicts with the segment loop design — the early resolve in streaming
mode (container-runner.ts line 430) exists so the privilege-aware segment loop can start
the next container without waiting 30 min for the previous idle timeout.

---

## Implementation

### `src/container-runtime.ts`

Added private `listRunningContainers(nameFilter)` helper to deduplicate the
`docker ps --filter` pattern, then refactored `cleanupOrphans()` and added
`killGroupContainers(safeName)`:

- `cleanupOrphans()` keeps `docker stop` (graceful — startup orphans might be mid-computation)
- `killGroupContainers()` uses `docker kill` (immediate — container is always post-response)

### `src/container-runner.ts`

Added `killGroupContainers(safeName)` call just before `spawn()` in `runContainerAgent()`.

---

## Verification

1. `npm run dev`
2. Send a message to the main group → wait for response
3. Immediately send another message (before 30-min idle timeout)
4. Confirm: new container starts, old idle container is killed, response arrives
5. `groups/main/logs/` — new log shows exit code 0, no "port already allocated" error
