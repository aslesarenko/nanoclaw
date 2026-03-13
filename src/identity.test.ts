import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  addKnownPerson,
  addSenderMapping,
  detectChannel,
  getAllKnownPersons,
  getKnownPerson,
  getKnownPersonBySender,
  getSenderMappings,
  removeKnownPerson,
  removeSenderMapping,
  resolveIdentity,
  slugify,
  updateKnownPerson,
} from './identity.js';
import { PersonIdentity } from './types.js';

const NOW = '2024-06-01T00:00:00.000Z';

function makePerson(overrides: Partial<PersonIdentity> = {}): PersonIdentity {
  return {
    id: 'person-1',
    displayName: 'Alice Smith',
    privilege: 'colleague',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
});

// --- addKnownPerson + getKnownPerson ---

describe('addKnownPerson + getKnownPerson', () => {
  it('creates and retrieves a person', () => {
    const person = makePerson();
    addKnownPerson(person);
    const result = getKnownPerson('person-1');
    expect(result).toEqual(person);
  });

  it('stores optional notes', () => {
    const person = makePerson({ notes: 'Works in engineering' });
    addKnownPerson(person);
    const result = getKnownPerson('person-1');
    expect(result?.notes).toBe('Works in engineering');
  });

  it('returns null for unknown person', () => {
    expect(getKnownPerson('nonexistent')).toBeNull();
  });

  it('rejects invalid privilege level', () => {
    const person = makePerson({ privilege: 'admin' as never });
    expect(() => addKnownPerson(person)).toThrow('Invalid privilege level');
  });
});

// --- addSenderMapping + resolveIdentity ---

describe('addSenderMapping + resolveIdentity', () => {
  it('resolves a sender to a person', () => {
    addKnownPerson(makePerson());
    addSenderMapping('123@s.whatsapp.net', 'person-1', 'whatsapp');

    const result = resolveIdentity('123@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.person.id).toBe('person-1');
    expect(result!.person.displayName).toBe('Alice Smith');
    expect(result!.senderId).toBe('123@s.whatsapp.net');
  });

  it('returns null for unmapped sender', () => {
    expect(resolveIdentity('unknown@s.whatsapp.net')).toBeNull();
  });

  it('maps multiple senders to one person', () => {
    addKnownPerson(makePerson());
    addSenderMapping('123@s.whatsapp.net', 'person-1', 'whatsapp');
    addSenderMapping('slack:U12345', 'person-1', 'slack');

    const fromWhatsApp = resolveIdentity('123@s.whatsapp.net');
    const fromSlack = resolveIdentity('slack:U12345');

    expect(fromWhatsApp!.person.id).toBe('person-1');
    expect(fromSlack!.person.id).toBe('person-1');
  });

  it('re-maps a sender to a different person (upsert)', () => {
    addKnownPerson(makePerson({ id: 'person-1' }));
    addKnownPerson(makePerson({ id: 'person-2', displayName: 'Bob Jones' }));
    addSenderMapping('123@s.whatsapp.net', 'person-1');
    addSenderMapping('123@s.whatsapp.net', 'person-2');

    const result = resolveIdentity('123@s.whatsapp.net');
    expect(result!.person.id).toBe('person-2');
  });
});

// --- getKnownPersonBySender ---

describe('getKnownPersonBySender', () => {
  it('returns person for mapped sender', () => {
    addKnownPerson(makePerson());
    addSenderMapping('123@s.whatsapp.net', 'person-1');
    const person = getKnownPersonBySender('123@s.whatsapp.net');
    expect(person?.id).toBe('person-1');
  });

  it('returns null for unmapped sender', () => {
    expect(getKnownPersonBySender('unknown')).toBeNull();
  });
});

// --- getAllKnownPersons ---

describe('getAllKnownPersons', () => {
  it('returns empty array when no persons exist', () => {
    expect(getAllKnownPersons()).toEqual([]);
  });

  it('returns all persons ordered by displayName', () => {
    addKnownPerson(makePerson({ id: 'charlie', displayName: 'Charlie' }));
    addKnownPerson(makePerson({ id: 'alice', displayName: 'Alice' }));
    addKnownPerson(makePerson({ id: 'bob', displayName: 'Bob' }));

    const persons = getAllKnownPersons();
    expect(persons.map((p) => p.displayName)).toEqual([
      'Alice',
      'Bob',
      'Charlie',
    ]);
  });
});

// --- updateKnownPerson ---

describe('updateKnownPerson', () => {
  it('updates displayName', () => {
    addKnownPerson(makePerson());
    updateKnownPerson('person-1', { displayName: 'Alice Johnson' });
    const result = getKnownPerson('person-1');
    expect(result?.displayName).toBe('Alice Johnson');
  });

  it('updates privilege level', () => {
    addKnownPerson(makePerson());
    updateKnownPerson('person-1', { privilege: 'owner' });
    expect(getKnownPerson('person-1')?.privilege).toBe('owner');
  });

  it('updates notes', () => {
    addKnownPerson(makePerson());
    updateKnownPerson('person-1', { notes: 'New note' });
    expect(getKnownPerson('person-1')?.notes).toBe('New note');
  });

  it('no-op when no fields provided', () => {
    addKnownPerson(makePerson());
    updateKnownPerson('person-1', {});
    const result = getKnownPerson('person-1');
    expect(result?.displayName).toBe('Alice Smith');
  });

  it('rejects invalid privilege level', () => {
    addKnownPerson(makePerson());
    expect(() =>
      updateKnownPerson('person-1', { privilege: 'superadmin' as never }),
    ).toThrow('Invalid privilege level');
  });
});

// --- removeKnownPerson ---

describe('removeKnownPerson', () => {
  it('removes person and associated sender mappings', () => {
    addKnownPerson(makePerson());
    addSenderMapping('123@s.whatsapp.net', 'person-1');
    addSenderMapping('slack:U12345', 'person-1');

    removeKnownPerson('person-1');

    expect(getKnownPerson('person-1')).toBeNull();
    expect(resolveIdentity('123@s.whatsapp.net')).toBeNull();
    expect(resolveIdentity('slack:U12345')).toBeNull();
  });

  it('no-op for nonexistent person', () => {
    expect(() => removeKnownPerson('nonexistent')).not.toThrow();
  });
});

// --- removeSenderMapping ---

describe('removeSenderMapping', () => {
  it('removes a sender mapping without affecting the person', () => {
    addKnownPerson(makePerson());
    addSenderMapping('123@s.whatsapp.net', 'person-1');
    addSenderMapping('slack:U12345', 'person-1');

    removeSenderMapping('123@s.whatsapp.net');

    expect(resolveIdentity('123@s.whatsapp.net')).toBeNull();
    expect(getKnownPerson('person-1')).not.toBeNull();
    expect(resolveIdentity('slack:U12345')).not.toBeNull();
  });

  it('no-op for nonexistent mapping', () => {
    expect(() => removeSenderMapping('nonexistent')).not.toThrow();
  });
});

// --- getSenderMappings ---

describe('getSenderMappings', () => {
  it('returns all sender mappings for a person', () => {
    addKnownPerson(makePerson());
    addSenderMapping('123@s.whatsapp.net', 'person-1', 'whatsapp');
    addSenderMapping('slack:U12345', 'person-1', 'slack');

    const mappings = getSenderMappings('person-1');
    expect(mappings).toHaveLength(2);
    expect(mappings.map((m) => m.senderId).sort()).toEqual([
      '123@s.whatsapp.net',
      'slack:U12345',
    ]);
  });

  it('returns empty array for person with no mappings', () => {
    addKnownPerson(makePerson());
    expect(getSenderMappings('person-1')).toEqual([]);
  });
});

// --- cross-channel identity ---

describe('cross-channel identity', () => {
  it('same person resolves from WhatsApp and Slack sender IDs', () => {
    addKnownPerson(makePerson({ privilege: 'owner' }));
    addSenderMapping('123@s.whatsapp.net', 'person-1', 'whatsapp');
    addSenderMapping('slack:U12345', 'person-1', 'slack');

    const fromWA = resolveIdentity('123@s.whatsapp.net');
    const fromSlack = resolveIdentity('slack:U12345');

    expect(fromWA!.person.id).toBe(fromSlack!.person.id);
    expect(fromWA!.person.privilege).toBe('owner');
    expect(fromSlack!.person.privilege).toBe('owner');
  });
});

// --- privilege levels ---

describe('privilege levels', () => {
  it('accepts owner privilege', () => {
    addKnownPerson(makePerson({ id: 'p-owner', privilege: 'owner' }));
    expect(getKnownPerson('p-owner')?.privilege).toBe('owner');
  });

  it('accepts colleague privilege', () => {
    addKnownPerson(makePerson({ id: 'p-col', privilege: 'colleague' }));
    expect(getKnownPerson('p-col')?.privilege).toBe('colleague');
  });

  it('accepts external privilege', () => {
    addKnownPerson(makePerson({ id: 'p-ext', privilege: 'external' }));
    expect(getKnownPerson('p-ext')?.privilege).toBe('external');
  });
});

// --- detectChannel ---

describe('detectChannel', () => {
  it('detects whatsapp from @s.whatsapp.net', () => {
    expect(detectChannel('123@s.whatsapp.net')).toBe('whatsapp');
  });

  it('detects whatsapp from @g.us', () => {
    expect(detectChannel('123-456@g.us')).toBe('whatsapp');
  });

  it('detects telegram from tg: prefix', () => {
    expect(detectChannel('tg:99001')).toBe('telegram');
  });

  it('detects slack from slack: prefix', () => {
    expect(detectChannel('slack:U12345')).toBe('slack');
  });

  it('detects discord from dc: prefix', () => {
    expect(detectChannel('dc:123456')).toBe('discord');
  });

  it('detects gmail from gmail: prefix', () => {
    expect(detectChannel('gmail:thread-123')).toBe('gmail');
  });

  it('returns null for unknown format', () => {
    expect(detectChannel('random-id')).toBeNull();
  });
});

// --- slugify ---

describe('slugify', () => {
  it('converts name to slug', () => {
    expect(slugify('Alice Smith')).toBe('alice-smith');
  });

  it('handles special characters', () => {
    expect(slugify("José María O'Brien")).toBe('jos-mar-a-o-brien');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('  Alice  ')).toBe('alice');
  });
});
