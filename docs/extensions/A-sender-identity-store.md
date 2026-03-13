# Extension A: Sender Identity Store

**Status:** Iteration 0 complete (schema + API + migration + tests + release skill)
**Branch:** `digital-twin`
**Date:** 2026-03-13

## Goal

Provide a persistent identity layer that maps raw sender IDs (e.g., `65404254`, `tg:123456`) to known persons with display names, privilege levels, and cross-channel identity linking.

## What was implemented

### 1. Identity module (`src/identity.ts`)

Core API for managing persons and sender mappings:

- `upsertPerson(id, displayName, privilege?, notes?)` — create or update a known person
- `getPersonById(id)` — look up a person by ID
- `addSenderMapping(senderId, personId, channel?)` — link a raw sender ID to a person
- `getPersonBySender(senderId)` — resolve a sender ID to their person record
- `getMappingsForPerson(personId)` — list all sender IDs for a person
- `getAllPersons()` — list all known persons
- `removePerson(id)` — cascade-delete a person and all their sender mappings

Privilege levels: `owner`, `trusted`, `external` (default).

### 2. Migration system (`src/migrations.ts`)

Built a versioned, transactional migration framework:

- `schema_migrations` table tracks applied versions
- Each migration runs in a SQLite transaction — atomic apply or full rollback
- `runMigrations(db, migrations)` — applies only pending migrations
- `getCurrentVersion(db)` / `getAppliedMigrations(db)` — introspection helpers

### 3. Migration 001: Identity Store (`src/migrations/001-identity-store.ts`)

Creates the `known_persons` and `sender_mappings` tables with:

- `known_persons`: id, display_name, privilege, notes, created_at, updated_at
- `sender_mappings`: sender_id → person_id with optional channel, foreign key constraint
- Index on `sender_mappings(person_id)` for reverse lookups
- Seed logic: auto-detects owner from `is_from_me` messages, imports from `sender-allowlist.json`

### 4. Migration registry (`src/migrations/index.ts`)

Central `allMigrations` array. New migrations are added here and automatically picked up by both production (`initDatabase()`) and test helpers.

### 5. Database layer changes (`src/db.ts`)

- Removed identity tables from `createSchema()` — migrations own all new tables
- `initDatabase()` now calls `runMigrations(db, allMigrations)` after base schema
- `_initTestDatabase()` — base schema + all migrations (for regular tests)
- `_initTestDatabaseAtVersion(n)` — base schema + migrations up to version n (for migration tests)

### 6. Test infrastructure

| File | Tests | Purpose |
|------|-------|---------|
| `src/identity.test.ts` | 38 | Full CRUD: upsert, get, mapping, cascade delete, privilege levels |
| `src/migrations.test.ts` | 7 | Migration framework: versioning, idempotency, rollback on failure |
| `src/migrations/001-identity-store.test.ts` | 8 | Migration 001: table creation, seeding from messages + allowlist |

Key design decision for migration tests: `_initTestDatabaseAtVersion(0)` creates the pre-migration state (base schema only), so each migration test starts from the correct precondition. This scales for future migrations — test for migration N uses `_initTestDatabaseAtVersion(N-1)`.

### 7. Release skill (`/release`)

Created `.claude/skills/release/` — a 6-step interactive skill:

1. **Build** — `npm run build`, stop on type errors
2. **Test** — `npx vitest run`, stop on failures
3. **Backup** — timestamped copy of `messages.db` + `dist/`, integrity check via `PRAGMA integrity_check`; invalid backups are cleaned up
4. **Restart Host** — launchctl (macOS) / systemctl (Linux); migrations auto-run on startup
5. **Rebuild Container** — `./container/build.sh`; independent of DB (containers use IPC only)
6. **Verify** — service status + log check

Includes full **Restore from Backup** recipe (auto-finds latest valid backup) and step-keyed **Troubleshooting** section.

### 8. Other fixes

- Removed duplicate migration imports/calls from `src/index.ts` (now handled by `db.ts`)
- Fixed pre-existing `deep-research` skill test (stale `git clone` assertion)
- Added `.claude/skills/**/tests/*.test.ts` to `vitest.config.ts` include pattern

## Architecture decisions

1. **Migrations own new tables** — `createSchema()` only has version-0 tables. All new tables come from migrations. This ensures migration tests can start from the correct pre-migration state.

2. **Test helpers scale by version** — `_initTestDatabaseAtVersion(N)` pattern means each migration test is isolated and future migrations don't break existing tests.

3. **Production migrations are automatic** — `initDatabase()` runs all migrations on every startup. No manual migration step needed.

4. **Containers are migration-agnostic** — they never touch SQLite directly (IPC only), so host migrations and container rebuilds are independent.

## File inventory

| File | Status |
|------|--------|
| `src/identity.ts` | New |
| `src/identity.test.ts` | New |
| `src/migrations.ts` | New |
| `src/migrations.test.ts` | New |
| `src/migrations/index.ts` | New |
| `src/migrations/001-identity-store.ts` | New |
| `src/migrations/001-identity-store.test.ts` | New |
| `src/db.ts` | Modified (removed identity tables from createSchema, added migration calls, added test helpers) |
| `src/index.ts` | Modified (removed duplicate migration imports/calls) |
| `src/types.ts` | Modified (added KnownPerson, SenderMapping types) |
| `vitest.config.ts` | Modified (added skill test pattern) |
| `.claude/skills/release/SKILL.md` | New |
| `.claude/skills/release/tests/release.test.ts` | New |
| `.claude/skills/deep-research/tests/deep-research.test.ts` | Modified (fixed stale assertion) |
