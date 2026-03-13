/**
 * Versioned migration subsystem for NanoClaw.
 *
 * Each migration has a sequential version number, a human-readable name,
 * and an up() function that receives the database handle. Migrations run
 * inside a transaction together with their schema_migrations record, so
 * the schema change and the version bump are atomic.
 */
import type Database from 'better-sqlite3';

import { logger } from './logger.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/**
 * Run all pending migrations against the database.
 *
 * - Creates the schema_migrations table if it doesn't exist.
 * - Skips migrations whose version is <= the current max applied version.
 * - Each migration + its version record runs in a single transaction.
 * - On failure: rolls back the failing migration, logs the error, and throws.
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
): void {
  // Ensure tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const currentVersion = getCurrentVersion(db);

  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > currentVersion);

  if (pending.length === 0) return;

  for (const migration of pending) {
    const runInTransaction = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
    });

    try {
      runInTransaction();
      logger.info(
        { version: migration.version, name: migration.name },
        'Migration applied',
      );
    } catch (err) {
      logger.error(
        { version: migration.version, name: migration.name, err },
        'Migration failed',
      );
      throw err;
    }
  }
}

/**
 * Return the highest applied migration version, or 0 if none.
 */
export function getCurrentVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) as v FROM schema_migrations')
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * Return all applied migrations, ordered by version.
 */
export function getAppliedMigrations(
  db: Database.Database,
): Array<{ version: number; name: string; applied_at: string }> {
  return db
    .prepare(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
    )
    .all() as Array<{ version: number; name: string; applied_at: string }>;
}
