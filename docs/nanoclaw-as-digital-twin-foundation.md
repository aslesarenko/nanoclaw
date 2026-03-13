# NanoClaw as a Digital Twin Foundation — Evaluation Report

**Date:** 2026-03-12
**Author:** Independent analysis based on full source review
**Scope:** Evaluate whether NanoClaw can serve as the foundation for the Kyber Wright digital twin (and the broader Eidos harness vision)

---

## Executive Summary

NanoClaw is a **strong foundation for a single-owner digital twin** but an **inadequate foundation for a multi-twin SDK**. The existing architecture covers ~60% of Kyber Wright's functional requirements out of the box, and its design philosophy (thin runtime, container isolation, channel abstraction) aligns well with the "before/around/above" framework proposed in the Eidos brainstorm. However, critical gaps exist in personality modeling, per-sender access control, provider flexibility, and observability — all of which are hard requirements for the digital twin PRD.

**Recommendation:** Use NanoClaw as the runtime layer (Layer 1–2 in the Eidos model), not as the SDK itself. Build Eidos primitives (personality engine, access control, twin registry) as a layer *on top of* NanoClaw's container orchestration, rather than replacing it.

---

## 1. What NanoClaw Already Provides

### 1.1 Multi-Channel Message Routing (FR-CH-01 through FR-CH-04)

NanoClaw's channel registry is a clean factory pattern that supports self-registration at startup. Every channel implements a minimal interface with `connect()`, `sendMessage()`, `isConnected()`, `ownsJid()`, and optional `setTyping()` — see [types.ts:82-93](src/types.ts#L82-L93). The orchestrator loops through registered channels and connects whichever ones return a valid instance — [index.ts:525-537](src/index.ts#L525-L537).

This directly satisfies FR-CH-01 (Slack reachability — Slack is already a supported channel), FR-CH-03 (channel-appropriate formatting via per-channel `sendMessage` implementations), and FR-CH-04 (graceful error handling with retry logic in [group-queue.ts:263-284](src/group-queue.ts#L263-L284)).

**Verdict:** Channel infrastructure is production-ready and extensible. No rework needed.

### 1.2 Container Isolation (NFR-PRIV, Security Architecture)

NanoClaw's primary security boundary is OS-level container isolation — each group gets its own container with only explicitly mounted directories visible. The mount system is detailed in [container-runner.ts:61-226](src/container-runner.ts#L61-L226):

- Non-main groups only see their own folder ([container-runner.ts:99-104](src/container-runner.ts#L99-L104))
- Global memory is read-only for non-main groups ([container-runner.ts:108-115](src/container-runner.ts#L108-L115))
- Session isolation prevents cross-group information disclosure ([container-runner.ts:119-166](src/container-runner.ts#L119-L166))
- Additional mounts are validated against an external allowlist stored outside the project root at `~/.config/nanoclaw/mount-allowlist.json` ([config.ts:24-29](src/config.ts#L24-L29)), making it tamper-proof from agents

The credential proxy ([credential-proxy.ts:26-119](src/credential-proxy.ts#L26-L119)) ensures containers never see real API keys — they route through a localhost HTTP proxy that injects authentication headers transparently. The container receives only `ANTHROPIC_API_KEY=placeholder` ([container-runner.ts:248-249](src/container-runner.ts#L248-L249)).

**Verdict:** Container isolation is NanoClaw's strongest asset. It directly addresses the Lethal Trifecta threat model cited in the Eidos brainstorm. The credential proxy pattern is exactly what a digital twin handling sensitive organizational data needs.

### 1.3 Persistent Memory (FR-MEM-06)

NanoClaw uses a hierarchical CLAUDE.md-based memory system: global memory at `groups/CLAUDE.md` (readable by all, writable only from main), and per-group memory at `groups/{name}/CLAUDE.md`. The agent loads these automatically via Claude Agent SDK's `settingSources: ['project', 'user']` — see [agent-runner index.ts:416](container/agent-runner/src/index.ts#L416). Memory persists across restarts because it's file-based on the host filesystem.

**Verdict:** Satisfies FR-MEM-06 (persistence across restarts). The CLAUDE.md approach is simple but limited — see Gap 2.2 below.

### 1.4 Scheduled Tasks (FR-PROD-05 context)

The task scheduler ([task-scheduler.ts](src/task-scheduler.ts)) supports cron, interval, and one-time schedules, all stored in SQLite. Tasks run as full agents with all tools available. This infrastructure is directly usable for digital twin scheduled activities (e.g., "check my email every morning and send a summary").

**Verdict:** Ready to use. No changes needed.

### 1.5 Conversation Continuity (FR-CONV-01)

Sessions are maintained per-group via Claude Agent SDK's `resume` option. Session IDs are stored in SQLite and passed to each container invocation — [index.ts:270](src/index.ts#L270). The agent-runner supports a query loop where follow-up messages are piped via IPC files while the container stays alive — [agent-runner index.ts:513-549](container/agent-runner/src/index.ts#L513-L549).

**Verdict:** Multi-turn conversation context works. The IPC-based message piping is particularly valuable for maintaining context across rapid exchanges.

### 1.6 Concurrency Management

The `GroupQueue` class ([group-queue.ts:30-365](src/group-queue.ts#L30-L365)) manages per-group queuing with a global concurrency limit (`MAX_CONCURRENT_CONTAINERS`, default 5). It handles retry with exponential backoff ([group-queue.ts:263-284](src/group-queue.ts#L263-L284)), task/message prioritization ([group-queue.ts:286-316](src/group-queue.ts#L286-L316)), and graceful shutdown ([group-queue.ts:347-364](src/group-queue.ts#L347-L364)).

**Verdict:** Solid concurrency model that would work well for a digital twin handling multiple simultaneous conversations.

---

## 2. Critical Gaps

### 2.1 No Per-Sender Access Control (NFR-PRIV-01 — HARD BLOCKER)

The digital twin PRD requires a privilege boundary: "certain capabilities (workforce data, sensitive knowledge base content) are available only to the owner, not to colleagues" ([REQUIREMENTS.md:99-105](digital-twin/REQUIREMENTS.md#L99-L105)).

NanoClaw's security model is **per-group, not per-sender**. The sender allowlist ([sender-allowlist.ts:1-128](src/sender-allowlist.ts#L1-L128)) only controls who can *trigger* the agent or whose messages are *dropped* — it does not filter which tools the agent receives based on sender identity. Once triggered, the agent runs with the full tool set defined in [agent-runner index.ts:402-412](container/agent-runner/src/index.ts#L402-L412) — the same tools regardless of who sent the message.

The Eidos brainstorm correctly identifies this as a fundamental architectural difference: "NanoClaw uses container isolation — each chat group gets its own Docker container... Eidos uses tool-level privilege scoping — the same agent instance serves multiple users, but the tool set is dynamically scoped per message" ([brainstorm:130-136](digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md#L130-L136)).

**Impact:** A colleague messaging the twin in a shared Slack channel would have access to the same tools and data as the owner. This violates the core security requirement and the "authorization must be code, not LLM" hard rule from the Kyber Wright prototype experience.

**Remediation complexity:** Medium-high. Requires modifying the `ContainerInput` interface to include sender identity, the agent-runner to accept per-invocation tool allowlists, and a new pre-invocation pipeline that resolves sender → privilege level → tool set. The container mount system would also need per-sender scoping (e.g., owner gets workforce data mounted, colleagues don't).

### 2.2 No Structured Personality Engine (FR-ID-01 through FR-ID-05 — HARD BLOCKER)

The PRD requires a configurable identity with "name, origin story, core values, areas of expertise, and hard boundaries" ([REQUIREMENTS.md:27](digital-twin/REQUIREMENTS.md#L27)), consistent personality traits ([REQUIREMENTS.md:28](digital-twin/REQUIREMENTS.md#L28)), and context-adaptive communication voice ([REQUIREMENTS.md:29](digital-twin/REQUIREMENTS.md#L29)).

NanoClaw uses a flat CLAUDE.md file for personality, loaded as a generic system prompt. There is no structured personality model — the agent-runner either loads global CLAUDE.md as a system prompt append ([agent-runner index.ts:371-374](container/agent-runner/src/index.ts#L371-L374)) or relies on per-group CLAUDE.md via `settingSources: ['project']`. There's no separation of identity, character, and voice layers. There's no mechanism to adapt communication style based on audience (concise for directives vs. detailed for reasoning chains, as FR-ID-03 requires).

The Eidos brainstorm proposes a structured 3-layer personality system: "Structured 3-layer system bound to role + person" vs. NanoClaw's "Generic CLAUDE.md per chat" ([brainstorm:205](../digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md#L205)).

**Impact:** Without a personality engine, the twin cannot embody the owner's values, decision style, or communication patterns. It would be a generic assistant, not a digital twin.

**Remediation complexity:** Medium. The personality engine is purely a "BEFORE" zone component — it composes the system prompt before the agent is invoked. This can be built as a layer on top of NanoClaw without modifying the container runtime. The `systemPrompt` option in the agent-runner ([agent-runner index.ts:399-401](container/agent-runner/src/index.ts#L399-L401)) already supports custom system prompts — the personality engine would generate these.

### 2.3 Locked to Claude / No Provider Flexibility (NFR-CFG-02)

NanoClaw is hard-wired to Claude Agent SDK. The agent-runner imports `query` directly from `@anthropic-ai/claude-agent-sdk` ([agent-runner index.ts:19](container/agent-runner/src/index.ts#L19)). The credential proxy is specifically designed for the Anthropic API ([credential-proxy.ts:41-44](src/credential-proxy.ts#L41-L44)). There is no model abstraction layer.

The PRD requires: "The reasoning model must be swappable (the twin should not be locked to a single AI provider)" ([REQUIREMENTS.md:129](digital-twin/REQUIREMENTS.md#L129)).

**Impact:** Cannot use Gemini or other providers. This is a hard requirement for the IOG context where GCP/Gemini is the primary cloud provider.

**Remediation complexity:** Very high. This would require replacing the entire agent-runner with a framework-agnostic approach (e.g., LangGraph). The container orchestration layer (host-side) could remain unchanged, but everything inside the container would need rewriting. This is the single biggest gap between NanoClaw and the Eidos vision.

### 2.4 No Agent Manager Observability (NFR-OBS)

The PRD requires structured, queryable logs (NFR-OBS-01), end-to-end reasoning traces (NFR-OBS-02), and per-interaction metadata (NFR-OBS-03) — see [REQUIREMENTS.md:118-123](digital-twin/REQUIREMENTS.md#L118-L123).

NanoClaw's observability is limited to:
- Pino structured logs on the host ([logger.ts](src/logger.ts))
- Per-container log files written to `groups/{name}/logs/` ([container-runner.ts:325-326](src/container-runner.ts#L325-L326))
- No trace capture, no analytics, no feedback collection

The Eidos brainstorm identifies this as a key difference: "Observability: 'Ask the agent' [NanoClaw] vs. First-class traces, analytics, feedback for the agent manager [Eidos]" ([brainstorm:207](digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md#L207)).

**Impact:** The agent manager (a first-class actor in the Eidos model) has no way to see what twins are doing, how they're performing, or what users are asking.

**Remediation complexity:** Medium. Traces can be added via LangSmith integration (or similar) at the framework level. This is an "ABOVE" zone concern that doesn't require modifying NanoClaw's core.

### 2.5 No Knowledge Base Integration (FR-KB)

The PRD defines 7 knowledge base requirements (FR-KB-01 through FR-KB-07) covering organizational facts, overdue commitments, project health, decision reasoning traces, and evidence documents — [REQUIREMENTS.md:58-63](digital-twin/REQUIREMENTS.md#L58-L63).

NanoClaw has no knowledge base concept. Agents can read files in their mounted directories and search the web, but there's no structured knowledge base with queries by person, project, or time range. The MCP tools available to agents ([agent-runner index.ts:402-412](container/agent-runner/src/index.ts#L402-L412)) don't include any knowledge base tools.

**Impact:** The twin cannot answer questions about the owner's organizational context. This is a core value proposition of the digital twin.

**Remediation complexity:** Low-medium. Knowledge base tools can be added as MCP servers mounted into the container, following the same pattern as the Gmail MCP ([agent-runner index.ts:428-430](container/agent-runner/src/index.ts#L428-L430)). The container mount system already supports additional directories ([container-runner.ts:216-223](src/container-runner.ts#L216-L223)) where knowledge base files could reside.

### 2.6 No Workforce Analytics (FR-WF)

Similar to FR-KB but specifically about structured data queries against workforce datasets. NanoClaw has no data analysis tools, no PII protection layer, and no mechanism for restricting workforce data access to authorized users only.

**Remediation complexity:** Medium. Requires custom MCP tools with built-in access control checks — but this is twin-specific code that belongs in the twin, not the harness.

---

## 3. Architectural Alignment Analysis

### 3.1 Mapping to "Before / Around / Above"

The Eidos research document proposes that harness code lives in three zones: BEFORE (pre-invocation), AROUND (composition/middleware), and ABOVE (management) — [research:15-45](digital-twin/docs/research/2026-03-12-agent-harness-best-practices.md#L15-L45).

| Zone | Eidos Needs | NanoClaw Coverage | Assessment |
|:-----|:-----------|:-----------------|:-----------|
| **BEFORE: Channel adapters** | Translate platform events → canonical request | Full — channel registry + `formatMessages()` ([router.ts:13-25](src/router.ts#L13-L25)) | **Ready** |
| **BEFORE: Sender identification** | Resolve platform user ID → identity | Partial — sender name extraction exists ([types.ts:45-54](src/types.ts#L45-L54)) but no identity resolution to known persons | **Gap** |
| **BEFORE: Access control** | Identity → privilege → tool set | Missing — sender allowlist is trigger-only ([sender-allowlist.ts:98-106](src/sender-allowlist.ts#L98-L106)) | **Hard gap** |
| **BEFORE: Personality engine** | Structured personality → system prompt | Missing — flat CLAUDE.md only | **Hard gap** |
| **AROUND: Twin factory** | Wire model + tools + store + prompt | Partial — `runContainerAgent()` ([container-runner.ts:286-662](src/container-runner.ts#L286-L662)) is essentially a factory function | **Adaptable** |
| **AROUND: Tool registry + privilege** | Tools filtered per invocation | Missing — fixed tool list in agent-runner ([agent-runner index.ts:402-412](container/agent-runner/src/index.ts#L402-L412)) | **Hard gap** |
| **AROUND: Hooks/middleware** | Audit, cost, safety gating | Missing — no middleware layer | **Gap** |
| **ABOVE: Twin registry** | Catalog of active twins | Missing | **Gap** |
| **ABOVE: Observability** | Traces, analytics for agent manager | Missing — logs only | **Gap** |
| **ABOVE: Feedback** | Channel-native + agent-initiated | Missing | **Gap** |

**Score: 3/10 Eidos primitives are covered, 2 more are partially covered.**

### 3.2 NanoClaw's Philosophy vs. Digital Twin Requirements

NanoClaw's philosophy is explicitly **anti-framework**: "This isn't a framework or a platform. It's working software for my specific needs" ([REQUIREMENTS.md:27](docs/REQUIREMENTS.md#L27)). "Customization = Code Changes... If you want different behavior, modify the code" ([REQUIREMENTS.md:29-31](docs/REQUIREMENTS.md#L29-L31)).

The digital twin PRD requires configurability *without* code changes: "The twin's personality must be configurable without code changes" (FR-ID-05 at [REQUIREMENTS.md:31](digital-twin/REQUIREMENTS.md#L31)), "Each capability must be independently enabled or disabled without code changes" (NFR-CFG-01 at [REQUIREMENTS.md:128](digital-twin/REQUIREMENTS.md#L128)).

This is a **philosophical tension**, not a technical one. NanoClaw's codebase is small enough (~3,900 LOC as noted in [research:174](digital-twin/docs/research/2026-03-12-agent-harness-best-practices.md#L174)) that adding configuration points is straightforward. But the design *intent* is different: NanoClaw optimizes for one user who modifies code; Eidos optimizes for an agent manager who configures twins declaratively.

### 3.3 Single-User vs. Multi-Twin

NanoClaw is architected around one assistant name (`ASSISTANT_NAME` in [config.ts:11-12](src/config.ts#L11-L12)), one trigger pattern ([config.ts:65-68](src/config.ts#L65-L68)), one set of channels, one process. The `registeredGroups` map ([index.ts:64](src/index.ts#L64)) partitions conversations but not *identities* — every group talks to the same assistant.

The Eidos vision requires multiple twins (Layer 4 instances in the brainstorm at [brainstorm:19-26](digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md#L19-L26)): Kyber Wright (Carlos' CoS), Scamp McCarthy (Ger's CoS), process twins for budget reconciliation, etc. Each with different personality, tools, and access rules.

Running multiple NanoClaw instances (one per twin) is possible but wasteful — each would need its own Node.js process, its own channel connections, and its own SQLite database. The architecture doesn't support multiplexing twins on a single channel connection.

---

## 4. Reuse Assessment

### 4.1 What to Keep (High-Value Components)

| Component | LOC | Why Keep |
|:----------|:----|:---------|
| Container orchestration ([container-runner.ts](src/container-runner.ts)) | ~727 | Mount security, credential proxy, timeout handling — all production-hardened |
| Channel registry ([channels/registry.ts](src/channels/registry.ts)) | ~20 | Clean factory pattern, channel-agnostic |
| Group queue ([group-queue.ts](src/group-queue.ts)) | ~365 | Concurrency limiting, retry logic, graceful shutdown |
| Credential proxy ([credential-proxy.ts](src/credential-proxy.ts)) | ~126 | Critical security component — containers never see secrets |
| Mount security ([mount-security.ts](src/mount-security.ts)) | ~100 | External allowlist, symlink resolution, blocked patterns |
| Sender allowlist ([sender-allowlist.ts](src/sender-allowlist.ts)) | ~128 | Useful as a building block for access control |
| IPC system ([ipc.ts](src/ipc.ts)) | ~200 | File-based IPC for container ↔ host communication |
| SQLite layer ([db.ts](src/db.ts)) | ~300 | Message storage, group registration, session tracking |

### 4.2 What to Replace or Extend

| Component | Why |
|:----------|:----|
| Agent runner ([container/agent-runner/src/index.ts](container/agent-runner/src/index.ts)) | Hard-wired to Claude SDK. Must be abstracted for provider flexibility, or replaced with LangGraph-based runner |
| Message formatting ([router.ts:13-25](src/router.ts#L13-L25)) | Needs personality-aware prompt composition, not just XML message wrapping |
| Config ([config.ts](src/config.ts)) | Single-assistant assumptions. Needs per-twin configuration |
| Orchestrator ([index.ts](src/index.ts)) | Single-assistant loop. Needs twin registry integration |

### 4.3 What to Build New

| Component | Eidos Zone | Exists in NanoClaw? |
|:----------|:----------|:-------------------|
| Personality engine | BEFORE | No |
| Identity resolution (platform ID → person) | BEFORE | No |
| Privilege-scoped tool registry | AROUND | No |
| Twin registry | ABOVE | No |
| Observability / trace capture | ABOVE | No |
| Feedback collection | ABOVE | No |
| Knowledge base MCP tools | Twin-specific | No |
| Workforce analytics MCP tools | Twin-specific | No |

---

## 5. Verdict: Two Viable Strategies

### Strategy A: NanoClaw as Runtime, Eidos as Harness Layer

Keep NanoClaw's container orchestration, channel system, and IPC as the runtime (Layers 1-2). Build Eidos primitives (personality, access control, twin registry, observability) as a harness layer that sits between the channels and the container runner.

**Pros:**
- Reuses the most valuable and hardest-to-build components (container security, credential proxy, mount validation)
- NanoClaw's ~3,900 LOC is small enough to understand and modify
- Channel ecosystem (WhatsApp, Telegram, Slack, Discord, Gmail) is already built
- Container isolation provides defense-in-depth that complements tool-level access control

**Cons:**
- Node.js/TypeScript stack constrains the Eidos SDK to the same language (the existing Kyber Wright prototype is Python/LangGraph)
- Claude SDK lock-in inside the container is the hardest gap to bridge
- Philosophical tension between "modify code" and "configure declaratively"

### Strategy B: Extract Patterns, Build Eidos Fresh

Study NanoClaw's architecture, adopt its design principles (thin runtime, container isolation, credential proxy), but build Eidos from scratch in Python with LangGraph as the framework layer.

**Pros:**
- No language mismatch with existing Kyber Wright prototype
- LangGraph provides agent loop, memory, checkpointing natively
- Clean implementation of the before/around/above framework
- No inherited single-assistant assumptions

**Cons:**
- Loses ~2,000 LOC of production-hardened container orchestration code
- Must rebuild channel adapters (or use different channel libraries)
- Container isolation patterns must be reimplemented
- Higher initial effort

### Recommendation

**Strategy A is preferred for Phase 1** (getting Kyber Wright to production). The container orchestration layer is the single most valuable piece, and rebuilding it in Python would take significant effort for equivalent security properties. The Claude SDK lock-in is mitigable by treating the container interior as swappable — the host orchestration doesn't depend on which SDK runs inside.

**Strategy B becomes relevant in Phase 2** if multi-provider support proves essential or if the Python/LangGraph ecosystem offers significantly better primitives for the personality engine and observability layer.

The key insight from the research document applies: "A harness should never replace framework primitives" ([research:14](digital-twin/docs/research/2026-03-12-agent-harness-best-practices.md#L14)). NanoClaw's container orchestration *is* the framework primitive for isolated execution. Eidos should compose around it, not replace it.

---

## 6. Gap-to-Requirement Traceability Matrix

| PRD Requirement | NanoClaw Status | Gap Severity | Remediation Path |
|:---------------|:---------------|:------------|:----------------|
| FR-ID-01–05 (Personality) | Missing | **High** | Build personality engine (BEFORE zone) |
| FR-CONV-01 (Multi-turn) | Covered | — | Session resume works |
| FR-CONV-02 (Intent reasoning) | Covered | — | Claude handles this natively |
| FR-CONV-04 (Owner's voice) | Missing | **High** | Requires personality engine |
| FR-MEM-01–02 (Per-person memory) | Partial | Medium | CLAUDE.md exists but not per-person |
| FR-MEM-03 (Categorized, searchable) | Missing | Medium | Need structured memory tools |
| FR-MEM-04 (Auto-save facts) | Partial | Low | Claude auto-memory enabled ([container-runner.ts:142](src/container-runner.ts#L142)) |
| FR-MEM-06 (Persist across restarts) | Covered | — | File-based on host |
| FR-KB-01–07 (Knowledge base) | Missing | **High** | Build as MCP tools |
| FR-WF-01–05 (Workforce) | Missing | **High** | Build as MCP tools + access control |
| FR-PROD-01 (Documents) | Partial | Low | Web fetch exists; needs doc tools |
| FR-PROD-02 (Calendar) | Missing | Medium | Build as MCP tool |
| FR-PROD-03 (Email) | Covered | — | Gmail MCP exists ([agent-runner index.ts:428-430](container/agent-runner/src/index.ts#L428-L430)) |
| FR-PROD-04 (Web search) | Covered | — | WebSearch tool exists |
| FR-CH-01 (Slack) | Covered | — | Slack channel skill exists |
| FR-CH-02 (Thread-only in groups) | Partial | Low | Trigger pattern approximates this |
| NFR-PRIV-01 (Privilege boundary) | Missing | **Critical** | Build access control (BEFORE zone) |
| NFR-PRIV-02 (No raw content to unauthorized) | Missing | **Critical** | Requires per-sender tool scoping |
| NFR-REL-01 (Reasonable response time) | Covered | — | Typing indicators, streaming |
| NFR-REL-02 (Survive restarts) | Covered | — | SQLite + file persistence |
| NFR-REL-03 (Graceful degradation) | Partial | Low | Container failures handled; no per-tool degradation |
| NFR-OBS-01–03 (Observability) | Missing | **High** | Build trace/analytics layer (ABOVE zone) |
| NFR-CFG-01 (Toggle capabilities) | Missing | Medium | Need per-twin capability config |
| NFR-CFG-02 (Swappable model) | Missing | **High** | Claude SDK lock-in |
| NFR-CFG-03 (Config via files) | Partial | Medium | CLAUDE.md exists; needs structured YAML |
| NFR-DEP-01 (Independent channels) | Covered | — | Channel registry handles this |
| NFR-DEP-02 (Secret management) | Covered | — | Credential proxy |

**Coverage summary:** 10 covered, 8 partial, 16 missing. Of 16 missing, 7 are high/critical severity.

---

## 7. Extension Dependency Graph and Iteration Plan

### 7.1 Extension Nodes

Each node represents a discrete extension or addition needed to fill the gaps identified in Sections 2–3. Node IDs are used in the dependency graph below.

| ID | Extension | Eidos Zone | Files Touched | New Files |
|:---|:----------|:-----------|:-------------|:----------|
| **A** | Sender Identity Store & Resolution | BEFORE | [types.ts](src/types.ts) (add `SenderIdentity` type), [db.ts](src/db.ts) (new `known_persons` table), [index.ts:146-261](src/index.ts#L146-L261) (`processGroupMessages` passes sender to `runAgent`) | `src/identity.ts` (identity store + resolver) |
| **B** | Personality Engine (basic — owner voice) | BEFORE | [container-runner.ts:38-46](src/container-runner.ts#L38-L46) (`ContainerInput` gains `personalityPrompt` field), [agent-runner index.ts:399-401](container/agent-runner/src/index.ts#L399-L401) (use `personalityPrompt` in `systemPrompt`) | `src/personality.ts` (YAML loader + prompt composer), `config/personality.yaml` |
| **C** | Dynamic ContainerInput (sender identity + privilege plumbing) | AROUND | [container-runner.ts:38-46](src/container-runner.ts#L38-L46) (`ContainerInput` gains `senderIdentity`, `privilegeLevel`, `allowedToolPatterns`), [agent-runner index.ts:402-412](container/agent-runner/src/index.ts#L402-L412) (`allowedTools` reads from input instead of hardcoded list), [container-runner.ts:61-226](src/container-runner.ts#L61-L226) (`buildVolumeMounts` conditionally mounts sensitive dirs based on privilege) | — |
| **D** | Dynamic Tool Registry | AROUND | [agent-runner index.ts:402-412](container/agent-runner/src/index.ts#L402-L412) (tool list from registry), [ipc-mcp-stdio.ts:37-338](container/agent-runner/src/ipc-mcp-stdio.ts#L37-L338) (MCP servers conditionally loaded) | `src/tool-registry.ts` (tool metadata + privilege annotations) |
| **E** | Structured Memory (per-person, categorized) | BEFORE | [container-runner.ts:119-166](src/container-runner.ts#L119-L166) (mount per-person memory dirs), [agent-runner index.ts:369-387](container/agent-runner/src/index.ts#L369-L387) (load per-person context) | New MCP tools for memory CRUD, or extend `ipc-mcp-stdio.ts` |
| **F** | Knowledge Base MCP Tools | Twin-specific | [agent-runner index.ts:417-431](container/agent-runner/src/index.ts#L417-L431) (add KB MCP server to `mcpServers`), [container-runner.ts:216-223](src/container-runner.ts#L216-L223) (mount KB data) | `container/mcp-servers/knowledge-base/` (new MCP server) |
| **G** | Twin Configuration System | AROUND | [config.ts](src/config.ts) (per-twin config loader replacing single `ASSISTANT_NAME`), [index.ts:64-86](src/index.ts#L64-L86) (state management per twin), [db.ts:76-84](src/db.ts#L76-L84) (`registered_groups` gains `twin_config` column) | `src/twin-config.ts`, `config/twins/` directory |
| **H** | Observability Layer (trace capture) | ABOVE | [container-runner.ts:454-598](src/container-runner.ts#L454-L598) (emit trace events on container lifecycle), [index.ts:206-261](src/index.ts#L206-L261) (emit trace events on message processing), [task-scheduler.ts:78-239](src/task-scheduler.ts#L78-L239) (emit trace events on task runs) | `src/observability.ts` (trace emitter + storage), new DB tables |
| **I** | Workforce Analytics MCP Tools | Twin-specific | Same MCP pattern as F, plus access-control gating from D | `container/mcp-servers/workforce/` (new MCP server with PII checks) |
| **J** | Audience-Adaptive Personality | BEFORE | Extends B: [personality.ts] (voice selection based on sender identity from A) | — (extends existing `personality.ts`) |
| **K** | Provider Abstraction | AROUND | [agent-runner index.ts:19](container/agent-runner/src/index.ts#L19) (replace Claude SDK import), [agent-runner index.ts:392-465](container/agent-runner/src/index.ts#L392-L465) (replace `query()` with framework-agnostic agent loop), [credential-proxy.ts:41-44](src/credential-proxy.ts#L41-L44) (support multiple upstream APIs), [container-runner.ts:238-258](src/container-runner.ts#L238-L258) (env vars for provider selection) | `container/agent-runner/src/provider.ts` (provider abstraction) |
| **L** | Agent Management API | ABOVE | Consumes H, G, M; read-only initially | `src/management-api.ts` (HTTP server for traces, config, feedback) |
| **M** | Feedback Collection | ABOVE | Channel adapters (e.g., Slack reactions → feedback events), [ipc.ts](src/ipc.ts) (new IPC type for feedback) | `src/feedback.ts` (collection + storage) |

### 7.2 Dependency Graph

Edges represent **hard dependencies** — the target extension cannot be implemented correctly or safely without the source extension being in place. The reasoning for each edge is grounded in specific code-level coupling.

```
 ┌───┐     ┌───┐     ┌───┐
 │ A │     │ B │     │ H │        Iteration 0: Foundations (parallel)
 └─┬─┘     └─┬─┘     └─┬─┘
   │         │         │
   │    ┌────┤         │
   ▼    ▼    ▼         │
 ┌───┐ ┌───┐           │
 │ C │ │ J │           │          Iteration 1: Plumbing
 └─┬─┘ └───┘           │
   │                    │
   ▼                    │
 ┌───┐  ┌───┐          │
 │ D │  │ E │          │          Iteration 2: Tool & Memory Infrastructure
 └─┬─┘  └───┘          │
   │                    │
   ├──────┐             │
   ▼      ▼             │
 ┌───┐  ┌───┐          │
 │ F │  │ I │          │          Iteration 3: Domain Tools
 └───┘  └───┘          │
                        │
 ┌───┐  ┌───┐          │
 │ G │  │ M │◄─────────┘          Iteration 4: Configuration & Feedback
 └─┬─┘  └─┬─┘
   │      │
   ▼      ▼
   ┌──────┐
   │  L   │                       Iteration 5: Management API
   └──────┘

 ┌───┐
 │ K │                            Iteration 4–5: Provider Abstraction (parallel track)
 └───┘
```

### 7.3 Edge Justifications

Each dependency edge is justified by a specific code-level coupling:

| Edge | Why Required |
|:-----|:------------|
| **A → C** | `ContainerInput` ([container-runner.ts:38-46](src/container-runner.ts#L38-L46)) must carry `senderIdentity` and `privilegeLevel` fields. These values come from the identity resolver (A). Without A, C has no identity to pass — the `processGroupMessages` function ([index.ts:146-261](src/index.ts#L146-L261)) currently only extracts `sender` as a raw string from `NewMessage` ([types.ts:49](src/types.ts#L49)), not as a resolved identity with privilege level. |
| **A → J** | Audience-adaptive personality needs to know *who* is talking to select the right voice. The personality engine (J) must call `resolveIdentity(sender)` to determine whether the sender is the owner, a colleague, or external — because FR-ID-03 requires different voice for each ([REQUIREMENTS.md:29](digital-twin/REQUIREMENTS.md#L29)). Without A, the personality engine cannot distinguish senders. |
| **B → J** | J extends B's prompt-composition logic. B creates the basic personality prompt from YAML config; J adds audience-adaptive voice selection on top of it. J modifies the same `systemPrompt` construction path ([agent-runner index.ts:399-401](container/agent-runner/src/index.ts#L399-L401)). Without B's structured prompt builder, J has nothing to extend. |
| **C → D** | The dynamic tool registry (D) needs the plumbing that C provides. Specifically, C modifies `ContainerInput` to carry `allowedToolPatterns` and makes the agent-runner read `allowedTools` from that input instead of the hardcoded list at [agent-runner index.ts:402-412](container/agent-runner/src/index.ts#L402-L412). Without C, D's privilege-filtered tool list has no transport mechanism from host to container. |
| **C → E** | Per-person structured memory requires mounting person-specific directories into the container. C adds the sender identity to `ContainerInput`, which `buildVolumeMounts` ([container-runner.ts:61-226](src/container-runner.ts#L61-L226)) needs to decide which memory dirs to mount. Without C, the container has no way to know which person's memory to load. |
| **D → F** | Knowledge base MCP tools must be conditionally loaded based on privilege. The tool registry (D) provides the mechanism to annotate KB tools with privilege requirements and filter them per invocation. Without D, KB tools would be available to all senders — violating NFR-PRIV-02 ("Raw knowledge base content must never be exposed verbatim to unauthorized users" — [REQUIREMENTS.md:103](digital-twin/REQUIREMENTS.md#L103)). |
| **D → I** | Workforce analytics requires the strictest access control (FR-WF-03: "Workforce data access must be restricted to the owner and explicitly authorized users" — [REQUIREMENTS.md:72](digital-twin/REQUIREMENTS.md#L72)). The tool registry (D) gates which MCP servers are loaded per invocation. Without D, the workforce MCP would be available to all senders, exposing PII. |
| **H → M** | Feedback annotations must reference trace IDs to be meaningful. When a Slack reaction arrives, the feedback system needs to correlate it to the specific agent invocation (trace) that produced the response. Without H's trace IDs, feedback is untethered — you know the user reacted, but not to which reasoning chain. |
| **G → L** | The management API exposes twin configuration for tuning (personality, capabilities, schedule). It reads from the twin config system (G). Without G's structured config schema, L has no config to expose or modify. |
| **M → L** | The management API aggregates feedback for the agent manager. Without M's collected feedback data, L's feedback dashboard has no data source. |
| **H → L** | The management API's primary function is exposing traces and analytics. Without H capturing traces, L's observability views are empty. The entire "agent manager needs execution traces" requirement ([brainstorm:67-69](digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md#L67-L69)) flows through this edge. |

### 7.4 Topological Sort — Iteration Plan

The dependency graph has **no cycles**. A topological sort yields the following execution order, grouped into iterations that maximize parallelism within each iteration while respecting all edges.

---

#### Iteration 0 — Foundations (parallel, no prerequisites)

Three independent workstreams that can proceed simultaneously. These are the load-bearing primitives that all later iterations depend on.

| Extension | Description | Key Deliverables |
|:----------|:-----------|:----------------|
| **A: Sender Identity Store** | New `src/identity.ts` module with a `known_persons` SQLite table mapping platform-specific sender IDs (e.g., WhatsApp phone, Slack user ID, Telegram user ID) to a canonical `PersonIdentity` with name, role, and privilege level (owner/colleague/external). Add `resolveIdentity(chatJid, sender)` function called from `processGroupMessages` ([index.ts:146](src/index.ts#L146)). Extend `NewMessage` ([types.ts:45-54](src/types.ts#L45-L54)) to carry resolved identity. Seed the store for the owner from the main group's `isMain` flag ([types.ts:42](src/types.ts#L42)). | `src/identity.ts`, `known_persons` table in [db.ts](src/db.ts), identity resolution in message flow |
| **B: Personality Engine (basic)** | New `src/personality.ts` that loads a structured YAML personality definition (identity layer: name, origin, values; character layer: decision style, temperament; voice layer: communication patterns). Composes a system prompt string from these layers. Inject via `ContainerInput.personalityPrompt` into the existing `systemPrompt.append` path at [agent-runner index.ts:399-401](container/agent-runner/src/index.ts#L399-L401). This replaces the generic global CLAUDE.md append with a structured, personality-aware prompt. | `src/personality.ts`, `config/personality.yaml` schema, `ContainerInput.personalityPrompt` field |
| **H: Observability Layer (basic)** | New `src/observability.ts` that emits structured trace events at key lifecycle points: container spawn ([container-runner.ts:315-323](src/container-runner.ts#L315-L323)), container completion ([container-runner.ts:454-598](src/container-runner.ts#L454-L598)), message processing start/end ([index.ts:187-261](src/index.ts#L187-L261)), task execution ([task-scheduler.ts:106-239](src/task-scheduler.ts#L106-L239)). Each trace carries: timestamp, group, sender, channel, duration, tool calls, token count (from streamed output). Store in a new `traces` SQLite table. | `src/observability.ts`, `traces` table in [db.ts](src/db.ts), trace hooks in orchestrator and container-runner |

**Why these are independent:** A adds identity resolution in the message-processing path. B adds personality prompt composition in the container-invocation path. H adds trace emission at lifecycle boundaries. None touches the same code paths — A modifies `processGroupMessages` input handling, B modifies `ContainerInput` → `systemPrompt`, H adds event hooks at entry/exit points. They can be developed and tested in isolation.

---

#### Iteration 1 — Plumbing (depends on Iteration 0)

Wire the identity and personality foundations into the container invocation pipeline.

| Extension | Description | Depends On |
|:----------|:-----------|:-----------|
| **C: Dynamic ContainerInput** | Extend `ContainerInput` ([container-runner.ts:38-46](src/container-runner.ts#L38-L46)) with `senderIdentity: PersonIdentity`, `privilegeLevel: 'owner' \| 'colleague' \| 'external'`, and `allowedToolPatterns: string[]`. Modify `runAgent` ([index.ts:263-342](src/index.ts#L263-L342)) to resolve sender identity (via A) and compute privilege-based tool list before calling `runContainerAgent`. Modify the agent-runner to read `allowedTools` from `ContainerInput.allowedToolPatterns` instead of the hardcoded array at [agent-runner index.ts:402-412](container/agent-runner/src/index.ts#L402-L412). Modify `buildVolumeMounts` ([container-runner.ts:61-226](src/container-runner.ts#L61-L226)) to conditionally mount sensitive directories (e.g., workforce data) only when `privilegeLevel === 'owner'`. | **A** |
| **J: Audience-Adaptive Personality** | Extend `src/personality.ts` (from B) to accept sender identity and select voice accordingly: owner gets informal peer voice, colleagues get professional voice, external gets formal-with-AI-disclosure voice. This implements FR-ID-03 ("adapt communication voice to context" — [REQUIREMENTS.md:29](digital-twin/REQUIREMENTS.md#L29)). The personality prompt passed to the container changes based on who triggered the message. | **A**, **B** |

**Why this order:** C cannot be built without A's identity resolver — the privilege level computation requires knowing who the sender is. J cannot be built without both A (who is talking) and B (base personality to adapt). C and J are independent of each other and can proceed in parallel within this iteration.

---

#### Iteration 2 — Tool & Memory Infrastructure (depends on Iteration 1)

Build the dynamic tool registry and structured memory system that later domain tools will plug into.

| Extension | Description | Depends On |
|:----------|:-----------|:-----------|
| **D: Dynamic Tool Registry** | New `src/tool-registry.ts` defining tool metadata: name, privilege requirement (`owner-only`, `colleague`, `all`), MCP server name, description. On each invocation, `runAgent` ([index.ts:263-342](src/index.ts#L263-L342)) queries the registry with the sender's privilege level (from C) and produces the `allowedToolPatterns` list. Inside the container, the agent-runner selectively starts MCP servers based on the tool list — currently it unconditionally starts `nanoclaw` and `gmail` MCP servers ([agent-runner index.ts:417-431](container/agent-runner/src/index.ts#L417-L431)); with D, it only starts servers whose tools are in the allowed list. | **C** |
| **E: Structured Memory** | Extend the container mount system to include per-person memory directories alongside per-group memory. Currently, each group has `groups/{name}/CLAUDE.md` ([container-runner.ts:99-104](src/container-runner.ts#L99-L104)); add `groups/{name}/persons/{person-id}/` mounted into the container when that person is the sender (requires C's identity in `ContainerInput`). Add memory MCP tools (`save_memory`, `recall_memory`, `search_memories`) following the existing IPC MCP pattern ([ipc-mcp-stdio.ts](container/agent-runner/src/ipc-mcp-stdio.ts)) — these write categorized memories (notes, decisions, tasks, references per FR-MEM-03) to the person's directory. | **C** |

**Why this order:** D needs C's `allowedToolPatterns` plumbing to deliver filtered tools to the container. E needs C's sender identity in `ContainerInput` to mount the right person's memory directory. D and E are independent of each other.

---

#### Iteration 3 — Domain Tools (depends on Iteration 2)

Build the twin-specific MCP tools for knowledge base and workforce analytics.

| Extension | Description | Depends On |
|:----------|:-----------|:-----------|
| **F: Knowledge Base MCP Tools** | New MCP server at `container/mcp-servers/knowledge-base/` implementing FR-KB-01 through FR-KB-07. Follows the established pattern: MCP server registered in agent-runner's `mcpServers` config ([agent-runner index.ts:417-431](container/agent-runner/src/index.ts#L417-L431)), data mounted via `additionalMounts` ([container-runner.ts:216-223](src/container-runner.ts#L216-L223)). The tool registry (D) annotates KB tools as `owner-only` or `colleague` depending on content sensitivity, ensuring the dynamic tool list gates access correctly. Tools: `query_knowledge_base`, `get_commitments`, `get_project_health`, `search_decisions`, `browse_knowledge_base`. | **D** |
| **I: Workforce Analytics MCP Tools** | New MCP server at `container/mcp-servers/workforce/` implementing FR-WF-01 through FR-WF-05. Annotated as `owner-only` in the tool registry (D), ensuring it's never available to colleagues (FR-WF-03). The MCP server internally validates queries against PII rules (FR-WF-02) — even if a privilege escalation somehow delivered the tool to a non-owner, the server itself rejects unauthorized queries. Mounted conditionally: `buildVolumeMounts` only mounts workforce data when `privilegeLevel === 'owner'` (from C's container-level scoping). | **D**, **C** (for mount-level gating) |

**Why this order:** Both F and I need D's privilege-filtered tool loading. I additionally needs C's mount-level scoping to prevent workforce data from even being visible in the container filesystem for non-owners. F and I can proceed in parallel.

---

#### Iteration 4 — Configuration & Feedback (depends on Iterations 0, 2)

Build the twin configuration system and feedback collection. These enable the management API in the next iteration.

| Extension | Description | Depends On |
|:----------|:-----------|:-----------|
| **G: Twin Configuration System** | New `src/twin-config.ts` loading per-twin YAML configs from `config/twins/{twin-name}.yaml`. Each config specifies: personality file path (consumed by B/J), enabled capabilities (consumed by D), channel bindings, trigger patterns, schedule defaults. Replaces the global singleton `ASSISTANT_NAME` ([config.ts:11-12](src/config.ts#L11-L12)) and `TRIGGER_PATTERN` ([config.ts:65-68](src/config.ts#L65-L68)) with per-group twin config looked up from `registeredGroups` ([index.ts:64](src/index.ts#L64)). Adds `twin_config` column to `registered_groups` table ([db.ts:76-84](src/db.ts#L76-L84)). This is the foundation for NFR-CFG-01 ("each capability independently enabled/disabled without code changes" — [REQUIREMENTS.md:128](digital-twin/REQUIREMENTS.md#L128)). | **B** (personality config is the first thing twins configure) |
| **M: Feedback Collection** | New `src/feedback.ts` with two collection paths: (1) channel-native — channel adapters emit feedback events from platform signals (e.g., Slack emoji reactions, Telegram reactions). Each feedback event references a trace ID from H, correlating the reaction to the agent invocation that produced the response. (2) Agent-initiated — the agent asks for feedback after completing tasks; responses flow through the existing IPC message path ([ipc.ts:66-108](src/ipc.ts#L66-L108)) and are stored as feedback entries. Feedback stored in a new `feedback` SQLite table. | **H** (trace IDs for correlation) |
| **K: Provider Abstraction** | Replace the Claude SDK dependency inside the container with a provider-agnostic agent runner. This is the largest single change: replace `import { query } from '@anthropic-ai/claude-agent-sdk'` at [agent-runner index.ts:19](container/agent-runner/src/index.ts#L19) with a provider abstraction that supports Claude (via SDK), Gemini (via LangChain), and others. Extend the credential proxy ([credential-proxy.ts:26-119](src/credential-proxy.ts#L26-L119)) to route to multiple upstream APIs based on a provider selector in `ContainerInput`. The host-side orchestration ([index.ts](src/index.ts), [container-runner.ts](src/container-runner.ts), [group-queue.ts](src/group-queue.ts)) remains unchanged — it is provider-agnostic by design (it spawns containers and reads IPC output; it doesn't care what runs inside). | None (independent track, but large scope) |

**Why this order:** G needs B's personality config schema as its first configuration surface. M needs H's trace IDs to make feedback meaningful. K is independent but placed here because it's large and can run as a parallel workstream alongside G and M.

---

#### Iteration 5 — Management API (depends on Iteration 4)

The capstone: expose everything to the agent manager.

| Extension | Description | Depends On |
|:----------|:-----------|:-----------|
| **L: Agent Management API** | New `src/management-api.ts` — an HTTP server (or CLI tool) exposing: (1) trace queries from H's `traces` table, (2) twin config CRUD from G's twin config system, (3) feedback dashboard from M's feedback table, (4) live twin status from the `GroupQueue` ([group-queue.ts:30-365](src/group-queue.ts#L30-L365)). This is the control plane for the agent manager actor defined in the Eidos brainstorm ([brainstorm:57-69](digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md#L57-L69)): "execution traces, usage analytics, feedback collection, control plane." | **G**, **H**, **M** |

---

### 7.5 Critical Path

The longest dependency chain determines the minimum number of sequential iterations:

```
A → C → D → F (or I)
```

This is a **4-iteration critical path** (Iterations 0–3) from identity resolution to working domain tools with access control. All other extensions either run in parallel with this chain or come after it.

The **secondary critical path** for the management API is:

```
H → M → L  (3 iterations: 0, 4, 5)
B → G → L  (3 iterations: 0, 4, 5)
```

Both paths converge at L in Iteration 5. Since H and B are both in Iteration 0, and M and G are both in Iteration 4, these paths don't extend the overall timeline beyond what the primary critical path already requires.

**Provider abstraction (K)** is deliberately off the critical path. It's the highest-effort single extension but has no downstream dependents within the digital twin feature set — other extensions work with Claude. K can be deferred until after the twin is functional with Claude, then swapped in as a container-interior replacement without touching host-side code.

### 7.6 Minimum Viable Digital Twin

If time is constrained, a **minimum viable digital twin** can be achieved with Iterations 0–2 (extensions A, B, C, D, E, H, J):

- **A + C** → per-sender access control (NFR-PRIV-01 satisfied)
- **B + J** → structured, audience-adaptive personality (FR-ID-01–05 satisfied)
- **D** → privilege-gated tools (NFR-PRIV-02 satisfied)
- **E** → per-person memory (FR-MEM-01–03 partially satisfied)
- **H** → basic trace capture (NFR-OBS-01–03 partially satisfied)

This covers all **critical/high** gaps except provider abstraction (K) and domain-specific tools (F, I). Domain tools (Iteration 3) can be added incrementally without architectural changes — they plug into the registry D established in Iteration 2.

---

## Sources

All references are to files within the nanoclaw repository or the digital-twin subdirectory:

- NanoClaw source: [src/](src/), [container/](container/)
- NanoClaw docs: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md), [docs/SPEC.md](docs/SPEC.md), [docs/SECURITY.md](docs/SECURITY.md)
- Digital twin PRD: [digital-twin/REQUIREMENTS.md](digital-twin/REQUIREMENTS.md)
- Eidos brainstorm: [digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md](digital-twin/docs/brainstorms/2026-03-12-harness-architecture-brainstorm.md)
- Agent harness research: [digital-twin/docs/research/2026-03-12-agent-harness-best-practices.md](digital-twin/docs/research/2026-03-12-agent-harness-best-practices.md)
