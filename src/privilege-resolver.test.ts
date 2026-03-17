/**
 * Tests for two-mode privilege resolution (Extension C).
 *
 * Validates the privilege segmentation algorithm for Mode 1 (mention-based)
 * and the session floor degradation for Mode 2 (every-message) chats.
 * These tests specify the security boundaries that gate tool access.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  getSessionFloorPrivilege,
  minPrivilege,
  persistSessionFloor,
  resolveSessionPrivilege,
  splitMessagesByPrivilege,
} from './privilege-resolver.js';
import { NewMessage, PrivilegeLevel, ResolvedIdentity } from './types.js';

// Mock identity resolution — we control resolved identities via message.resolvedIdentity
vi.mock('./identity.js', () => ({
  resolveIdentity: (sender: string): ResolvedIdentity | null => {
    // Default mock: return null (unmapped → external)
    return null;
  },
}));

// Mock config to control TRIGGER_PATTERN
vi.mock('./config.js', () => ({
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// --- Helpers ---

let msgCounter = 0;

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  msgCounter++;
  return {
    id: `msg-${msgCounter}`,
    chat_jid: 'group@g.us',
    sender: `sender-${msgCounter}@s.whatsapp.net`,
    sender_name: `Sender ${msgCounter}`,
    content: `Hello ${msgCounter}`,
    timestamp: new Date(Date.now() + msgCounter * 1000).toISOString(),
    ...overrides,
  };
}

function makeIdentity(
  privilege: PrivilegeLevel,
  personId = 'person-1',
  displayName = 'Test Person',
): ResolvedIdentity {
  return {
    person: {
      id: personId,
      displayName,
      privilege,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    senderId: 'sender@test',
  };
}

beforeEach(() => {
  msgCounter = 0;
  _initTestDatabase();
});

// --- minPrivilege ---

describe('minPrivilege', () => {
  it('returns owner when only owner given', () => {
    expect(minPrivilege('owner')).toBe('owner');
  });

  it('returns colleague for owner + colleague', () => {
    expect(minPrivilege('owner', 'colleague')).toBe('colleague');
  });

  it('returns external for owner + external', () => {
    expect(minPrivilege('owner', 'external')).toBe('external');
  });

  it('returns external for colleague + external', () => {
    expect(minPrivilege('colleague', 'external')).toBe('external');
  });

  it('returns external for all three', () => {
    expect(minPrivilege('owner', 'colleague', 'external')).toBe('external');
  });

  it('returns external for duplicate externals', () => {
    expect(minPrivilege('external', 'external')).toBe('external');
  });
});

// --- splitMessagesByPrivilege (Mode 1) ---

describe('splitMessagesByPrivilege', () => {
  it('returns empty segments for empty messages', () => {
    const result = splitMessagesByPrivilege([], 'owner');
    expect(result.segments).toEqual([]);
  });

  it('single non-mention message → 1 batch segment at session floor', () => {
    const msg = makeMsg({ content: 'hello' });
    const result = splitMessagesByPrivilege([msg], 'colleague');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].effectivePrivilege).toBe('colleague');
    expect(result.segments[0].isMentionTrigger).toBe(false);
    expect(result.segments[0].messages).toEqual([msg]);
  });

  it('single mention message → 1 segment at sender privilege', () => {
    const msg = makeMsg({
      content: '@Andy do something',
      resolvedIdentity: makeIdentity('owner'),
    });
    const result = splitMessagesByPrivilege([msg], 'external');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].effectivePrivilege).toBe('owner');
    expect(result.segments[0].isMentionTrigger).toBe(true);
    expect(result.segments[0].messages).toEqual([msg]);
  });

  it('non-mentions then mention → 2 segments (batch then mention)', () => {
    const msg1 = makeMsg({ content: 'context message' });
    const msg2 = makeMsg({ content: 'more context' });
    const msg3 = makeMsg({
      content: '@Andy please help',
      resolvedIdentity: makeIdentity('colleague'),
    });

    const result = splitMessagesByPrivilege([msg1, msg2, msg3], 'external');
    expect(result.segments).toHaveLength(2);

    // First segment: batch of non-mentions at session floor
    expect(result.segments[0].effectivePrivilege).toBe('external');
    expect(result.segments[0].isMentionTrigger).toBe(false);
    expect(result.segments[0].messages).toEqual([msg1, msg2]);

    // Second segment: mention at sender's privilege
    expect(result.segments[1].effectivePrivilege).toBe('colleague');
    expect(result.segments[1].isMentionTrigger).toBe(true);
    expect(result.segments[1].messages).toEqual([msg3]);
  });

  it('mention then non-mentions → 2 segments (mention then batch)', () => {
    const mention = makeMsg({
      content: '@Andy search',
      resolvedIdentity: makeIdentity('owner'),
    });
    const msg1 = makeMsg({ content: 'follow up' });
    const msg2 = makeMsg({ content: 'another follow up' });

    const result = splitMessagesByPrivilege([mention, msg1, msg2], 'colleague');
    expect(result.segments).toHaveLength(2);

    expect(result.segments[0].effectivePrivilege).toBe('owner');
    expect(result.segments[0].isMentionTrigger).toBe(true);

    expect(result.segments[1].effectivePrivilege).toBe('colleague');
    expect(result.segments[1].isMentionTrigger).toBe(false);
    expect(result.segments[1].messages).toEqual([msg1, msg2]);
  });

  it('two mentions with non-mentions between → 3 segments', () => {
    const mention1 = makeMsg({
      content: '@Andy first',
      resolvedIdentity: makeIdentity('owner'),
    });
    const context = makeMsg({ content: 'context between' });
    const mention2 = makeMsg({
      content: '@Andy second',
      resolvedIdentity: makeIdentity('colleague'),
    });

    const result = splitMessagesByPrivilege(
      [mention1, context, mention2],
      'external',
    );
    expect(result.segments).toHaveLength(3);

    expect(result.segments[0].effectivePrivilege).toBe('owner');
    expect(result.segments[0].isMentionTrigger).toBe(true);

    expect(result.segments[1].effectivePrivilege).toBe('external');
    expect(result.segments[1].isMentionTrigger).toBe(false);
    expect(result.segments[1].messages).toEqual([context]);

    expect(result.segments[2].effectivePrivilege).toBe('colleague');
    expect(result.segments[2].isMentionTrigger).toBe(true);
  });

  it('consecutive non-mentions batch together into one segment', () => {
    const msgs = [
      makeMsg({ content: 'a' }),
      makeMsg({ content: 'b' }),
      makeMsg({ content: 'c' }),
    ];
    const result = splitMessagesByPrivilege(msgs, 'owner');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].messages).toHaveLength(3);
    expect(result.segments[0].isMentionTrigger).toBe(false);
  });

  it('consecutive mentions are each their own segment', () => {
    const m1 = makeMsg({
      content: '@Andy first',
      resolvedIdentity: makeIdentity('owner'),
    });
    const m2 = makeMsg({
      content: '@Andy second',
      resolvedIdentity: makeIdentity('colleague'),
    });

    const result = splitMessagesByPrivilege([m1, m2], 'external');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].isMentionTrigger).toBe(true);
    expect(result.segments[1].isMentionTrigger).toBe(true);
  });

  it('unmapped sender mention → segment at external', () => {
    // No resolvedIdentity and mock resolveIdentity returns null → external
    const msg = makeMsg({ content: '@Andy help me' });
    const result = splitMessagesByPrivilege([msg], 'owner');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].effectivePrivilege).toBe('external');
  });

  it('is_from_me mention → segment at owner', () => {
    const msg = makeMsg({
      content: '@Andy self-command',
      is_from_me: true,
    });
    const result = splitMessagesByPrivilege([msg], 'external');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].effectivePrivilege).toBe('owner');
  });

  it('uses pre-resolved identity from message.resolvedIdentity', () => {
    const identity = makeIdentity('colleague', 'bob', 'Bob');
    const msg = makeMsg({
      content: '@Andy test',
      resolvedIdentity: identity,
    });
    const result = splitMessagesByPrivilege([msg], 'owner');
    expect(result.segments[0].effectivePrivilege).toBe('colleague');
    expect(result.segments[0].primaryResolvedIdentity).toBe(identity);
  });

  it('sets primarySender from the mention message sender', () => {
    const msg = makeMsg({
      content: '@Andy check',
      sender: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      resolvedIdentity: makeIdentity('owner'),
    });
    const result = splitMessagesByPrivilege([msg], 'owner');
    expect(result.segments[0].primarySender).toBe('alice@s.whatsapp.net');
    expect(result.segments[0].primarySenderName).toBe('Alice');
  });

  it('batch segment primarySender is the last message sender', () => {
    const msg1 = makeMsg({
      content: 'first',
      sender: 'alice@test',
      sender_name: 'Alice',
    });
    const msg2 = makeMsg({
      content: 'second',
      sender: 'bob@test',
      sender_name: 'Bob',
    });
    const result = splitMessagesByPrivilege([msg1, msg2], 'owner');
    expect(result.segments[0].primarySender).toBe('bob@test');
    expect(result.segments[0].primarySenderName).toBe('Bob');
  });
});

// --- resolveSessionPrivilege (Mode 2) ---

describe('resolveSessionPrivilege', () => {
  it('single owner message → privilege owner', () => {
    const msg = makeMsg({
      is_from_me: true,
      resolvedIdentity: makeIdentity('owner'),
    });
    const result = resolveSessionPrivilege([msg], 'test-group');
    expect(result.effectivePrivilege).toBe('owner');
  });

  it('single unmapped message → privilege external', () => {
    // No resolvedIdentity, mock resolveIdentity returns null → external
    const msg = makeMsg();
    const result = resolveSessionPrivilege([msg], 'test-group');
    expect(result.effectivePrivilege).toBe('external');
  });

  it('owner then external in subsequent calls → floor degrades to external', () => {
    const ownerMsg = makeMsg({ is_from_me: true });
    const first = resolveSessionPrivilege([ownerMsg], 'degrade-group');
    persistSessionFloor('degrade-group', first.effectivePrivilege);

    const externalMsg = makeMsg(); // unmapped → external
    const result = resolveSessionPrivilege([externalMsg], 'degrade-group');
    expect(result.effectivePrivilege).toBe('external');
  });

  it('floor persists across calls for same groupFolder', () => {
    const colleagueMsg = makeMsg({
      resolvedIdentity: makeIdentity('colleague'),
    });
    const first = resolveSessionPrivilege([colleagueMsg], 'persist-group');
    persistSessionFloor('persist-group', first.effectivePrivilege);

    // Second call with owner — floor stays at colleague
    const ownerMsg = makeMsg({ is_from_me: true });
    const result = resolveSessionPrivilege([ownerMsg], 'persist-group');
    expect(result.effectivePrivilege).toBe('colleague');
  });

  it('floor does not degrade further from external', () => {
    const ext1 = makeMsg(); // unmapped → external
    const first = resolveSessionPrivilege([ext1], 'ext-group');
    persistSessionFloor('ext-group', first.effectivePrivilege);

    const ext2 = makeMsg(); // another unmapped → external
    const result = resolveSessionPrivilege([ext2], 'ext-group');
    expect(result.effectivePrivilege).toBe('external');
  });

  it('different groups have independent floors', () => {
    const extMsg = makeMsg(); // unmapped → external
    const first = resolveSessionPrivilege([extMsg], 'group-a');
    persistSessionFloor('group-a', first.effectivePrivilege);

    const ownerMsg = makeMsg({ is_from_me: true });
    const result = resolveSessionPrivilege([ownerMsg], 'group-b');
    expect(result.effectivePrivilege).toBe('owner');
  });

  it('returns last sender info', () => {
    const msg1 = makeMsg({
      sender: 'alice@test',
      sender_name: 'Alice',
      is_from_me: true,
    });
    const msg2 = makeMsg({
      sender: 'bob@test',
      sender_name: 'Bob',
      resolvedIdentity: makeIdentity('colleague'),
    });
    const result = resolveSessionPrivilege([msg1, msg2], 'info-group');
    expect(result.lastSender).toBe('bob@test');
    expect(result.lastSenderName).toBe('Bob');
  });

  it('deduplicates senders — same sender only counted once', () => {
    const sender = 'alice@test';
    const msg1 = makeMsg({
      sender,
      resolvedIdentity: makeIdentity('colleague'),
    });
    const msg2 = makeMsg({
      sender,
      content: 'second message',
      resolvedIdentity: makeIdentity('colleague'),
    });
    const result = resolveSessionPrivilege([msg1, msg2], 'dedup-group');
    expect(result.effectivePrivilege).toBe('colleague');
  });
});

// --- getSessionFloorPrivilege ---

describe('getSessionFloorPrivilege', () => {
  it('returns owner for fresh group with owner messages', () => {
    const msg = makeMsg({ is_from_me: true });
    const floor = getSessionFloorPrivilege('fresh-group', [msg]);
    expect(floor).toBe('owner');
  });

  it('degrades floor when external sender appears', () => {
    const ownerMsg = makeMsg({ is_from_me: true });
    const first = getSessionFloorPrivilege('floor-group', [ownerMsg]);
    persistSessionFloor('floor-group', first);

    const extMsg = makeMsg(); // unmapped → external
    const floor = getSessionFloorPrivilege('floor-group', [extMsg]);
    expect(floor).toBe('external');
  });

  it('returns persisted floor across calls', () => {
    const colleagueMsg = makeMsg({
      resolvedIdentity: makeIdentity('colleague'),
    });
    const first = getSessionFloorPrivilege('floor-persist', [colleagueMsg]);
    persistSessionFloor('floor-persist', first);

    // New call with only owner messages — floor stays at colleague
    const ownerMsg = makeMsg({ is_from_me: true });
    const floor = getSessionFloorPrivilege('floor-persist', [ownerMsg]);
    expect(floor).toBe('colleague');
  });
});
