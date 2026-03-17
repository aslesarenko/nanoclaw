/**
 * Tests for migration 003: privilege fields on scheduled_tasks.
 *
 * Validates that the migration adds creator_sender and creator_privilege
 * columns, preserves defaults for existing rows, and round-trips correctly.
 */
import type Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { _getDb, _initTestDatabaseAtVersion } from '../db.js';
import { runMigrations } from '../migrations.js';
import { migration } from './003-privilege-fields.js';

let db: Database.Database;

beforeEach(() => {
  _initTestDatabaseAtVersion(2); // After migrations 001+002, before 003
  db = _getDb();
});

describe('migration 003: privilege-fields', () => {
  it('adds creator_sender and creator_privilege columns', () => {
    runMigrations(db, [migration]);

    const columns = db
      .prepare('PRAGMA table_info(scheduled_tasks)')
      .all() as Array<{ name: string; dflt_value: string | null }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('creator_sender');
    expect(colNames).toContain('creator_privilege');
  });

  it('creator_privilege defaults to owner', () => {
    runMigrations(db, [migration]);

    const col = (
      db
        .prepare('PRAGMA table_info(scheduled_tasks)')
        .all() as Array<{ name: string; dflt_value: string | null }>
    ).find((c) => c.name === 'creator_privilege');

    expect(col?.dflt_value).toBe("'owner'");
  });

  it('existing tasks retain default owner privilege', () => {
    // Insert a task BEFORE migration (no creator columns yet)
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('task-legacy', 'main', 'group@g.us', 'test', 'once', '0', 'active', '2024-01-01T00:00:00.000Z');

    runMigrations(db, [migration]);

    const row = db
      .prepare('SELECT creator_sender, creator_privilege FROM scheduled_tasks WHERE id = ?')
      .get('task-legacy') as { creator_sender: string | null; creator_privilege: string };

    expect(row.creator_sender).toBeNull();
    expect(row.creator_privilege).toBe('owner');
  });

  it('is idempotent via version tracking', () => {
    runMigrations(db, [migration]);
    expect(() => runMigrations(db, [migration])).not.toThrow();
  });

  it('round-trips task with creator fields', () => {
    runMigrations(db, [migration]);

    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at, creator_sender, creator_privilege)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'task-new',
      'team-chat',
      'group@g.us',
      'daily standup',
      'cron',
      '0 9 * * *',
      'active',
      '2024-06-01T00:00:00.000Z',
      'alice@s.whatsapp.net',
      'colleague',
    );

    const row = db
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get('task-new') as Record<string, unknown>;

    expect(row.id).toBe('task-new');
    expect(row.creator_sender).toBe('alice@s.whatsapp.net');
    expect(row.creator_privilege).toBe('colleague');
  });
});
