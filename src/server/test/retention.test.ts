import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { DataRetention } from '../src/retention/service.js';
import { SettingsStore } from '../src/settings.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 31, 12);

function makeStore(days = 90, summaryDays = 90): SettingsStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-activity-retention-'));
  const store = new SettingsStore(path.join(dir, 'config.json'));
  store.patch({
    retention: { masterEventsDays: days, cellSummariesDays: summaryDays },
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
    });
    expect(ids(db)).toEqual(['boundary', 'recent']);
  });

  it('keeps every row when retention is disabled', async () => {
    const db = makeDb();
    seed(db, [{ id: 'old', createdAt: NOW - 1000 * DAY }]);
    const retention = new DataRetention({ db, settings: makeStore(0, 0), now: () => NOW });

    const result = await retention.runOnce();

    expect(result).toEqual({
      masterEvents: { deleted: 0, cutoff: null },
      cellSummaries: { deleted: 0, cutoff: null },
    });
    expect(ids(db)).toEqual(['old']);
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
    const store = makeStore(0, 30);
    seed(db, [{ id: 'old-activity', createdAt: NOW - 100 * DAY }]);
    seedSummaries(db, [
      { id: 's-keep', cellId: 'A', createdAt: NOW - 100 * DAY },
      { id: 's-old', cellId: 'A', createdAt: NOW - 200 * DAY },
    ]);
    const retention = new DataRetention({ db, settings: store, now: () => NOW });

    const first = await retention.runOnce();
    expect(first.masterEvents).toEqual({ deleted: 0, cutoff: null });
    expect(first.cellSummaries.deleted).toBe(1);
    expect(ids(db)).toEqual(['old-activity']);
    expect(summaryIds(db)).toEqual(['s-keep']);

    store.patch({ retention: { masterEventsDays: 30, cellSummariesDays: 0 } });
    seed(db, [{ id: 'old-activity-2', createdAt: NOW - 100 * DAY }]);
    seedSummaries(db, [{ id: 's-newer-old', cellId: 'A', createdAt: NOW - 100 * DAY }]);

    const second = await retention.runOnce();
    expect(second.masterEvents.deleted).toBe(2);
    expect(second.cellSummaries).toEqual({ deleted: 0, cutoff: null });
    expect(ids(db)).toEqual([]);
    expect(summaryIds(db)).toEqual(['s-keep', 's-newer-old']);
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
