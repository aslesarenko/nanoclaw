# Extension B: Personality Engine (Basic)

**Status:** Iteration 0 complete (YAML loader + prompt composer + defaults + tests + integration)
**Branch:** `digital-twin`
**Date:** 2026-03-13

## Goal

Provide a structured personality engine that composes system prompts from a YAML configuration file, satisfying FR-ID-01 (configurable identity), FR-ID-02 (consistent traits), FR-ID-04 (boundaries), and FR-ID-05 (config without code changes). Always returns a valid personality — falls back to a baseline default when no YAML file exists.

## What was implemented

### 1. Personality types (`src/types.ts`)

Added personality configuration interfaces:

- `PersonalityConfig` — top-level config with identity, character, voice, and boundaries
- `PersonalityIdentity` — name, origin story, core values, expertise, hard boundaries
- `PersonalityCharacter` — decision-making style, intellectual temperament, emotional patterns
- `PersonalityVoice` — default tone, vocabulary preferences, communication patterns
- `PersonalityBoundary` — categorized boundary rules

### 2. Personality module (`src/personality.ts`)

Core API for loading and composing personality prompts:

- `DEFAULT_PERSONALITY` — baseline personality using `ASSISTANT_NAME` from config, with core values and honesty/transparency boundaries
- `loadPersonality(pathOverride?)` — reads YAML from `config/personality.yaml`, validates, **always returns a valid config** (falls back to `DEFAULT_PERSONALITY`)
- `composePersonalityPrompt(config)` — pure function that transforms a `PersonalityConfig` into an XML-sectioned system prompt with `<identity>`, `<character>`, `<voice>`, and `<boundaries>` sections
- `getPersonalityPrompt(pathOverride?)` — convenience: load + compose, always returns a prompt string

Design decisions:
- Follows the `sender-allowlist.ts` pattern: file loading with `pathOverride` for testability
- Empty/missing sections are omitted from the composed prompt
- `identity.name` falls back to `ASSISTANT_NAME` when missing from YAML
- Parse errors log a warning and return defaults (no crash)

### 3. Example personality config (`config/personality.yaml`)

Three-layer YAML schema with inline documentation:
- Layer 1: Identity (FR-ID-01) — name, origin story, values, expertise, boundaries
- Layer 2: Character (FR-ID-02) — decision style, temperament, emotional patterns
- Layer 3: Voice (FR-ID-03 placeholder) — tone, vocabulary, communication patterns
- Layer 4: Boundaries (FR-ID-04) — categorized hard rules

### 4. ContainerInput extension (`src/container-runner.ts`, `container/agent-runner/src/index.ts`)

Added `personalityPrompt?: string` field to `ContainerInput` on both host and container sides.

### 5. System prompt composition (`container/agent-runner/src/index.ts`)

Modified the agent-runner to compose the system prompt from both personality and globalClaudeMd:
- Personality prompt comes first (sets persona)
- globalClaudeMd comes second (operational instructions)
- Joined with `\n\n---\n\n` separator
- Both main and non-main groups get personality
- Only non-main groups get globalClaudeMd (preserving existing behavior)

### 6. Orchestrator integration (`src/index.ts`)

The `runAgent` function calls `getPersonalityPrompt()` per invocation and passes the result in `ContainerInput.personalityPrompt`. Per-invocation loading means personality YAML changes take effect without restart.

### 7. Tests

| File | Tests | Purpose |
|------|-------|---------|
| `src/personality.test.ts` | 29 | YAML loading (11), prompt composition (12), default personality (3), convenience function (3) |

Key test scenarios:
- Valid full YAML, minimal YAML, missing file, empty file, malformed YAML
- Default fallback behavior in all error cases
- XML section generation and omission for empty sections
- Boundary rendering with category labels
- `ASSISTANT_NAME` fallback when identity.name missing

## Files modified

- `src/types.ts` — added personality configuration interfaces
- `src/container-runner.ts` — added `personalityPrompt` to `ContainerInput`
- `container/agent-runner/src/index.ts` — added `personalityPrompt` to `ContainerInput`, modified system prompt composition
- `src/index.ts` — import `getPersonalityPrompt`, pass in `runAgent`

## Files created

- `src/personality.ts` — core personality engine module
- `src/personality.test.ts` — 29 tests
- `config/personality.yaml` — example personality definition
- `docs/extensions/B-personality-engine.md` — this document

## What this does NOT include (deferred)

- **Audience-adaptive voice** (Extension J) — personality does not vary by sender
- **Per-sender personality variation** — same personality for all senders
- **Provider abstraction** (Extension K) — still uses Claude SDK
- **Runtime personality switching** — single personality per instance
