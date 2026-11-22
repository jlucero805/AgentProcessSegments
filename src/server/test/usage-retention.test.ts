import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { SettingsStore } from '../src/settings.js';
import { UsageRetention } from '../src/usage/retention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 31, 12);

function makeStore(days = 90): SettingsStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-usage-retention-'));
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

function seedOld(db: Db, count: number): void {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `u${String(index).padStart(5, '0')}`,
    createdAt: NOW - 100 * DAY,
  }));
  seed(db, rows);
}

describe('UsageRetention', () => {
  it('deletes rows before the cutoff and keeps the boundary row', async () => {
    const db = makeUsageDb();
    const boundary = NOW - 90 * DAY;
    seed(db, [
      { id: 'older', createdAt: boundary - 1 },
      { id: 'boundary', createdAt: boundary },
      { id: 'recent', createdAt: NOW - DAY },
    ]);
    const retention = new UsageRetention({ db, settings: makeStore(90), now: () => NOW });

    const result = await retention.runOnce();

    expect(result).toEqual({ deleted: 1, cutoff: boundary });
    expect(ids(db)).toEqual(['boundary', 'recent']);
  });

  it('keeps every row when retention is disabled', async () => {
    const db = makeUsageDb();
    seed(db, [{ id: 'old', createdAt: NOW - 1000 * DAY }]);
    const retention = new UsageRetention({ db, settings: makeStore(0), now: () => NOW });

    const result = await retention.runOnce();

    expect(result).toEqual({ deleted: 0, cutoff: null });
    expect(ids(db)).toEqual(['old']);
  });

  it('drains a backlog larger than one batch in a single run', async () => {
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

    expect(result).toEqual({ deleted: 0, cutoff: NOW - 90 * DAY });
    expect(errors.error).not.toHaveBeenCalled();
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
    });

    await expect(retention.runOnce()).resolves.toMatchObject({ deleted: 0 });
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'usage.prune',
      expect.any(Error),
      expect.objectContaining({ deleted: 0, cutoff: NOW - 90 * DAY }),
    );

    fail = false;
    await expect(retention.runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(ids(db)).toEqual([]);
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
