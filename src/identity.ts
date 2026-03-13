/**
 * Identity Store for NanoClaw.
 *
 * Maps platform-specific sender IDs to canonical person identities
 * with privilege levels (owner / colleague / external).
 */
import { _getDb } from './db.js';
import {
  PersonIdentity,
  PrivilegeLevel,
  ResolvedIdentity,
  SenderMapping,
} from './types.js';

// --- Read operations ---

export function resolveIdentity(sender: string): ResolvedIdentity | null {
  const db = _getDb();
  const row = db
    .prepare(
      `
    SELECT sm.sender_id,
           kp.id, kp.display_name, kp.privilege, kp.notes,
           kp.created_at, kp.updated_at
    FROM sender_mappings sm
    JOIN known_persons kp ON sm.person_id = kp.id
    WHERE sm.sender_id = ?
  `,
    )
    .get(sender) as
    | {
        sender_id: string;
        id: string;
        display_name: string;
        privilege: PrivilegeLevel;
        notes: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;

  return {
    person: toPersonIdentity(row),
    senderId: row.sender_id,
  };
}

export function getKnownPerson(personId: string): PersonIdentity | null {
  const db = _getDb();
  const row = db
    .prepare('SELECT * FROM known_persons WHERE id = ?')
    .get(personId) as PersonRow | undefined;

  if (!row) return null;
  return toPersonIdentity(row);
}

export function getKnownPersonBySender(sender: string): PersonIdentity | null {
  const resolved = resolveIdentity(sender);
  return resolved?.person ?? null;
}

export function getAllKnownPersons(): PersonIdentity[] {
  const db = _getDb();
  const rows = db
    .prepare('SELECT * FROM known_persons ORDER BY display_name')
    .all() as PersonRow[];
  return rows.map(toPersonIdentity);
}

export function getSenderMappings(personId: string): SenderMapping[] {
  const db = _getDb();
  const rows = db
    .prepare('SELECT * FROM sender_mappings WHERE person_id = ?')
    .all(personId) as Array<{
    sender_id: string;
    person_id: string;
    channel: string | null;
    added_at: string;
  }>;
  return rows.map((r) => ({
    senderId: r.sender_id,
    personId: r.person_id,
    channel: r.channel ?? undefined,
    addedAt: r.added_at,
  }));
}

// --- Write operations ---

export function addKnownPerson(person: PersonIdentity): void {
  validatePrivilege(person.privilege);
  const db = _getDb();
  db.prepare(
    `
    INSERT INTO known_persons (id, display_name, privilege, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    person.id,
    person.displayName,
    person.privilege,
    person.notes ?? null,
    person.createdAt,
    person.updatedAt,
  );
}

export function addSenderMapping(
  senderId: string,
  personId: string,
  channel?: string,
): void {
  const db = _getDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO sender_mappings (sender_id, person_id, channel, added_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(senderId, personId, channel ?? null, now);
}

export function updateKnownPerson(
  personId: string,
  updates: Partial<Pick<PersonIdentity, 'displayName' | 'privilege' | 'notes'>>,
): void {
  if (updates.privilege) validatePrivilege(updates.privilege);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.displayName !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.displayName);
  }
  if (updates.privilege !== undefined) {
    fields.push('privilege = ?');
    values.push(updates.privilege);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(personId);

  const db = _getDb();
  db.prepare(`UPDATE known_persons SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function removeKnownPerson(personId: string): void {
  const db = _getDb();
  // Delete sender mappings first (FK constraint)
  db.prepare('DELETE FROM sender_mappings WHERE person_id = ?').run(personId);
  db.prepare('DELETE FROM known_persons WHERE id = ?').run(personId);
}

export function removeSenderMapping(senderId: string): void {
  const db = _getDb();
  db.prepare('DELETE FROM sender_mappings WHERE sender_id = ?').run(senderId);
}

// --- Helpers ---

const VALID_PRIVILEGES: PrivilegeLevel[] = ['owner', 'colleague', 'external'];

function validatePrivilege(level: string): asserts level is PrivilegeLevel {
  if (!VALID_PRIVILEGES.includes(level as PrivilegeLevel)) {
    throw new Error(`Invalid privilege level: ${level}`);
  }
}

interface PersonRow {
  id: string;
  display_name: string;
  privilege: PrivilegeLevel;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function toPersonIdentity(row: PersonRow): PersonIdentity {
  return {
    id: row.id,
    displayName: row.display_name,
    privilege: row.privilege,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Infer channel name from a platform-specific sender ID.
 */
export function detectChannel(senderId: string): string | null {
  if (senderId.endsWith('@s.whatsapp.net') || senderId.endsWith('@g.us')) {
    return 'whatsapp';
  }
  if (senderId.startsWith('tg:')) return 'telegram';
  if (senderId.startsWith('slack:')) return 'slack';
  if (senderId.startsWith('dc:')) return 'discord';
  if (senderId.startsWith('gmail:')) return 'gmail';
  return null;
}

/**
 * Convert a display name to a URL-safe slug for use as a person ID.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
