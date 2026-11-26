import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { DataRetention } from '../src/retention/service.js';
import { SettingsStore } from '../src/settings.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 31, 12);

function makeStore(days = 90, summaryDays = 90, budgetDays = 90): SettingsStore {
  const dir = tmpDir('activity-retention');
  const store = new SettingsStore(path.join(dir, 'config.json'));
  store.patch({
    retention: {
      masterEventsDays: days,
      cellSummariesDays: summaryDays,
      budgetAlertsDays: budgetDays,
    },
  });
  return store;
}

function makeDb(): Db {
  return openDb(':memory:');
}

function seed(
  db: Db,
  rows: Array<{ id: string; createdAt: number; action?: string }>,
): void {
  const insert = db.prepare(
    `INSERT INTO master_events (id, cell_id, request_id, action, detail, created_at)
     VALUES (?, 'cell-1', 'req-1', ?, '', ?)`,
  );
  for (const row of rows) insert.run(row.id, row.action ?? 'cycle', row.createdAt);
}

function ids(db: Db): string[] {
  return (db.prepare('SELECT id FROM master_events ORDER BY id').all() as Array<{ id: string }>)
    .map((row) => row.id);
}

function seedAlerts(
  db: Db,
  rows: Array<{ id: string; createdAt: number; acknowledgedAt?: number | null }>,
): void {
  const insert = db.prepare(
    `INSERT INTO budget_alerts
       (id, scope, scope_id, period_start, threshold, alert_at_percent, budget_usd,
        spend_usd, unknown_cost_turns, created_at, acknowledged_at)
     VALUES (?, 'cell', ?, ?, 'warning', 80, 100, 90, 0, ?, ?)`,
  );
  for (const row of rows) {
    const date = new Date(row.createdAt);
    const periodStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    insert.run(row.id, row.id, periodStart, row.createdAt, row.acknowledgedAt ?? null);
  }
}

function alertIds(db: Db): string[] {
  return (
    db.prepare('SELECT id FROM budget_alerts ORDER BY id').all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function seedDeliveries(
  db: Db,
  rows: Array<{ id: string; alertId: string; createdAt: number; status?: string }>,
): void {
  const insert = db.prepare(
    `INSERT INTO budget_alert_deliveries
       (id, alert_id, scope, scope_id, threshold, alert_at_percent, budget_usd,
        spend_usd, unknown_cost_turns, alert_period_start, alert_created_at,
        alert_acknowledged_at, channel, destination_id, format, destination_hash,
        status, attempts, next_attempt_at, last_error, created_at, updated_at, delivered_at)
     SELECT ?, a.id, a.scope, a.scope_id, a.threshold, a.alert_at_percent, a.budget_usd,
            a.spend_usd, a.unknown_cost_turns, a.period_start, a.created_at,
            a.acknowledged_at, 'webhook', ?, 'json', 'hash', ?, 0, ?, NULL, ?, ?, ?
       FROM budget_alerts a
      WHERE a.id = ?`,
  );
  for (const row of rows) {
    const status = row.status ?? 'delivered';
    insert.run(
      row.id,
      row.id,
      status,
      row.createdAt,
      row.createdAt,
      row.createdAt,
      status === 'delivered' ? row.createdAt : null,
      row.alertId,
    );
  }
}

function deliveryIds(db: Db): string[] {
  return (
    db
      .prepare('SELECT id FROM budget_alert_deliveries ORDER BY id')
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function seedSummaries(
  db: Db,
  rows: Array<{ id: string; cellId: string; createdAt: number }>,
): void {
  const insert = db.prepare(
    `INSERT INTO cell_summaries
       (id, cell_id, window_start, window_end, window_minutes, content, stats_json, created_at)
     VALUES (?, ?, ?, ?, 60, '', '{}', ?)`,
  );
  for (const row of rows) {
    insert.run(row.id, row.cellId, row.createdAt - 60_000, row.createdAt, row.createdAt);
  }
}

function summaryIds(db: Db): string[] {
  return (
    db.prepare('SELECT id FROM cell_summaries ORDER BY id').all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function seedOld(db: Db, count: number, action = 'cycle'): void {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `e${String(index).padStart(5, '0')}`,
    createdAt: NOW - 100 * DAY,
    action,
  }));
  seed(db, rows);
}

describe('DataRetention', () => {
  it('deletes rows before the cutoff and keeps the boundary row', async () => {
    const db = makeDb();
    const boundary = NOW - 90 * DAY;
    seed(db, [
      { id: 'older', createdAt: boundary - 1 },
      { id: 'boundary', createdAt: boundary },
      { id: 'recent', createdAt: NOW - DAY },
    ]);
    const retention = new DataRetention({ db, settings: makeStore(90), now: () => NOW });

    const result = await retention.runOnce();

    expect(result).toEqual({
      masterEvents: { deleted: 1, cutoff: boundary },
      cellSummaries: { deleted: 0, cutoff: boundary },
      budgetAlertDeliveries: { deleted: 0, cutoff: boundary },
      budgetAlerts: { deleted: 0, cutoff: boundary },
    });
    expect(ids(db)).toEqual(['boundary', 'recent']);
  });

  it('keeps every row when retention is disabled', async () => {
    const db = makeDb();
    seed(db, [{ id: 'old', createdAt: NOW - 1000 * DAY }]);
    seedAlerts(db, [
      { id: 'old-alert', createdAt: NOW - 1000 * DAY, acknowledgedAt: NOW - 1000 * DAY },
    ]);
    seedDeliveries(db, [
      { id: 'old-delivery', alertId: 'old-alert', createdAt: NOW - 1000 * DAY },
    ]);
    const retention = new DataRetention({
      db,
      settings: makeStore(0, 0, 0),
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result).toEqual({
      masterEvents: { deleted: 0, cutoff: null },
      cellSummaries: { deleted: 0, cutoff: null },
      budgetAlertDeliveries: { deleted: 0, cutoff: null },
      budgetAlerts: { deleted: 0, cutoff: null },
    });
    expect(ids(db)).toEqual(['old']);
    expect(alertIds(db)).toEqual(['old-alert']);
    expect(deliveryIds(db)).toEqual(['old-delivery']);
  });

  it('never prunes follow-up rows, because they are the dedupe key', async () => {
    const db = makeDb();
    seed(db, [
      { id: 'followup', createdAt: NOW - 1000 * DAY, action: 'followup' },
      { id: 'cycle', createdAt: NOW - 1000 * DAY, action: 'cycle' },
      { id: 'skip', createdAt: NOW - 1000 * DAY, action: 'skip' },
    ]);
    const retention = new DataRetention({ db, settings: makeStore(90), now: () => NOW });

    const result = await retention.runOnce();

    expect(result).toEqual({
      masterEvents: { deleted: 2, cutoff: NOW - 90 * DAY },
      cellSummaries: { deleted: 0, cutoff: NOW - 90 * DAY },
      budgetAlertDeliveries: { deleted: 0, cutoff: NOW - 90 * DAY },
      budgetAlerts: { deleted: 0, cutoff: NOW - 90 * DAY },
    });
    expect(ids(db)).toEqual(['followup']);
  });

  it('prunes old scorecard reports but keeps the newest row per cell', async () => {
    const db = makeDb();
    const boundary = NOW - 90 * DAY;
    seedSummaries(db, [
      { id: 'a-old', cellId: 'A', createdAt: boundary - 1 },
      { id: 'a-boundary', cellId: 'A', createdAt: boundary },
      { id: 'a-new', cellId: 'A', createdAt: NOW - DAY },
      // Cells B and C have only a report older than the cutoff; that newest
      // row is still their last known scorecard and must survive.
      { id: 'b-old', cellId: 'B', createdAt: boundary - 1 },
      { id: 'c-old', cellId: 'C', createdAt: NOW - 1000 * DAY },
    ]);
    const retention = new DataRetention({ db, settings: makeStore(90, 90), now: () => NOW });

    const result = await retention.runOnce();

    expect(result.cellSummaries).toEqual({ deleted: 1, cutoff: boundary });
    expect(summaryIds(db)).toEqual(['a-boundary', 'a-new', 'b-old', 'c-old']);
    await expect(retention.runOnce()).resolves.toMatchObject({
      cellSummaries: { deleted: 0 },
    });
  });

  it('keeps the newer id when reports share a timestamp, matching latest()', async () => {
    const db = makeDb();
    const old = NOW - 100 * DAY;
    seedSummaries(db, [
      { id: 'a-first', cellId: 'A', createdAt: old },
      { id: 'a-second', cellId: 'A', createdAt: old },
      { id: 'b-first', cellId: 'B', createdAt: old },
      { id: 'b-second', cellId: 'B', createdAt: old },
    ]);
    const retention = new DataRetention({ db, settings: makeStore(90, 90), now: () => NOW });

    await retention.runOnce();

    expect(summaryIds(db)).toEqual(['a-second', 'b-second']);
  });

  it('prunes each table from its own window', async () => {
    const db = makeDb();
    const store = makeStore(0, 30, 0);
    seed(db, [{ id: 'old-activity', createdAt: NOW - 100 * DAY }]);
    seedSummaries(db, [
      { id: 's-keep', cellId: 'A', createdAt: NOW - 100 * DAY },
      { id: 's-old', cellId: 'A', createdAt: NOW - 200 * DAY },
    ]);
    const retention = new DataRetention({ db, settings: store, now: () => NOW });

    const first = await retention.runOnce();
    expect(first.masterEvents).toEqual({ deleted: 0, cutoff: null });
    expect(first.cellSummaries.deleted).toBe(1);
    expect(first.budgetAlertDeliveries).toEqual({ deleted: 0, cutoff: null });
    expect(first.budgetAlerts).toEqual({ deleted: 0, cutoff: null });
    expect(ids(db)).toEqual(['old-activity']);
    expect(summaryIds(db)).toEqual(['s-keep']);

    store.patch({
      retention: { masterEventsDays: 30, cellSummariesDays: 0, budgetAlertsDays: 0 },
    });
    seed(db, [{ id: 'old-activity-2', createdAt: NOW - 100 * DAY }]);
    seedSummaries(db, [{ id: 's-newer-old', cellId: 'A', createdAt: NOW - 100 * DAY }]);

    const second = await retention.runOnce();
    expect(second.masterEvents.deleted).toBe(2);
    expect(second.cellSummaries).toEqual({ deleted: 0, cutoff: null });
    expect(ids(db)).toEqual([]);
    expect(summaryIds(db)).toEqual(['s-keep', 's-newer-old']);
  });

  it('prunes only terminal budget deliveries before the cutoff', async () => {
    const db = makeDb();
    const boundary = NOW - 90 * DAY;
    seedAlerts(db, [
      { id: 'a-old', createdAt: boundary - 1 },
      { id: 'a-boundary', createdAt: boundary },
      { id: 'a-recent', createdAt: NOW - DAY },
    ]);
    seedDeliveries(db, [
      { id: 'd-delivered', alertId: 'a-old', createdAt: boundary - 1, status: 'delivered' },
      { id: 'd-failed', alertId: 'a-old', createdAt: boundary - 1, status: 'failed' },
      { id: 'd-skipped', alertId: 'a-old', createdAt: boundary - 1, status: 'skipped' },
      { id: 'd-pending', alertId: 'a-old', createdAt: boundary - 1, status: 'pending' },
      { id: 'd-delivering', alertId: 'a-old', createdAt: boundary - 1, status: 'delivering' },
      { id: 'd-boundary', alertId: 'a-boundary', createdAt: boundary, status: 'delivered' },
      { id: 'd-recent', alertId: 'a-recent', createdAt: NOW - DAY, status: 'delivered' },
    ]);
    const retention = new DataRetention({ db, settings: makeStore(90), now: () => NOW });

    const result = await retention.runOnce();

    expect(result.budgetAlertDeliveries).toEqual({ deleted: 3, cutoff: boundary });
    expect(deliveryIds(db)).toEqual([
      'd-boundary',
      'd-delivering',
      'd-pending',
      'd-recent',
    ]);
  });

  it('prunes acknowledged budget alerts without removing their delivery history', async () => {
    const db = makeDb();
    const boundary = NOW - 90 * DAY;
    seedAlerts(db, [
      {
        id: 'a-old-ack',
        createdAt: boundary - 1,
        acknowledgedAt: boundary - 1,
      },
      { id: 'a-old-unack', createdAt: boundary - 1 },
      { id: 'a-boundary-ack', createdAt: boundary, acknowledgedAt: boundary },
      { id: 'a-recent-ack', createdAt: NOW - DAY, acknowledgedAt: NOW - DAY },
    ]);
    seedDeliveries(db, [
      // Pending rows are not terminal, so delivery retention leaves this row.
      // Deleting the acknowledged alert no longer cascades; the notifier drain
      // marks an orphaned pending row skipped on its next pass.
      {
        id: 'd-old-ack',
        alertId: 'a-old-ack',
        createdAt: boundary - 1,
        status: 'pending',
      },
      {
        id: 'd-boundary-ack',
        alertId: 'a-boundary-ack',
        createdAt: boundary,
        status: 'delivered',
      },
    ]);
    const retention = new DataRetention({ db, settings: makeStore(90), now: () => NOW });

    const result = await retention.runOnce();

    expect(result.budgetAlerts).toEqual({ deleted: 1, cutoff: boundary });
    expect(result.budgetAlertDeliveries).toEqual({ deleted: 0, cutoff: boundary });
    expect(alertIds(db)).toEqual([
      'a-boundary-ack',
      'a-old-unack',
      'a-recent-ack',
    ]);
    expect(deliveryIds(db)).toEqual(['d-boundary-ack', 'd-old-ack']);
  });

  it('keeps the current UTC period when the configured window is shorter than a month', async () => {
    const db = makeDb();
    const periodStart = Date.UTC(2026, 0, 1);
    seedAlerts(db, [
      {
        id: 'a-current-ack',
        createdAt: periodStart + 14 * DAY,
        acknowledgedAt: periodStart + 14 * DAY,
      },
      {
        id: 'a-prior-ack',
        createdAt: periodStart - 17 * DAY,
        acknowledgedAt: periodStart - 17 * DAY,
      },
    ]);
    seedDeliveries(db, [
      {
        id: 'd-current',
        alertId: 'a-current-ack',
        createdAt: periodStart + 14 * DAY,
        status: 'delivered',
      },
      {
        id: 'd-prior',
        alertId: 'a-prior-ack',
        createdAt: periodStart - 17 * DAY,
        status: 'delivered',
      },
    ]);
    const retention = new DataRetention({
      db,
      settings: makeStore(90, 90, 1),
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result.budgetAlertDeliveries).toEqual({ deleted: 1, cutoff: periodStart });
    expect(result.budgetAlerts).toEqual({ deleted: 1, cutoff: periodStart });
    expect(alertIds(db)).toEqual(['a-current-ack']);
    expect(deliveryIds(db)).toEqual(['d-current']);
  });

  it('drains a budget-alert backlog larger than one batch', async () => {
    const db = makeDb();
    const old = NOW - 200 * DAY;
    const count = 1200;
    seedAlerts(
      db,
      Array.from({ length: count }, (_, index) => ({
        id: `a${String(index).padStart(5, '0')}`,
        createdAt: old + index,
        acknowledgedAt: old + index,
      })),
    );
    seedDeliveries(
      db,
      Array.from({ length: count }, (_, index) => ({
        id: `d${String(index).padStart(5, '0')}`,
        alertId: `a${String(index).padStart(5, '0')}`,
        createdAt: old + index,
        status: 'delivered',
      })),
    );
    const retention = new DataRetention({
      db,
      settings: makeStore(90),
      now: () => NOW,
      batchSize: 1000,
    });

    const result = await retention.runOnce();

    expect(result.budgetAlertDeliveries.deleted).toBe(count);
    expect(result.budgetAlerts.deleted).toBe(count);
    expect(alertIds(db)).toEqual([]);
    expect(deliveryIds(db)).toEqual([]);
    await expect(retention.runOnce()).resolves.toMatchObject({
      budgetAlertDeliveries: { deleted: 0 },
      budgetAlerts: { deleted: 0 },
    });
  });

  it('isolates a budget-alert delivery failure from alert pruning', async () => {
    const db = makeDb();
    const old = NOW - 100 * DAY;
    seedAlerts(db, [{ id: 'a-old', createdAt: old, acknowledgedAt: old }]);
    seedDeliveries(db, [
      { id: 'd-old', alertId: 'a-old', createdAt: old, status: 'delivered' },
    ]);
    let failing: 'budget_alerts' | 'budget_alert_deliveries' | null =
      'budget_alert_deliveries';
    const guarded = {
      prepare(sql: string) {
        if (failing && sql.includes(`DELETE FROM ${failing}`)) {
          throw new Error('database is busy');
        }
        return db.prepare(sql);
      },
    } as unknown as Db;
    const errors = { error: vi.fn() };
    const retention = new DataRetention({
      db: guarded,
      settings: makeStore(90),
      errors,
      now: () => NOW,
    });

    const first = await retention.runOnce();
    expect(first.budgetAlertDeliveries.deleted).toBe(0);
    expect(first.budgetAlerts.deleted).toBe(1);
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'retention.prune',
      expect.any(Error),
      expect.objectContaining({ table: 'budget_alert_deliveries', deleted: 0 }),
    );
    expect(alertIds(db)).toEqual([]);

    failing = 'budget_alerts';
    seedAlerts(db, [{ id: 'a-recover', createdAt: old, acknowledgedAt: old }]);
    seedDeliveries(db, [
      { id: 'd-recover', alertId: 'a-recover', createdAt: old, status: 'delivered' },
    ]);
    const second = await retention.runOnce();
    expect(second.budgetAlertDeliveries.deleted).toBe(2);
    expect(second.budgetAlerts.deleted).toBe(0);
    expect(errors.error).toHaveBeenCalledTimes(2);
    expect(errors.error).toHaveBeenLastCalledWith(
      'retention.prune',
      expect.any(Error),
      expect.objectContaining({ table: 'budget_alerts', deleted: 0 }),
    );

    failing = null;
    const third = await retention.runOnce();
    expect(third.budgetAlerts.deleted).toBe(1);
    expect(alertIds(db)).toEqual([]);
    expect(deliveryIds(db)).toEqual([]);
  });

  it('drains a scorecard backlog larger than one batch and keeps one row per cell', async () => {
    const db = makeDb();
    seedSummaries(
      db,
      Array.from({ length: 2500 }, (_, index) => ({
        id: `s${String(index).padStart(5, '0')}`,
        cellId: index % 2 === 0 ? 'A' : 'B',
        createdAt: NOW - 200 * DAY + index,
      })),
    );
    const retention = new DataRetention({
      db,
      settings: makeStore(90, 90),
      now: () => NOW,
      batchSize: 1000,
    });

    const result = await retention.runOnce();

    expect(result.cellSummaries.deleted).toBe(2498);
    expect(summaryIds(db)).toEqual(['s02498', 's02499']);
    await expect(retention.runOnce()).resolves.toMatchObject({
      cellSummaries: { deleted: 0 },
    });
  });

  it('isolates a failed table from the other', async () => {
    const db = makeDb();
    seed(db, [{ id: 'old-activity', createdAt: NOW - 100 * DAY }]);
    seedSummaries(db, [
      { id: 's-keep', cellId: 'A', createdAt: NOW - 100 * DAY },
      { id: 's-old', cellId: 'A', createdAt: NOW - 200 * DAY },
    ]);
    let failing: 'master_events' | 'cell_summaries' | null = 'cell_summaries';
    const guarded = {
      prepare(sql: string) {
        if (failing && sql.includes(`DELETE FROM ${failing}`)) {
          throw new Error('database is busy');
        }
        return db.prepare(sql);
      },
    } as unknown as Db;
    const errors = { error: vi.fn() };
    const retention = new DataRetention({
      db: guarded,
      settings: makeStore(90, 90),
      errors,
      now: () => NOW,
    });

    const first = await retention.runOnce();
    expect(first.masterEvents.deleted).toBe(1);
    expect(first.cellSummaries.deleted).toBe(0);
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'retention.prune',
      expect.any(Error),
      expect.objectContaining({ table: 'cell_summaries', deleted: 0 }),
    );

    failing = 'master_events';
    seed(db, [{ id: 'old-activity-2', createdAt: NOW - 100 * DAY }]);
    const second = await retention.runOnce();
    expect(second.masterEvents.deleted).toBe(0);
    expect(second.cellSummaries.deleted).toBe(1);
    expect(errors.error).toHaveBeenCalledTimes(2);
    expect(errors.error).toHaveBeenLastCalledWith(
      'retention.prune',
      expect.any(Error),
      expect.objectContaining({ table: 'master_events', deleted: 0 }),
    );

    failing = null;
    const third = await retention.runOnce();
    expect(third.masterEvents.deleted).toBe(1);
    expect(third.cellSummaries.deleted).toBe(0);
    expect(ids(db)).toEqual([]);
    expect(summaryIds(db)).toEqual(['s-keep']);
  });

  it('drains a backlog larger than one batch in a single run', async () => {
    const db = makeDb();
    seedOld(db, 2500);
    const retention = new DataRetention({
      db,
      settings: makeStore(90),
      now: () => NOW,
      batchSize: 1000,
    });

    const result = await retention.runOnce();

    expect(result.masterEvents.deleted).toBe(2500);
    expect(ids(db)).toEqual([]);
    await expect(retention.runOnce()).resolves.toMatchObject({
      masterEvents: { deleted: 0 },
    });
  });

  it('joins an in-flight pass instead of starting a second one', async () => {
    const db = makeDb();
    seedOld(db, 2500);
    const retention = new DataRetention({
      db,
      settings: makeStore(90),
      now: () => NOW,
      batchSize: 1000,
    });

    const first = retention.runOnce();
    const second = retention.runOnce();
    expect(second).toBe(first);

    await expect(first).resolves.toMatchObject({ masterEvents: { deleted: 2500 } });
    expect(ids(db)).toEqual([]);
  });

  it('reports a failed delete and recovers on the next run', async () => {
    const db = makeDb();
    seed(db, [{ id: 'old', createdAt: NOW - 100 * DAY }]);
    let fail = true;
    const guarded = {
      prepare(sql: string) {
        if (fail && sql.includes('DELETE FROM master_events')) {
          throw new Error('database is busy');
        }
        return db.prepare(sql);
      },
    } as unknown as Db;
    const errors = { error: vi.fn() };
    const retention = new DataRetention({
      db: guarded,
      settings: makeStore(90),
      errors,
      now: () => NOW,
    });

    await expect(retention.runOnce()).resolves.toMatchObject({
      masterEvents: { deleted: 0 },
    });
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'retention.prune',
      expect.any(Error),
      expect.objectContaining({
        table: 'master_events',
        deleted: 0,
        cutoff: NOW - 90 * DAY,
      }),
    );

    fail = false;
    await expect(retention.runOnce()).resolves.toMatchObject({
      masterEvents: { deleted: 1 },
    });
    expect(ids(db)).toEqual([]);
  });

  it('prunes on start, hourly, and settings changes, then stops', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const store = makeStore(90);
      const retention = new DataRetention({
        db,
        settings: store,
        now: () => NOW,
        intervalMs: 1000,
        batchSize: 100,
      });

      seed(db, [{ id: 'startup', createdAt: NOW - 100 * DAY }]);
      retention.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(db)).toEqual([]);

      seed(db, [{ id: 'hourly', createdAt: NOW - 100 * DAY }]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ids(db)).toEqual([]);

      seed(db, [{ id: 'setting', createdAt: NOW - 100 * DAY }]);
      store.patch({ retention: { masterEventsDays: 30 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(db)).toEqual([]);

      seed(db, [{ id: 'stopped', createdAt: NOW - 100 * DAY }]);
      retention.stop();
      retention.stop();
      await vi.advanceTimersByTimeAsync(5000);
      store.patch({ retention: { masterEventsDays: 10 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(db)).toEqual(['stopped']);
    } finally {
      vi.useRealTimers();
    }
  });
});
