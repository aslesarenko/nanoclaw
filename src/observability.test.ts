import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  endTrace,
  generateTraceId,
  getRecentTraces,
  getTrace,
  getTracesByGroup,
  getTracesByType,
  recordTrace,
  startTrace,
} from './observability.js';
import type { Trace } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

/** Helper to build a minimal valid Trace for testing. */
function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    traceId: overrides.traceId ?? `tr-test-${Date.now()}`,
    type: overrides.type ?? 'message',
    groupFolder: overrides.groupFolder ?? 'main',
    chatJid: overrides.chatJid ?? 'group@g.us',
    sender:
      'sender' in overrides ? (overrides.sender as string | null) : 'alice',
    channel:
      'channel' in overrides
        ? (overrides.channel as string | null)
        : 'whatsapp',
    status: overrides.status ?? 'success',
    durationMs: overrides.durationMs ?? 500,
    error: 'error' in overrides ? (overrides.error as string | null) : null,
    tokenCount:
      'tokenCount' in overrides
        ? (overrides.tokenCount as number | null)
        : null,
    toolCalls:
      'toolCalls' in overrides ? (overrides.toolCalls as number | null) : null,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

describe('generateTraceId', () => {
  it('returns a string starting with tr-', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^tr-/);
  });

  it('generates unique IDs across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTraceId()));
    expect(ids.size).toBe(50);
  });
});

describe('recordTrace + getTrace', () => {
  it('records and retrieves a trace by ID', () => {
    const trace = makeTrace({ traceId: 'tr-round-trip' });
    recordTrace(trace);

    const retrieved = getTrace('tr-round-trip');
    expect(retrieved).toEqual(trace);
  });

  it('returns null for unknown trace ID', () => {
    expect(getTrace('tr-nonexistent')).toBeNull();
  });

  it('stores nullable fields correctly', () => {
    const trace = makeTrace({
      traceId: 'tr-nulls',
      sender: null,
      channel: null,
      error: null,
      tokenCount: null,
      toolCalls: null,
    });
    recordTrace(trace);

    const retrieved = getTrace('tr-nulls');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sender).toBeNull();
    expect(retrieved!.channel).toBeNull();
    expect(retrieved!.error).toBeNull();
    expect(retrieved!.tokenCount).toBeNull();
    expect(retrieved!.toolCalls).toBeNull();
  });
});

describe('getTracesByGroup', () => {
  it('returns traces filtered by group folder', () => {
    recordTrace(makeTrace({ traceId: 'tr-g1', groupFolder: 'alpha' }));
    recordTrace(makeTrace({ traceId: 'tr-g2', groupFolder: 'beta' }));
    recordTrace(makeTrace({ traceId: 'tr-g3', groupFolder: 'alpha' }));

    const results = getTracesByGroup('alpha');
    expect(results).toHaveLength(2);
    expect(results.every((t) => t.groupFolder === 'alpha')).toBe(true);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      recordTrace(
        makeTrace({
          traceId: `tr-lim-${i}`,
          groupFolder: 'main',
          createdAt: `2024-01-01T00:00:0${i}.000Z`,
        }),
      );
    }

    const results = getTracesByGroup('main', 3);
    expect(results).toHaveLength(3);
  });

  it('returns empty array for unknown group', () => {
    expect(getTracesByGroup('nonexistent')).toEqual([]);
  });

  it('returns results in reverse chronological order', () => {
    recordTrace(
      makeTrace({
        traceId: 'tr-old',
        groupFolder: 'main',
        createdAt: '2024-01-01T00:00:00.000Z',
      }),
    );
    recordTrace(
      makeTrace({
        traceId: 'tr-new',
        groupFolder: 'main',
        createdAt: '2024-01-01T00:00:01.000Z',
      }),
    );

    const results = getTracesByGroup('main');
    expect(results[0].traceId).toBe('tr-new');
    expect(results[1].traceId).toBe('tr-old');
  });
});

describe('getTracesByType', () => {
  it('filters by message type', () => {
    recordTrace(makeTrace({ traceId: 'tr-m1', type: 'message' }));
    recordTrace(makeTrace({ traceId: 'tr-t1', type: 'task' }));
    recordTrace(makeTrace({ traceId: 'tr-m2', type: 'message' }));

    const results = getTracesByType('message');
    expect(results).toHaveLength(2);
    expect(results.every((t) => t.type === 'message')).toBe(true);
  });

  it('filters by task type', () => {
    recordTrace(makeTrace({ traceId: 'tr-m1', type: 'message' }));
    recordTrace(makeTrace({ traceId: 'tr-t1', type: 'task' }));

    const results = getTracesByType('task');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('task');
  });
});

describe('getRecentTraces', () => {
  it('returns traces in reverse chronological order', () => {
    for (let i = 0; i < 5; i++) {
      recordTrace(
        makeTrace({
          traceId: `tr-recent-${i}`,
          createdAt: `2024-01-01T00:00:0${i}.000Z`,
        }),
      );
    }

    const results = getRecentTraces();
    expect(results).toHaveLength(5);
    // Newest first
    expect(results[0].traceId).toBe('tr-recent-4');
    expect(results[4].traceId).toBe('tr-recent-0');
  });

  it('respects custom limit', () => {
    for (let i = 0; i < 10; i++) {
      recordTrace(makeTrace({ traceId: `tr-many-${i}` }));
    }

    const results = getRecentTraces(3);
    expect(results).toHaveLength(3);
  });
});

describe('startTrace + endTrace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a complete trace with correct duration', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00.000Z'));
    const ctx = startTrace('message', 'main', 'group@g.us', {
      sender: 'alice',
      channel: 'whatsapp',
    });

    // Advance time by 750ms
    vi.advanceTimersByTime(750);

    const trace = endTrace(ctx, 'success');

    expect(trace.traceId).toMatch(/^tr-/);
    expect(trace.type).toBe('message');
    expect(trace.groupFolder).toBe('main');
    expect(trace.chatJid).toBe('group@g.us');
    expect(trace.sender).toBe('alice');
    expect(trace.channel).toBe('whatsapp');
    expect(trace.status).toBe('success');
    expect(trace.durationMs).toBe(750);
    expect(trace.error).toBeNull();

    // Verify it was persisted
    const retrieved = getTrace(trace.traceId);
    expect(retrieved).toEqual(trace);
  });

  it('records error message when status is error', () => {
    const ctx = startTrace('task', 'workers', 'chat@g.us');
    const trace = endTrace(ctx, 'error', 'Container timed out');

    expect(trace.status).toBe('error');
    expect(trace.error).toBe('Container timed out');
  });

  it('sets tokenCount and toolCalls to null (placeholder)', () => {
    const ctx = startTrace('message', 'main', 'group@g.us');
    const trace = endTrace(ctx, 'success');

    expect(trace.tokenCount).toBeNull();
    expect(trace.toolCalls).toBeNull();
  });

  it('defaults sender and channel to null when not provided', () => {
    const ctx = startTrace('task', 'main', 'group@g.us');
    const trace = endTrace(ctx, 'success');

    expect(trace.sender).toBeNull();
    expect(trace.channel).toBeNull();
  });
});
