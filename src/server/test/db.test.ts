import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDb, reconcile } from '../src/db.js';

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe('db migrations', () => {
  it('is idempotent on a fresh database', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db);
    expect(columns(db, 'requests')).toContain('cell_id');
    expect(columns(db, 'requests')).toContain('agent_status');
    expect(columns(db, 'cells')).toContain('master_enabled');
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain('master_events');
    expect(tables).toContain('cell_summaries');
    db.close();
  });

  it('adds cell_id and its index to a database created by an older build', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-legacy-'));
    const file = path.join(dir, 'legacy.sqlite');

    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'clarify',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    legacy.exec(`CREATE TABLE cells (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    legacy
      .prepare("INSERT INTO requests (id, title, state, created_at, updated_at) VALUES ('r1', 'old', 'clarify', 1, 1)")
      .run();
    legacy.close();

    // The index on cell_id must be created after the column exists, or this throws.
    const db = openDb(file);
    expect(columns(db, 'requests')).toContain('cell_id');
    expect(columns(db, 'cells')).toContain('master_enabled');
    expect(columns(db, 'cells')).toContain('process_json');
    expect(columns(db, 'cells')).toContain('master_interval_minutes');
    expect(columns(db, 'cells')).toContain('max_concurrent');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(indexes).toContain('idx_requests_cell');
    expect(indexes).toContain('idx_requests_state');
    expect(indexes).toContain('idx_cell_summaries_cell_created');
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    ).toContain('cell_summaries');
    db.close();
  });

  it('reconciles a stale working status to idle on boot', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO requests (id, title, agent_status, created_at, updated_at)
       VALUES ('r1', 'stale', 'working', 1, 1)`,
    ).run();
    expect(reconcile(db)).toBe(1);
    const row = db.prepare("SELECT agent_status FROM requests WHERE id = 'r1'").get() as {
      agent_status: string;
    };
    expect(row.agent_status).toBe('idle');
    db.close();
  });
});
