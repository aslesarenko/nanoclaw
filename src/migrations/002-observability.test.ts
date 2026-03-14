import type Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { _getDb, _initTestDatabaseAtVersion } from '../db.js';
import { runMigrations } from '../migrations.js';
import { migration } from './002-observability.js';

let db: Database.Database;

beforeEach(() => {
  _initTestDatabaseAtVersion(1); // After migration 001, before 002
  db = _getDb();
});

describe('migration 002: observability', () => {
  it('creates the traces table', () => {
    runMigrations(db, [migration]);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'traces'",
      )
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('traces');
  });

  it('creates expected indexes', () => {
    runMigrations(db, [migration]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_traces_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(indexes.map((i) => i.name)).toEqual([
      'idx_traces_created',
      'idx_traces_group',
      'idx_traces_type',
    ]);
  });

  it('is idempotent via version tracking', () => {
    runMigrations(db, [migration]);

    // Running again should be a no-op (version already applied)
    expect(() => runMigrations(db, [migration])).not.toThrow();
  });

  it('traces table has expected columns (round-trip)', () => {
    runMigrations(db, [migration]);

    db.prepare(
      `
      INSERT INTO traces (
        trace_id, type, group_folder, chat_jid, sender, channel,
        status, duration_ms, error, token_count, tool_calls, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'tr-test-001',
      'message',
      'main',
      'group@g.us',
      'alice',
      'whatsapp',
      'success',
      1234,
      null,
      null,
      null,
      '2024-01-01T00:00:00.000Z',
    );

    const row = db
      .prepare('SELECT * FROM traces WHERE trace_id = ?')
      .get('tr-test-001') as Record<string, unknown>;

    expect(row.trace_id).toBe('tr-test-001');
    expect(row.type).toBe('message');
    expect(row.group_folder).toBe('main');
    expect(row.chat_jid).toBe('group@g.us');
    expect(row.sender).toBe('alice');
    expect(row.channel).toBe('whatsapp');
    expect(row.status).toBe('success');
    expect(row.duration_ms).toBe(1234);
    expect(row.error).toBeNull();
    expect(row.token_count).toBeNull();
    expect(row.tool_calls).toBeNull();
    expect(row.created_at).toBe('2024-01-01T00:00:00.000Z');
  });
});
