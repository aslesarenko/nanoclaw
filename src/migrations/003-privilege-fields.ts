/**
 * Migration 003: Privilege Fields
 *
 * Adds creator identity columns to scheduled_tasks so that tasks inherit
 * the privilege level and identity of their creator. At execution time,
 * the task's creator_privilege gates which tools the agent can use
 * (NFR-PRIV-01/02 from the digital twin PRD).
 *
 * Session privilege floor (for every-message chats) uses the existing
 * router_state key-value store with keys like 'privilege_floor:{groupFolder}',
 * so no schema change is needed for that.
 *
 * Defaults: creator_sender is NULL (legacy tasks), creator_privilege defaults
 * to 'owner' — safe for existing tasks since they were all created by the
 * owner in the current single-user model.
 */
import type Database from 'better-sqlite3';

import type { Migration } from '../migrations.js';

export const migration: Migration = {
  version: 3,
  name: 'privilege-fields',
  up(db: Database.Database) {
    // creator_sender: the sender ID of whoever created this task (NULL for legacy tasks)
    db.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN creator_sender TEXT`,
    );
    // creator_privilege: privilege level at creation time — gates tools during execution
    db.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN creator_privilege TEXT DEFAULT 'owner'`,
    );
  },
};
