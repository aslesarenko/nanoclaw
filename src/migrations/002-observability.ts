/**
 * Migration 002: Observability
 *
 * Creates the traces table for structured trace recording at key
 * lifecycle points (message processing, task execution). Each trace
 * captures timing, identity, and status metadata for queryable
 * observability (NFR-OBS-01 through NFR-OBS-03).
 */
import type Database from 'better-sqlite3';

import type { Migration } from '../migrations.js';

export const migration: Migration = {
  version: 2,
  name: 'observability',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        sender TEXT,
        channel TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        error TEXT,
        token_count INTEGER,
        tool_calls INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_traces_group ON traces(group_folder);
      CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at);
      CREATE INDEX IF NOT EXISTS idx_traces_type ON traces(type);
    `);
  },
};
