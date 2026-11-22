import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb, type Db } from '../src/db.js';
import { SettingsStore } from '../src/settings.js';
import { SummaryRepository } from '../src/summary/repository.js';
import { SummaryScheduler } from '../src/summary/scheduler.js';
import type { Summary, SummaryStats } from '../src/summary/types.js';

const HOUR = 60 * 60_000;
const INTERVAL = 6 * HOUR;

function stats(cellId: string, at: number): SummaryStats {
  return {
    windowStart: at - INTERVAL,
    windowEnd: at,
    windowMinutes: 360,
    cell: { id: cellId, name: 'Alpha' },
    requests: {
      total: 0,
      byState: { clarify: 0, dispatch: 0, review: 0, merge: 0, finalize: 0, done: 0, dropped: 0 },
      created: 0,
      updated: 0,
      completed: 0,
      dropped: 0,
      stalled: [],
      unchecked: 0,
      agentStatus: { none: 0, idle: 0, working: 0, blocked: 0, error: 0 },
    },
    activity: {
      cycles: 0,
      started: 0,
      prodded: 0,
      reviewed: 0,
      advanced: 0,
      followUps: 0,
      skipped: 0,
      followUpTitles: [],
      skipReasons: [],
    },
    previous: {
      created: 0,
      completed: 0,
      dropped: 0,
      activity: {
        cycles: 0,
        started: 0,
        prodded: 0,
        reviewed: 0,
        advanced: 0,
        followUps: 0,
        skipped: 0,
      },
    },
  };
}

interface Fixture {
  db: Db;
  cells: CellRepository;
  summaries: SummaryRepository;
  settings: SettingsStore;
  scheduler: SummaryScheduler;
  generate: ReturnType<typeof vi.fn>;
}

function setup(generateImpl?: (cellId: string) => Promise<Summary>): Fixture {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-summary-scan-'));
  const db = openDb(path.join(base, 'db.sqlite'));
  const cells = new CellRepository(db);
  const summaries = new SummaryRepository(db);
  const settings = new SettingsStore(path.join(base, 'config.json'));
  settings.patch({ summary: { intervalMinutes: 360, windowMinutes: 360 } });
  const generate = vi.fn(
    generateImpl ??
      (async (cellId: string) => {
        const now = Date.now();
        return summaries.record({
          cellId,
          windowStart: now - INTERVAL,
          windowEnd: now,
          windowMinutes: 360,
          content: 'report',
          stats: stats(cellId, now),
        });
      }),
  );
  const scheduler = new SummaryScheduler({
    service: { generate },
    settings,
    cells,
    summaries,
  });
  return { db, cells, summaries, settings, scheduler, generate };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SummaryScheduler', () => {
  it('catches up immediately, gates on the interval, and stops when disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(fixture.generate).toHaveBeenCalledWith(cell.id);

    const started = Date.now();
    expect(fixture.scheduler.statusFor(cell.id)).toMatchObject({
      enabled: true,
      intervalMinutes: 360,
      windowMinutes: 360,
      running: false,
      nextRunAt: started + INTERVAL,
      lastRunAt: started,
      lastError: null,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL - 60_000);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fixture.generate).toHaveBeenCalledTimes(2);

    fixture.settings.patch({ summary: { enabled: false } });
    expect(fixture.scheduler.statusFor(cell.id).nextRunAt).toBeNull();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(fixture.generate).toHaveBeenCalledTimes(2);

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('runs cells one at a time and coalesces manual runs per cell', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const pending: Array<{ cellId: string; resolve: (summary: Summary) => void }> = [];
    const release = (id: string) => {
      const index = pending.findIndex((item) => item.cellId === id);
      if (index === -1) return;
      const [item] = pending.splice(index, 1);
      if (!item) return;
      const at = Date.now();
      item.resolve({
        id: `s-${id}`,
        cellId: id,
        windowStart: at - INTERVAL,
        windowEnd: at,
        windowMinutes: 360,
        content: 'report',
        stats: stats(id, at),
        createdAt: at,
      });
    };
    const fixture = setup(
      (cellId) =>
        new Promise<Summary>((resolve) => {
          pending.push({ cellId, resolve });
        }),
    );
    const first = fixture.cells.create('Alpha');
    const second = fixture.cells.create('Beta');

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(fixture.generate).toHaveBeenCalledWith(first.id);

    const manual = fixture.scheduler.runNow(first.id);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    release(first.id);
    expect(await manual).toMatchObject({ id: `s-${first.id}` });

    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(fixture.generate).toHaveBeenLastCalledWith(second.id);
    release(second.id);
    await flush();
    expect(fixture.scheduler.status().running).toBe(false);

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('backs off a failed cell and exposes the error in status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fixture = setup(async () => {
      throw new Error('model down');
    });
    const cell = fixture.cells.create('Alpha');

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(fixture.scheduler.statusFor(cell.id).lastError).toBe('model down');
    expect(fixture.scheduler.statusFor(cell.id).nextRunAt).toBe(Date.now() + 30 * 60_000);

    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1_000);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.generate).toHaveBeenCalledTimes(2);

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('allows a manual run while automatic summaries are disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fixture = setup();
    fixture.settings.patch({ summary: { enabled: false } });
    const cell = fixture.cells.create('Alpha');

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).not.toHaveBeenCalled();

    await fixture.scheduler.runNow(cell.id);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(fixture.summaries.latest(cell.id)).not.toBeNull();

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('propagates a manual failure and backs off the next automatic attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fixture = setup(async () => {
      throw new Error('manual failed');
    });
    const cell = fixture.cells.create('Alpha');

    await expect(fixture.scheduler.runNow(cell.id)).rejects.toThrow('manual failed');
    expect(fixture.scheduler.statusFor(cell.id).lastError).toBe('manual failed');
    expect(fixture.generate).toHaveBeenCalledTimes(1);

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(1);

    fixture.scheduler.stop();
    fixture.db.close();
  });
});
