import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _getDb, _initTestDatabaseAtVersion } from '../db.js';
import { runMigrations } from '../migrations.js';
import { migration } from './001-identity-store.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  _initTestDatabaseAtVersion(0); // Base schema only, before migration 001
  db = _getDb();

  // Create temp dir for allowlist
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedOwnerData() {
  // Register a main group
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
     VALUES ('group@g.us', 'Main', 'main', '@Bot', '2024-01-01T00:00:00.000Z', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO chats (jid, name, last_message_time) VALUES ('group@g.us', 'Main', '2024-01-01T00:00:00.000Z')`,
  ).run();
  // Owner's message
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
     VALUES ('m1', 'group@g.us', '111@s.whatsapp.net', 'Carlos', 'hello', '2024-01-01T00:00:01.000Z', 1)`,
  ).run();
}

function writeAllowlist(senderIds: string[]) {
  const allowlist = {
    default: { allow: senderIds, mode: 'trigger' },
    chats: {},
    logDenied: true,
  };
  const allowlistPath = path.join(tmpDir, 'sender-allowlist.json');
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));
  process.env.SENDER_ALLOWLIST_PATH = allowlistPath;
}

function seedColleagueMessages() {
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
     VALUES ('m2', 'group@g.us', '222@s.whatsapp.net', 'Alice', 'hi', '2024-01-01T00:00:02.000Z', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
     VALUES ('m3', 'group@g.us', 'slack:U333', 'Bob', 'hey', '2024-01-01T00:00:03.000Z', 0)`,
  ).run();
}

describe('migration 001: identity-store', () => {
  it('creates known_persons and sender_mappings tables', () => {
    runMigrations(db, [migration]);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('known_persons', 'sender_mappings') ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual([
      'known_persons',
      'sender_mappings',
    ]);
  });

  it('seeds owner from main group messages', () => {
    seedOwnerData();
    runMigrations(db, [migration]);

    const persons = db.prepare('SELECT * FROM known_persons').all() as Array<{
      id: string;
      display_name: string;
      privilege: string;
    }>;

    expect(persons).toHaveLength(1);
    expect(persons[0].display_name).toBe('Carlos');
    expect(persons[0].privilege).toBe('owner');

    const mappings = db
      .prepare('SELECT * FROM sender_mappings')
      .all() as Array<{
      sender_id: string;
      person_id: string;
      channel: string;
    }>;

    expect(mappings).toHaveLength(1);
    expect(mappings[0].sender_id).toBe('111@s.whatsapp.net');
    expect(mappings[0].channel).toBe('whatsapp');
  });

  it('seeds colleagues from allowlist', () => {
    seedOwnerData();
    seedColleagueMessages();
    writeAllowlist(['222@s.whatsapp.net', 'slack:U333']);

    runMigrations(db, [migration]);

    const persons = db
      .prepare('SELECT * FROM known_persons ORDER BY display_name')
      .all() as Array<{ id: string; display_name: string; privilege: string }>;

    // Owner + 2 colleagues
    expect(persons).toHaveLength(3);
    expect(persons.find((p) => p.display_name === 'Alice')?.privilege).toBe(
      'colleague',
    );
    expect(persons.find((p) => p.display_name === 'Bob')?.privilege).toBe(
      'colleague',
    );
    expect(persons.find((p) => p.display_name === 'Carlos')?.privilege).toBe(
      'owner',
    );
  });

  it('skips owner in allowlist (does not duplicate)', () => {
    seedOwnerData();
    // Owner's sender ID is in the allowlist too
    writeAllowlist(['111@s.whatsapp.net', '222@s.whatsapp.net']);
    seedColleagueMessages();

    runMigrations(db, [migration]);

    const persons = db
      .prepare("SELECT * FROM known_persons WHERE privilege = 'owner'")
      .all();
    expect(persons).toHaveLength(1);
  });

  it('handles missing allowlist gracefully', () => {
    seedOwnerData();
    process.env.SENDER_ALLOWLIST_PATH = path.join(tmpDir, 'nonexistent.json');

    expect(() => runMigrations(db, [migration])).not.toThrow();

    const persons = db.prepare('SELECT * FROM known_persons').all();
    expect(persons).toHaveLength(1); // Only owner
  });

  it('handles empty messages table', () => {
    expect(() => runMigrations(db, [migration])).not.toThrow();

    const persons = db.prepare('SELECT * FROM known_persons').all();
    expect(persons).toHaveLength(0);
  });

  it('detects channel from sender ID format', () => {
    seedOwnerData();
    seedColleagueMessages();
    writeAllowlist(['222@s.whatsapp.net', 'slack:U333']);

    runMigrations(db, [migration]);

    const mappings = db
      .prepare(
        'SELECT sender_id, channel FROM sender_mappings ORDER BY sender_id',
      )
      .all() as Array<{ sender_id: string; channel: string | null }>;

    const waMapping = mappings.find((m) =>
      m.sender_id.includes('@s.whatsapp.net'),
    );
    const slackMapping = mappings.find((m) => m.sender_id.startsWith('slack:'));

    expect(waMapping?.channel).toBe('whatsapp');
    expect(slackMapping?.channel).toBe('slack');
  });

  it('is idempotent via migration version tracking', () => {
    seedOwnerData();
    runMigrations(db, [migration]);

    // Running again should be a no-op (version already applied)
    runMigrations(db, [migration]);

    const persons = db.prepare('SELECT * FROM known_persons').all();
    expect(persons).toHaveLength(1); // Still just the owner
  });
});
