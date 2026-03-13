import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { _getDb, _initTestDatabaseAtVersion } from './db.js';
import {
  getAppliedMigrations,
  getCurrentVersion,
  Migration,
  runMigrations,
} from './migrations.js';

let db: Database.Database;

beforeEach(() => {
  _initTestDatabaseAtVersion(0); // Base schema only, no migrations applied
  db = _getDb();
});

describe('runMigrations', () => {
  it('runs migrations in order', () => {
    const log: number[] = [];
    const migrations: Migration[] = [
      { version: 2, name: 'second', up: () => log.push(2) },
      { version: 1, name: 'first', up: () => log.push(1) },
    ];
    runMigrations(db, migrations);
    expect(log).toEqual([1, 2]);
  });

  it('skips already-applied migrations', () => {
    const log: number[] = [];
    const m1: Migration = {
      version: 1,
      name: 'first',
      up: () => log.push(1),
    };
    const m2: Migration = {
      version: 2,
      name: 'second',
      up: () => log.push(2),
    };

    runMigrations(db, [m1]);
    expect(log).toEqual([1]);

    // Running again with both migrations should only execute m2
    runMigrations(db, [m1, m2]);
    expect(log).toEqual([1, 2]);
  });

  it('records applied migrations in schema_migrations table', () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'test-migration',
        up: (d) => d.exec('CREATE TABLE test_table (id TEXT)'),
      },
    ];
    runMigrations(db, migrations);

    const applied = getAppliedMigrations(db);
    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe('test-migration');
    expect(applied[0].applied_at).toBeTruthy();
  });

  it('stops on migration failure and does not apply subsequent', () => {
    const log: number[] = [];
    const migrations: Migration[] = [
      { version: 1, name: 'ok', up: () => log.push(1) },
      {
        version: 2,
        name: 'fail',
        up: () => {
          throw new Error('boom');
        },
      },
      { version: 3, name: 'never', up: () => log.push(3) },
    ];

    expect(() => runMigrations(db, migrations)).toThrow('boom');
    expect(log).toEqual([1]);
    expect(getCurrentVersion(db)).toBe(1);
  });

  it('rolls back failed migration atomically', () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'partial-fail',
        up: (d) => {
          d.exec('CREATE TABLE should_not_exist (id TEXT)');
          throw new Error('oops');
        },
      },
    ];

    expect(() => runMigrations(db, migrations)).toThrow('oops');
    expect(getCurrentVersion(db)).toBe(0);

    // Table created inside the failed migration should not exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'",
      )
      .all();
    expect(tables).toHaveLength(0);
  });

  it('handles empty migration list', () => {
    expect(() => runMigrations(db, [])).not.toThrow();
    expect(getCurrentVersion(db)).toBe(0);
  });

  it('handles fresh database with no schema_migrations table', () => {
    const freshDb = new Database(':memory:');
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'first',
        up: (d) => d.exec('CREATE TABLE test (id TEXT)'),
      },
    ];
    runMigrations(freshDb, migrations);
    expect(getCurrentVersion(freshDb)).toBe(1);
  });
});
