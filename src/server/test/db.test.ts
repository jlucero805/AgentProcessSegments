import Database from 'better-sqlite3';
import path from 'node:path';
import { tmpDir } from './tmp.js';
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
    expect(columns(db, 'requests')).toContain('harness');
    expect(columns(db, 'requests')).toContain('agent_status');
    expect(columns(db, 'cells')).toContain('master_enabled');
    expect(columns(db, 'cells')).toContain('harness');
    expect(columns(db, 'cells')).toContain('monthly_budget_usd');
    expect(columns(db, 'cells')).toContain('pause_on_exceeded');
    expect(columns(db, 'cells')).toContain('pause_on_unknown_cost');
    expect(columns(db, 'cells')).toContain('autocompact_percent');
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain('master_events');
    expect(tables).toContain('cell_summaries');
    expect(tables).toContain('usage_events');
    expect(tables).toContain('usage_daily');
    expect(tables).toContain('usage_rollup_state');
    expect(tables).toContain('budget_alerts');
    expect(tables).toContain('budget_alert_deliveries');
    expect(tables).toContain('notification_event_deliveries');
    expect(tables).toContain('spend_cap_overrides');
    expect(tables).toContain('model_pricing');
    expect(
      db.prepare('SELECT rolled_through FROM usage_rollup_state WHERE id = 1').get(),
    ).toEqual({ rolled_through: 0 });
    db.prepare('UPDATE usage_rollup_state SET rolled_through = 123 WHERE id = 1').run();
    migrate(db);
    expect(
      db.prepare('SELECT rolled_through FROM usage_rollup_state WHERE id = 1').get(),
    ).toEqual({ rolled_through: 123 });
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toContain('idx_model_pricing_model_effective');
    db.close();
  });

  it('adds cell_id and its index to a database created by an older build', () => {
    const dir = tmpDir('legacy');
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
    legacy
      .prepare("INSERT INTO cells (id, name, created_at) VALUES ('c1', 'old cell', 1)")
      .run();
    legacy.close();

    // The index on cell_id must be created after the column exists, or this throws.
    const db = openDb(file);
    expect(columns(db, 'requests')).toContain('cell_id');
    expect(columns(db, 'requests')).toContain('harness');
    expect(columns(db, 'cells')).toContain('master_enabled');
    expect(columns(db, 'cells')).toContain('process_json');
    expect(columns(db, 'cells')).toContain('master_interval_minutes');
    expect(columns(db, 'cells')).toContain('max_concurrent');
    expect(columns(db, 'cells')).toContain('harness');
    expect(columns(db, 'cells')).toContain('monthly_budget_usd');
    expect(columns(db, 'cells')).toContain('pause_on_exceeded');
    expect(columns(db, 'cells')).toContain('pause_on_unknown_cost');
    expect(columns(db, 'cells')).toContain('autocompact_percent');
    const migrated = db
      .prepare(
        'SELECT autocompact_percent, pause_on_exceeded, pause_on_unknown_cost FROM cells WHERE id = ?',
      )
      .get('c1') as {
        autocompact_percent: number;
        pause_on_exceeded: number;
        pause_on_unknown_cost: number;
      };
    expect(migrated.autocompact_percent).toBe(80);
    expect(migrated.pause_on_exceeded).toBe(0);
    expect(migrated.pause_on_unknown_cost).toBe(0);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(indexes).toContain('idx_requests_cell');
    expect(indexes).toContain('idx_requests_state');
    expect(indexes).toContain('idx_cell_summaries_cell_created');
    expect(indexes).toContain('idx_cell_summaries_created');
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    ).toContain('cell_summaries');
    expect(indexes).toContain('idx_usage_events_created');
    expect(indexes).toContain('idx_usage_events_cell_created');
    expect(indexes).toContain('idx_usage_events_request_created');
    expect(indexes).toContain('idx_usage_events_turn');
    expect(indexes).toContain('idx_budget_alerts_identity');
    expect(indexes).toContain('idx_budget_alert_deliveries_due');
    expect(indexes).toContain('idx_notification_event_deliveries_due');
    expect(indexes).toContain('idx_spend_cap_overrides_active');
    expect(indexes).toContain('idx_spend_cap_overrides_period');
    expect(indexes).toContain('idx_model_pricing_model_effective');
    const legacyTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(legacyTables).toContain('model_pricing');
    expect(legacyTables).toContain('notification_event_deliveries');
    expect(legacyTables).toContain('usage_daily');
    expect(legacyTables).toContain('usage_rollup_state');
    expect(legacyTables).toContain('spend_cap_overrides');
    db.close();
  });

  it('allows one non-revoked spend cap override per scope and period', () => {
    const db = openDb(':memory:');
    const insert = db.prepare(
      `INSERT INTO spend_cap_overrides
         (id, scope, scope_id, period_start, expires_at, note, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insert.run('a', 'overall', '', 1, 10, null, 1, 1, null);
    expect(() =>
      insert.run('b', 'overall', '', 1, 20, null, 1, 1, null),
    ).toThrow();
    insert.run('c', 'overall', '', 1, 20, null, 1, 1, 5);
    insert.run('d', 'cell', 'cell-1', 1, 20, null, 1, 1, null);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM spend_cap_overrides').get(),
    ).toEqual({ count: 3 });
    db.close();
  });

  it('keeps one event delivery per dedupe key and channel without a foreign key', () => {
    const db = openDb(':memory:');
    const insert = db.prepare(
      `INSERT INTO notification_event_deliveries
         (id, dedupe_key, kind, channel, format, destination_hash, payload_json,
          status, attempts, next_attempt_at, last_error, created_at, updated_at, delivered_at)
       VALUES (?, 'turn:r1:engine.exit:exit_1:1', 'turn.failed', ?, 'json', 'hash',
               '{}', 'pending', 0, 10, NULL, 10, 10, NULL)`,
    );
    insert.run('e1', 'webhook');
    expect(() => insert.run('e2', 'webhook')).toThrow();
    insert.run('e3', 'email');
    const rows = db
      .prepare(
        `SELECT channel FROM notification_event_deliveries ORDER BY channel`,
      )
      .all() as Array<{ channel: string }>;
    expect(rows).toEqual([{ channel: 'email' }, { channel: 'webhook' }]);
    db.close();
  });

  it('enforces delivery identity and cascades deletes from alerts', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO budget_alerts
         (id, scope, scope_id, period_start, threshold, alert_at_percent, budget_usd,
          spend_usd, unknown_cost_turns, created_at, acknowledged_at)
       VALUES ('a1', 'overall', '', 100, 'warning', 80, 100, 85, 0, 10, NULL)`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO budget_alert_deliveries
         (id, alert_id, channel, destination_id, format, destination_hash, status, attempts,
          next_attempt_at, last_error, created_at, updated_at, delivered_at)
       VALUES (?, 'a1', 'webhook', ?, 'json', 'hash', 'pending', 0, 10, NULL, 10, 10, NULL)`,
    );
    insert.run('d1', 'webhook');
    expect(() => insert.run('d2', 'webhook')).toThrow();
    insert.run('d3', 'slack:C0123456789');

    db.prepare("DELETE FROM budget_alerts WHERE id = 'a1'").run();
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM budget_alert_deliveries').get() as {
        count: number;
      }).count,
    ).toBe(0);
    db.close();
  });

  it('stores webhook, email, and multiple chat destinations for one alert', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO budget_alerts
         (id, scope, scope_id, period_start, threshold, alert_at_percent, budget_usd,
          spend_usd, unknown_cost_turns, created_at, acknowledged_at)
       VALUES ('a1', 'overall', '', 100, 'warning', 80, 100, 85, 0, 10, NULL)`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO budget_alert_deliveries
         (id, alert_id, channel, destination_id, format, destination_hash, status, attempts,
          next_attempt_at, last_error, created_at, updated_at, delivered_at)
       VALUES (?, 'a1', ?, ?, ?, 'hash', 'pending', 0, 10, NULL, 10, 10, NULL)`,
    );
    insert.run('d-webhook', 'webhook', 'webhook', 'json');
    insert.run('d-email', 'email', 'email', 'email');
    insert.run('d-slack', 'slack', 'slack:C0123456789', 'chat');
    insert.run('d-discord', 'discord', 'discord:123456789012345678', 'chat');
    const rows = db
      .prepare(
        `SELECT channel, destination_id, format FROM budget_alert_deliveries
          ORDER BY channel`,
      )
      .all() as Array<{ channel: string; destination_id: string; format: string }>;
    expect(rows).toEqual([
      { channel: 'discord', destination_id: 'discord:123456789012345678', format: 'chat' },
      { channel: 'email', destination_id: 'email', format: 'email' },
      { channel: 'slack', destination_id: 'slack:C0123456789', format: 'chat' },
      { channel: 'webhook', destination_id: 'webhook', format: 'json' },
    ]);
    db.close();
  });

  it('rebuilds a legacy delivery table and backfills destination_id from channel', () => {
    const dir = tmpDir('delivery-legacy');
    const file = path.join(dir, 'legacy.sqlite');
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE budget_alerts (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('overall', 'cell')),
      scope_id TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      threshold TEXT NOT NULL CHECK (threshold IN ('warning', 'exceeded')),
      alert_at_percent INTEGER NOT NULL,
      budget_usd REAL NOT NULL,
      spend_usd REAL NOT NULL,
      unknown_cost_turns INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    )`);
    legacy.exec(`CREATE TABLE budget_alert_deliveries (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES budget_alerts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      format TEXT NOT NULL,
      destination_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE(alert_id, channel)
    )`);
    legacy.prepare(
      `INSERT INTO budget_alerts
         (id, scope, scope_id, period_start, threshold, alert_at_percent, budget_usd,
          spend_usd, unknown_cost_turns, created_at, acknowledged_at)
       VALUES ('a1', 'overall', '', 100, 'warning', 80, 100, 85, 0, 10, NULL)`,
    ).run();
    legacy.prepare(
      `INSERT INTO budget_alert_deliveries
         (id, alert_id, channel, format, destination_hash, status, attempts,
          next_attempt_at, last_error, created_at, updated_at, delivered_at)
       VALUES ('d1', 'a1', 'webhook', 'json', 'hash', 'delivered', 2, 10, NULL, 10, 20, 20)`,
    ).run();
    legacy.close();

    const db = openDb(file);
    expect(columns(db, 'budget_alert_deliveries')).toContain('destination_id');
    expect(
      db
        .prepare('SELECT id, channel, destination_id, status, attempts FROM budget_alert_deliveries')
        .get(),
    ).toEqual({
      id: 'd1',
      channel: 'webhook',
      destination_id: 'webhook',
      status: 'delivered',
      attempts: 2,
    });
    const insert = db.prepare(
      `INSERT INTO budget_alert_deliveries
         (id, alert_id, channel, destination_id, format, destination_hash, status, attempts,
          next_attempt_at, last_error, created_at, updated_at, delivered_at)
       VALUES ('d2', 'a1', 'webhook', 'slack:C0123456789', 'chat', 'hash2', 'pending', 0, 10,
               NULL, 10, 10, NULL)`,
    );
    insert.run();
    migrate(db);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM budget_alert_deliveries').get() as {
        count: number;
      }).count,
    ).toBe(2);
    db.close();
  });

  it('rebuilds a legacy usage_daily table with the segment dimension', () => {
    const dir = tmpDir('usage-daily-legacy');
    const file = path.join(dir, 'legacy.sqlite');
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE usage_daily (
      day_start            INTEGER NOT NULL,
      scope                TEXT NOT NULL,
      cell_id              TEXT NOT NULL DEFAULT '',
      request_id           TEXT NOT NULL DEFAULT '',
      model                TEXT NOT NULL DEFAULT '',
      turns                INTEGER NOT NULL,
      input_tokens         INTEGER NOT NULL,
      output_tokens        INTEGER NOT NULL,
      cache_read_tokens    INTEGER NOT NULL,
      cache_write_tokens   INTEGER NOT NULL,
      reasoning_tokens     INTEGER NOT NULL,
      reported_cost_usd    REAL,
      reported_cost_turns  INTEGER NOT NULL,
      estimated_cost_usd   REAL,
      estimated_cost_turns INTEGER NOT NULL,
      PRIMARY KEY (day_start, scope, cell_id, request_id, model)
    ) WITHOUT ROWID`);
    legacy
      .prepare(
        `INSERT INTO usage_daily
           (day_start, scope, cell_id, request_id, model, turns, input_tokens,
            output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
            reported_cost_usd, reported_cost_turns, estimated_cost_usd,
            estimated_cost_turns)
         VALUES (0, 'request', 'c1', 'r1', 'm1', 3, 10, 5, 0, 0, 0, 0.5, 3, NULL, 0)`,
      )
      .run();
    legacy.close();

    const db = openDb(file);
    expect(columns(db, 'usage_daily')).toContain('segment');
    expect(
      db.prepare('SELECT segment, turns, reported_cost_usd FROM usage_daily').get(),
    ).toEqual({ segment: '', turns: 3, reported_cost_usd: 0.5 });
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
