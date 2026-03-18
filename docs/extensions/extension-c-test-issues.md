# Extension C: Integration Test Issues Log

Issues, bugs, and action items discovered during integration testing of the Extension C privilege system.

Each entry includes enough context to serve as a ready-to-use prompt for a future development planning session.

---

## Issues

### ISSUE-001: Agent-runner stderr not visible until container exit

- **Status:** open
- **Discovered:** 2026-03-17, Test 1.1
- **Severity:** low (observability gap, not a functional bug)

**Context:** The agent-runner logs `Privilege:` and `tools:` info to stderr, but this only appears in the host log when the container exits (code 0 or 137). Containers stay alive for up to 2 hours (idle timeout), so privilege/tool verification during integration testing requires either waiting for exit or killing the container.

**Current behavior:** Container stderr is captured by `container-runner.ts` and logged in the `close` event handler. During the container's lifetime, stderr is buffered and not streamed to the host log.

**Impact:** Integration tests cannot verify privilege level in real-time. The host log `Processing privilege segment` partially compensates for Mode 1 (it logs `privilege` and `isMention`), but Mode 2 has no such host-side log — privilege is only visible in agent-runner stderr.

**Prompt for fix:**
> In `src/container-runner.ts`, the agent-runner's stderr is only logged when the container exits (in the `close` event handler). Add real-time streaming of stderr lines from the container process to the host logger, so that `[agent-runner]` lines (including `Privilege:` and `tools:` info) appear in the host log immediately. This is important for observability and integration testing. The stderr lines should be logged at `debug` level to avoid noise, but should include the group name for correlation. Consider using `proc.stderr.on('data', ...)` to stream lines as they arrive.

### ISSUE-002: Earlier NanoclawGroup messages processed at 'external' privilege before identity seeding

- **Status:** informational (not a bug — expected behavior before setup)
- **Discovered:** 2026-03-17, Test 1.1 (observed in host log history)

**Context:** Host log shows multiple `Processing privilege segment` entries with `privilege: 'external'` from timestamps 20:20–21:26, before the identity store was seeded at 22:14. These are from the initial NanoclawGroup messages (the user's earlier testing before the formal test session began).

**Impact:** None — this is expected. Before identity seeding, all senders are unmapped → external. The privilege floor for `telegram_nanoclaw-group` may have been set to `external` from these earlier runs, but we reset it in Phase 0C.

**No fix needed** — documenting for completeness.

### ISSUE-003: Multi-segment Mode 1 processing blocked by container idle timeout

- **Status:** fixed (early-resolve in streaming mode, deployed 2026-03-17 23:35)
- **Discovered:** 2026-03-17, Test 2.3
- **Severity:** high (functional bug — second segment never processes until container exits)

**Context:** In Mode 1 (`isPrivilegeAware`), `splitMessagesByPrivilege` correctly splits messages into segments (e.g., a context batch + an @-mention). The segment loop in `src/index.ts:285-316` processes them sequentially with `await runAgent(...)` per segment. However, `runContainerAgent` in `src/container-runner.ts:358-684` only resolves its Promise in the `container.on('close', ...)` handler — i.e., when the container **process exits**. In streaming mode, the agent output is delivered immediately via `onOutput` callback, but the awaited promise stays pending until the container's idle timeout (up to 2 hours) or manual kill.

**Current behavior:** Segment 1 spawns a container, the agent produces output and sends it to Telegram. But the `await` on line 299 of `src/index.ts` blocks the segment loop. Segment 2 (the @-mention) is never processed until the segment 1 container exits. In Test 2.3, the context message ("Can you hear me without a trigger?") was processed and responded to, but the @-mention message ("what was my previous message?") was stuck waiting.

**Impact:** Multi-segment privilege differentiation is effectively broken. When a non-mention context message precedes an @-mention in the same batch, the @-mention segment is delayed by up to 2 hours (container idle timeout). This defeats the purpose of per-segment privilege isolation.

**Prompt for fix:**
> In `src/index.ts`, the segment loop at lines 285-316 uses `await runAgent(...)` for each segment. But `runContainerAgent` (in `src/container-runner.ts`) only resolves when the container process exits, which can take up to 2 hours due to the idle timeout. For Mode 1 multi-segment processing to work, `runContainerAgent` needs to resolve its promise as soon as the agent produces its first streaming output (the response has been sent), rather than waiting for the container to exit. The container can continue running for IPC piping, but the promise should resolve early so the segment loop can proceed to the next segment. One approach: in streaming mode with `onOutput`, resolve the promise after the first `onOutput` call completes, and let the container continue running independently (tracked separately for cleanup). This requires refactoring the container lifecycle so that the "response is done" event is separate from the "container exited" event.

### ISSUE-004: allowedTools does not prevent MCP tool execution on resumed sessions

- **Status:** fixed (conditionally exclude Gmail MCP when not in allowedTools, deployed 2026-03-17 23:49)
- **Discovered:** 2026-03-17, Test 3.1
- **Severity:** high (privilege escalation — colleague accessed owner's Gmail)

**Context:** In Test 3.1, a colleague @-mention was correctly resolved to `privilege: 'colleague'` by the host. The host passed `allowedTools` with 19 tools (no `mcp__gmail__*`). However, the agent successfully read emails anyway. The container resumed session `abd43224` which had previously been used at `owner` privilege (Tests 2.1–2.3) where Gmail was available.

**Root cause hypothesis:** The Claude Agent SDK's `allowedTools` parameter in `query()` controls which tools are *offered* to the model in the current turn, but when resuming a session, the model retains knowledge of tools from previous turns in the conversation history. The MCP server (Gmail) remains connected in the container, so when the model requests an MCP tool call from memory, the SDK may still execute it even though it's not in the current `allowedTools` list. Alternatively, `allowedTools` may use exact matching while the MCP tool names use a wildcard pattern (`mcp__gmail__*`) that doesn't match individual tool names like `mcp__gmail__list_messages`.

**Impact:** Privilege isolation is bypassed when a lower-privilege segment resumes a session where a higher-privilege segment previously had access to restricted tools. A colleague can access the owner's Gmail by sending a message after an owner interaction in the same session.

**Prompt for fix:**
> In Test 3.1, a colleague @-mention was correctly gated at `privilege: 'colleague'` (no `mcp__gmail__*` in `allowedTools`), but the agent still accessed Gmail because it resumed a session where Gmail was previously available. There are two possible fixes:
>
> **Option A (session isolation):** Each privilege segment should start a fresh session (no `sessionId` in ContainerInput) so the model has no memory of higher-privilege tools. This is the most secure but loses conversation continuity across privilege levels.
>
> **Option B (MCP disconnect):** The agent-runner should dynamically disconnect/reconnect MCP servers based on `allowedTools` before each `query()`. If `mcp__gmail__*` is not in `allowedTools`, the Gmail MCP server should be disconnected for that query. This preserves session continuity but requires MCP lifecycle management.
>
> **Option C (SDK enforcement investigation):** Investigate whether the Claude Agent SDK's `allowedTools` parameter is supposed to hard-block tool execution (not just tool offering). If it's a bug in usage (e.g., wildcard patterns not expanding), fix the pattern matching. Check the SDK docs for `allowedTools` behavior with MCP tools.
>
> The most pragmatic first step is Option C — verify how `allowedTools` interacts with MCP tools in the SDK. If the SDK does enforce blocking, the issue is likely that `mcp__gmail__*` doesn't match individual MCP tool names in the `allowedTools` filter.

### ISSUE-005: Session continuity across privilege levels causes stale tool assumptions

- **Status:** open
- **Discovered:** 2026-03-17, Test 3.2
- **Severity:** medium (incorrect agent behavior — not a security issue)

**Context:** In Test 3.2, an owner @-mention was correctly gated at `privilege: 'owner'` with full tools including Gmail MCP. However, the agent did not attempt to use Gmail because it resumed the same session as the previous colleague run (Test 3.1) where Gmail was unavailable. The agent reported "Gmail MCP dropped a few minutes ago" based on session history, even though the owner's container had Gmail MCP connected.

**Impact:** When privilege levels change across segments in the same session, the agent carries forward incorrect assumptions about tool availability. An owner message after a colleague message may not use tools that are actually available, because the agent "remembers" they failed in the colleague's turn.

**Design tension:** Session continuity preserves conversation context (the agent knows what was discussed), but it also preserves incorrect tool-state assumptions. This is an inherent tension between context continuity and privilege isolation.

**Prompt for fix:**
> After ISSUE-004 fix, Gmail MCP is conditionally connected based on privilege. But session continuity means the agent sees the colleague's "Gmail failed" experience in its history. Options:
>
> **Option A (system prompt injection):** When privilege changes between segments, inject a system-level message into the prompt telling the agent which tools are NOW available, overriding any assumptions from session history. E.g., "Your available tools for this message: [list]. Tools may differ from previous turns."
>
> **Option B (per-privilege sessions):** Use separate sessions per privilege level. Each privilege level gets its own session file, so owner queries never see colleague tool failures. This loses cross-privilege context but is cleanest for isolation.
>
> **Option C (accept the limitation):** Document that session-shared groups may have stale tool assumptions. The agent will self-correct on the next fresh session. This is the least effort but may confuse users.
