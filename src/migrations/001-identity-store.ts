/**
 * Migration 001: Identity Store
 *
 * Creates known_persons and sender_mappings tables, then seeds
 * identity data from existing messages and sender allowlist.
 */
import fs from 'fs';
import type Database from 'better-sqlite3';

import { detectChannel, slugify } from '../identity.js';
import type { Migration } from '../migrations.js';
import type { PrivilegeLevel } from '../types.js';

export const migration: Migration = {
  version: 1,
  name: 'identity-store',
  up(db) {
    // 1. Create tables (IF NOT EXISTS for safety with createSchema())
    db.exec(`
      CREATE TABLE IF NOT EXISTS known_persons (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        privilege TEXT NOT NULL DEFAULT 'external',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sender_mappings (
        sender_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        channel TEXT,
        added_at TEXT NOT NULL,
        FOREIGN KEY (person_id) REFERENCES known_persons(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sender_mappings_person
        ON sender_mappings(person_id);
    `);

    // 2. Seed owner from is_from_me messages in main group
    const ownerRow = db
      .prepare(
        `
      SELECT DISTINCT m.sender, m.sender_name
      FROM messages m
      JOIN registered_groups rg ON m.chat_jid = rg.jid
      WHERE m.is_from_me = 1 AND rg.is_main = 1
      LIMIT 1
    `,
      )
      .get() as { sender: string; sender_name: string } | undefined;

    const now = new Date().toISOString();
    let ownerSenderId: string | undefined;

    if (ownerRow) {
      ownerSenderId = ownerRow.sender;
      const ownerId = slugify(ownerRow.sender_name) || 'owner';
      insertPerson(
        db,
        ownerId,
        ownerRow.sender_name,
        'owner',
        'Auto-seeded from main group messages',
        now,
      );
      insertMapping(
        db,
        ownerRow.sender,
        ownerId,
        detectChannel(ownerRow.sender),
        now,
      );
    }

    // 3. Seed colleagues from sender allowlist
    seedColleaguesFromAllowlist(db, ownerSenderId, now);
  },
};

function insertPerson(
  db: Database.Database,
  id: string,
  displayName: string,
  privilege: PrivilegeLevel,
  notes: string,
  now: string,
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO known_persons (id, display_name, privilege, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(id, displayName, privilege, notes, now, now);
}

function insertMapping(
  db: Database.Database,
  senderId: string,
  personId: string,
  channel: string | null,
  now: string,
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO sender_mappings (sender_id, person_id, channel, added_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(senderId, personId, channel, now);
}

/** The assumed schema of sender-allowlist.json:
 * {
 *   "default": {
 *     "allow": ["senderId1", "senderId2", ...]
 *   },
 *   "chats": {
 *     "chatId1": {
 *       "allow": ["senderId3", "senderId4", ...]
 *     },
 *     ...
 *   }
 * }
 */
function seedColleaguesFromAllowlist(
  db: Database.Database,
  ownerSenderId: string | undefined,
  now: string,
): void {
  // Load allowlist from host config (outside project root)
  const allowlistPath =
    process.env.SENDER_ALLOWLIST_PATH ??
    `${process.env.HOME}/.config/nanoclaw/sender-allowlist.json`;

  let raw: string;
  try {
    raw = fs.readFileSync(allowlistPath, 'utf-8');
  } catch {
    return; // No allowlist file — nothing to seed
  }

  let parsed: {
    default?: { allow?: unknown };
    chats?: Record<string, { allow?: unknown }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // Invalid JSON — skip
  }

  // Collect all explicitly allowed sender IDs (not wildcards)
  const senderIds = new Set<string>();

  const addFromEntry = (allow: unknown) => {
    if (Array.isArray(allow)) {
      for (const id of allow) {
        if (typeof id === 'string') senderIds.add(id);
      }
    }
  };

  addFromEntry(parsed.default?.allow);
  if (parsed.chats) {
    for (const entry of Object.values(parsed.chats)) {
      addFromEntry(entry.allow);
    }
  }

  // For each allowed sender, create a colleague identity
  for (const senderId of senderIds) {
    if (senderId === ownerSenderId) continue; // Skip the owner

    // Look up display name from messages
    const nameRow = db
      .prepare(
        'SELECT sender_name FROM messages WHERE sender = ? ORDER BY timestamp DESC LIMIT 1',
      )
      .get(senderId) as { sender_name: string } | undefined;

    const displayName = nameRow?.sender_name ?? senderId;
    const personId =
      slugify(displayName) || `sender-${slugify(senderId) || 'unknown'}`;

    insertPerson(
      db,
      personId,
      displayName,
      'colleague',
      'Auto-seeded from sender allowlist',
      now,
    );
    insertMapping(db, senderId, personId, detectChannel(senderId), now);
  }
}
