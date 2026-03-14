/**
 * Observability module for NanoClaw.
 *
 * Records structured traces at key lifecycle points (message processing,
 * task execution) for queryable observability. Each trace captures timing,
 * identity, and status metadata per NFR-OBS-01 through NFR-OBS-03.
 *
 * Writes are synchronous — better-sqlite3 single-row inserts are sub-ms,
 * so no async wrapper is needed on the hot path.
 */
import crypto from 'crypto';

import { _getDb } from './db.js';
import { Trace, TraceStatus, TraceType } from './types.js';

/**
 * Internal context object returned by startTrace() and consumed by endTrace().
 * Tracks the start time and metadata needed to finalize the trace record.
 */
export interface TraceContext {
  traceId: string;
  type: TraceType;
  groupFolder: string;
  chatJid: string;
  sender: string | null;
  channel: string | null;
  startTime: number;
}

// Default limit for query functions when no explicit limit is provided.
const DEFAULT_QUERY_LIMIT = 100;

// --- Trace ID generation ---

/**
 * Generate a unique trace ID with a `tr-` prefix for easy identification
 * in logs and database queries. Uses crypto.randomUUID() (Node >=20).
 */
export function generateTraceId(): string {
  return `tr-${crypto.randomUUID()}`;
}

// --- Start / End helpers ---

/**
 * Begin a trace. Returns a TraceContext that the caller passes to endTrace()
 * when the operation completes. This pattern keeps integration code minimal
 * (two lines per callsite) while ensuring duration is always computed correctly.
 */
export function startTrace(
  type: TraceType,
  groupFolder: string,
  chatJid: string,
  opts?: { sender?: string; channel?: string },
): TraceContext {
  return {
    traceId: generateTraceId(),
    type,
    groupFolder,
    chatJid,
    sender: opts?.sender ?? null,
    channel: opts?.channel ?? null,
    startTime: Date.now(),
  };
}

/**
 * Finalize a trace. Computes duration from the context's startTime,
 * builds the Trace record, persists it, and returns it.
 */
export function endTrace(
  ctx: TraceContext,
  status: TraceStatus,
  error?: string,
): Trace {
  const now = Date.now();
  const trace: Trace = {
    traceId: ctx.traceId,
    type: ctx.type,
    groupFolder: ctx.groupFolder,
    chatJid: ctx.chatJid,
    sender: ctx.sender,
    channel: ctx.channel,
    status,
    durationMs: now - ctx.startTime,
    error: error ?? null,
    tokenCount: null, // placeholder — populated by future container instrumentation
    toolCalls: null, // placeholder — populated by future container instrumentation
    createdAt: new Date(now).toISOString(),
  };
  recordTrace(trace);
  return trace;
}

// --- Write ---

/**
 * Persist a trace record to the database. Called internally by endTrace(),
 * but also exported for advanced use cases (e.g., importing traces from
 * external sources or backfilling).
 */
export function recordTrace(trace: Trace): void {
  const db = _getDb();
  db.prepare(
    `
    INSERT INTO traces (
      trace_id, type, group_folder, chat_jid, sender, channel,
      status, duration_ms, error, token_count, tool_calls, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    trace.traceId,
    trace.type,
    trace.groupFolder,
    trace.chatJid,
    trace.sender,
    trace.channel,
    trace.status,
    trace.durationMs,
    trace.error,
    trace.tokenCount,
    trace.toolCalls,
    trace.createdAt,
  );
}

// --- Read ---

/**
 * Retrieve a single trace by its ID. Returns null if not found.
 */
export function getTrace(traceId: string): Trace | null {
  const db = _getDb();
  const row = db
    .prepare('SELECT * FROM traces WHERE trace_id = ?')
    .get(traceId) as TraceRow | undefined;
  return row ? toTrace(row) : null;
}

/**
 * Retrieve traces for a specific group, ordered newest-first.
 */
export function getTracesByGroup(
  groupFolder: string,
  limit: number = DEFAULT_QUERY_LIMIT,
): Trace[] {
  const db = _getDb();
  const rows = db
    .prepare(
      'SELECT * FROM traces WHERE group_folder = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(groupFolder, limit) as TraceRow[];
  return rows.map(toTrace);
}

/**
 * Retrieve traces of a specific type (message or task), ordered newest-first.
 */
export function getTracesByType(
  type: TraceType,
  limit: number = DEFAULT_QUERY_LIMIT,
): Trace[] {
  const db = _getDb();
  const rows = db
    .prepare(
      'SELECT * FROM traces WHERE type = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(type, limit) as TraceRow[];
  return rows.map(toTrace);
}

/**
 * Retrieve the most recent traces across all groups and types.
 */
export function getRecentTraces(limit: number = DEFAULT_QUERY_LIMIT): Trace[] {
  const db = _getDb();
  const rows = db
    .prepare('SELECT * FROM traces ORDER BY created_at DESC LIMIT ?')
    .all(limit) as TraceRow[];
  return rows.map(toTrace);
}

// --- Internal helpers ---

/** Raw row shape from the traces table. */
interface TraceRow {
  trace_id: string;
  type: string;
  group_folder: string;
  chat_jid: string;
  sender: string | null;
  channel: string | null;
  status: string;
  duration_ms: number;
  error: string | null;
  token_count: number | null;
  tool_calls: number | null;
  created_at: string;
}

/** Convert a database row to the public Trace interface. */
function toTrace(row: TraceRow): Trace {
  return {
    traceId: row.trace_id,
    type: row.type as TraceType,
    groupFolder: row.group_folder,
    chatJid: row.chat_jid,
    sender: row.sender,
    channel: row.channel,
    status: row.status as TraceStatus,
    durationMs: row.duration_ms,
    error: row.error,
    tokenCount: row.token_count,
    toolCalls: row.tool_calls,
    createdAt: row.created_at,
  };
}
