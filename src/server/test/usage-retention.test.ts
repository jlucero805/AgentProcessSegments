import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { SettingsStore } from '../src/settings.js';
import { readUsagePruneState } from '../src/usage/prune-state.js';
import { UsageRepository } from '../src/usage/repository.js';
import { UsageRetention } from '../src/usage/retention.js';
import { UsageRollups } from '../src/usage/rollups.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 31, 12);
const CUTOFF = Date.UTC(2025, 10, 2);

function makeStore(days = 90): SettingsStore {
  const dir = tmpDir('usage-retention');
  const store = new SettingsStore(path.join(dir, 'config.json'));
  store.patch({ usage: { retentionDays: days } });
  return store;
}

function makeUsageDb(): Db {
  return openDb(':memory:');
}

function seed(db: Db, rows: Array<{ id: string; createdAt: number }>): void {
  const insert = db.prepare(
    `INSERT INTO usage_events (id, turn_id, session_id, scope, created_at)
     VALUES (?, ?, 'test-session', 'request', ?)`,
  );
  for (const row of rows) insert.run(row.id, row.id, row.createdAt);
}

function ids(db: Db): string[] {
  return (db.prepare('SELECT id FROM usage_events ORDER BY id').all() as Array<{ id: string }>)
    .map((row) => row.id);
}

function daily(db: Db): Array<{ day_start: number; turns: number }> {
  return db
    .prepare('SELECT day_start, turns FROM usage_daily ORDER BY day_start')
    .all() as Array<{ day_start: number; turns: number }>;
}

function watermark(db: Db): number {
  return Number(
    (
      db.prepare('SELECT rolled_through AS value FROM usage_rollup_state WHERE id = 1').get() as {
        value: number;
      }
    ).value,
  );
}

function seedOld(db: Db, count: number): void {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `u${String(index).padStart(5, '0')}`,
    createdAt: NOW - 100 * DAY,
  }));
  seed(db, rows);
}

describe('UsageRetention', () => {
  it('rolls back and deletes rows before the UTC-day cutoff', async () => {
    const db = makeUsageDb();
    seed(db, [
      { id: 'older', createdAt: CUTOFF - 1 },
      { id: 'boundary', createdAt: CUTOFF },
      { id: 'recent', createdAt: NOW - DAY },
    ]);
    const retention = new UsageRetention({ db, settings: makeStore(90), now: () => NOW });

    const result = await retention.runOnce();

    expect(result).toEqual({
      deleted: 1,
      cutoff: CUTOFF,
      rolledThrough: CUTOFF,
    });
    expect(ids(db)).toEqual(['boundary', 'recent']);
    expect(daily(db)).toEqual([{ day_start: CUTOFF - DAY, turns: 1 }]);
  });

  it('keeps every row when retention is disabled', async () => {
    const db = makeUsageDb();
    seed(db, [{ id: 'old', createdAt: NOW - 1000 * DAY }]);
    const retention = new UsageRetention({ db, settings: makeStore(0), now: () => NOW });

    const result = await retention.runOnce();

    expect(result).toEqual({ deleted: 0, cutoff: null, rolledThrough: null });
    expect(ids(db)).toEqual(['old']);
    expect(daily(db)).toEqual([]);
    expect(watermark(db)).toBe(0);
    expect(readUsagePruneState(db)).toEqual({ ranAt: NOW, deletedRows: 0 });
  });

  it('reports no pass before the first run', () => {
    const db = makeUsageDb();

    expect(readUsagePruneState(db)).toBeNull();
    expect(new UsageRepository(db).lastPrune()).toBeNull();
  });

  it('records the pass time and deleted count, and the latest pass wins', async () => {
    const db = makeUsageDb();
    seed(db, [{ id: 'old', createdAt: NOW - 100 * DAY }]);
    const retention = new UsageRetention({ db, settings: makeStore(90), now: () => NOW });

    await retention.runOnce();

    expect(readUsagePruneState(db)).toEqual({ ranAt: NOW, deletedRows: 1 });
    // A new repository instance reads the persisted row, not instance memory.
    expect(new UsageRepository(db).lastPrune()).toEqual({ ranAt: NOW, deletedRows: 1 });

    await retention.runOnce(NOW + DAY);

    expect(readUsagePruneState(db)).toEqual({ ranAt: NOW + DAY, deletedRows: 0 });
  });

  it('records once when a caller joins the in-flight pass', async () => {
    const db = makeUsageDb();
    seedOld(db, 2500);
    let stateWrites = 0;
    const counting = {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO usage_prune_state')) stateWrites += 1;
        return db.prepare(sql);
      },
    } as unknown as Db;
    const retention = new UsageRetention({
      db: counting,
      settings: makeStore(90),
      now: () => NOW,
      rollups: new UsageRollups(db),
    });

    const first = retention.runOnce();
    const second = retention.runOnce();
    expect(second).toBe(first);

    await Promise.all([first, second]);
    expect(stateWrites).toBe(1);
    expect(readUsagePruneState(db)).toEqual({ ranAt: NOW, deletedRows: 2500 });
  });

  it('logs and survives a failed prune-state write', async () => {
    const db = makeUsageDb();
    seed(db, [{ id: 'old', createdAt: NOW - 100 * DAY }]);
    const guarded = {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO usage_prune_state')) {
          throw new Error('database is busy');
        }
        return db.prepare(sql);
      },
    } as unknown as Db;
    const errors = { error: vi.fn() };
    const retention = new UsageRetention({
      db: guarded,
      settings: makeStore(90),
      errors,
      now: () => NOW,
      rollups: new UsageRollups(db),
    });

    await expect(retention.runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(ids(db)).toEqual([]);
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith('usage.prune_state', expect.any(Error), {
      ranAt: NOW,
      deletedRows: 1,
    });
  });

  it('drains a backlog larger than one batch after one rollup chunk', async () => {
    const db = makeUsageDb();
    seedOld(db, 2500);
    const retention = new UsageRetention({
      db,
      settings: makeStore(90),
      now: () => NOW,
      batchSize: 1000,
    });

    const result = await retention.runOnce();

    expect(result.deleted).toBe(2500);
    expect(ids(db)).toEqual([]);
    expect(daily(db).reduce((sum, row) => sum + row.turns, 0)).toBe(2500);
    await expect(retention.runOnce()).resolves.toMatchObject({ deleted: 0 });
  });

  it('joins an in-flight pass instead of starting a second one', async () => {
    const db = makeUsageDb();
    seedOld(db, 2500);
    const retention = new UsageRetention({
      db,
      settings: makeStore(90),
      now: () => NOW,
      batchSize: 1000,
    });

    const first = retention.runOnce();
    const second = retention.runOnce();
    expect(second).toBe(first);

    await expect(first).resolves.toMatchObject({ deleted: 2500 });
    expect(ids(db)).toEqual([]);
  });

  it('is a silent no-op when the usage ledger does not exist yet', async () => {
    const db = openDb(':memory:');
    db.exec('DROP TABLE usage_events');
    const errors = { error: vi.fn() };
    const retention = new UsageRetention({
      db,
      settings: makeStore(90),
      errors,
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result).toEqual({ deleted: 0, cutoff: CUTOFF, rolledThrough: null });
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('deletes nothing when rollup fails and resumes on the next run', async () => {
    const db = makeUsageDb();
    seed(db, [{ id: 'old', createdAt: NOW - 100 * DAY }]);
    const errors = { error: vi.fn() };
    let fail = true;
    const rollups: Pick<UsageRollups, 'watermark' | 'rollupThrough'> = {
      watermark: () => 0,
      rollupThrough: () => {
        if (fail) throw new Error('rollup failed');
        return { from: CUTOFF, to: CUTOFF, rows: 0, done: true };
      },
    };
    const retention = new UsageRetention({
      db,
      settings: makeStore(90),
      errors,
      now: () => NOW,
      rollups,
    });

    await expect(retention.runOnce()).resolves.toMatchObject({ deleted: 0 });
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'usage.rollup',
      expect.any(Error),
      expect.objectContaining({ cutoff: CUTOFF, rolledThrough: null }),
    );
    expect(ids(db)).toEqual(['old']);
    expect(daily(db)).toEqual([]);

    fail = false;
    const real = new UsageRetention({ db, settings: makeStore(90), now: () => NOW });
    await expect(real.runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(ids(db)).toEqual([]);
  });

  it('reports a failed delete and recovers on the next run', async () => {
    const db = makeUsageDb();
    seed(db, [{ id: 'old', createdAt: NOW - 100 * DAY }]);
    let fail = true;
    const guarded = {
      prepare(sql: string) {
        if (fail && sql.includes('DELETE FROM usage_events')) {
          throw new Error('database is busy');
        }
        return db.prepare(sql);
      },
    } as unknown as Db;
    const errors = { error: vi.fn() };
    const retention = new UsageRetention({
      db: guarded,
      settings: makeStore(90),
      errors,
      now: () => NOW,
      rollups: new UsageRollups(db),
    });

    await expect(retention.runOnce()).resolves.toMatchObject({ deleted: 0 });
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'usage.prune',
      expect.any(Error),
      expect.objectContaining({ deleted: 0, cutoff: CUTOFF }),
    );
    expect(ids(db)).toEqual(['old']);
    expect(daily(db)).toEqual([
      { day_start: Math.floor((NOW - 100 * DAY) / DAY) * DAY, turns: 1 },
    ]);
    expect(watermark(db)).toBe(CUTOFF);

    fail = false;
    await expect(retention.runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(ids(db)).toEqual([]);
  });

  it('resumes from a committed watermark after a later rollup chunk fails', async () => {
    const db = makeUsageDb();
    seed(db, [
      { id: 'day0', createdAt: CUTOFF - 5 * DAY },
      { id: 'day2', createdAt: CUTOFF - 3 * DAY },
    ]);
    const real = new UsageRollups(db);
    let calls = 0;
    const errors = { error: vi.fn() };
    const retention = new UsageRetention({
      db,
      settings: makeStore(90),
      errors,
      now: () => NOW,
      rollupChunkDays: 1,
      rollups: {
        watermark: () => real.watermark(),
        rollupThrough: (through, options) => {
          calls += 1;
          if (calls === 2) throw new Error('rollup failed mid-way');
          return real.rollupThrough(through, options);
        },
      },
    });

    const failed = await retention.runOnce();

    expect(failed).toMatchObject({ deleted: 0, rolledThrough: CUTOFF - 4 * DAY });
    expect(errors.error).toHaveBeenCalledWith(
      'usage.rollup',
      expect.any(Error),
      expect.objectContaining({ cutoff: CUTOFF, rolledThrough: CUTOFF - 4 * DAY }),
    );
    expect(ids(db)).toEqual(['day0', 'day2']);
    expect(watermark(db)).toBe(CUTOFF - 4 * DAY);

    const resumed = await new UsageRetention({
      db,
      settings: makeStore(90),
      now: () => NOW,
    }).runOnce();

    expect(resumed.deleted).toBe(2);
    expect(ids(db)).toEqual([]);
    expect(watermark(db)).toBe(CUTOFF);
  });

  it('does not delete raw rows newer than the watermark after raising retention', async () => {
    const db = makeUsageDb();
    seed(db, [
      { id: 'old', createdAt: NOW - 40 * DAY },
      { id: 'newer', createdAt: NOW - 20 * DAY },
    ]);
    const lower = new UsageRetention({ db, settings: makeStore(30), now: () => NOW });
    await lower.runOnce();
    expect(ids(db)).toEqual(['newer']);
    const raisedAt = watermark(db);

    const raised = new UsageRetention({ db, settings: makeStore(90), now: () => NOW });
    const result = await raised.runOnce();

    expect(result.deleted).toBe(0);
    expect(result.rolledThrough).toBe(raisedAt);
    expect(ids(db)).toEqual(['newer']);
  });

  it('stops between rollup chunks without pruning', async () => {
    const db = makeUsageDb();
    seed(db, [
      { id: 'day0', createdAt: CUTOFF - 5 * DAY },
      { id: 'day2', createdAt: CUTOFF - 3 * DAY },
    ]);
    const retention = new UsageRetention({
      db,
      settings: makeStore(90),
      now: () => NOW,
      rollupChunkDays: 1,
    });

    const run = retention.runOnce();
    retention.stop();
    const result = await run;

    expect(result.deleted).toBe(0);
    expect(result.rolledThrough).toBe(CUTOFF - 4 * DAY);
    expect(ids(db)).toEqual(['day0', 'day2']);
  });

  it('prunes on start, hourly, and settings changes, then stops', async () => {
    vi.useFakeTimers();
    try {
      const db = makeUsageDb();
      const store = makeStore(90);
      const retention = new UsageRetention({
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
      store.patch({ usage: { retentionDays: 30 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(db)).toEqual([]);

      seed(db, [{ id: 'stopped', createdAt: NOW - 100 * DAY }]);
      retention.stop();
      retention.stop();
      await vi.advanceTimersByTimeAsync(5000);
      store.patch({ usage: { retentionDays: 10 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(db)).toEqual(['stopped']);
    } finally {
      vi.useRealTimers();
    }
  });
});
