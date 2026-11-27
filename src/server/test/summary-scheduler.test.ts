import path from 'node:path';
import { tmpDir } from './tmp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb, type Db } from '../src/db.js';
import { SettingsStore } from '../src/settings.js';
import { SummaryRepository } from '../src/summary/repository.js';
import { SummaryScheduler } from '../src/summary/scheduler.js';
import type { SpendPause } from '../src/domain/budget.js';
import type { Summary, SummaryStats } from '../src/summary/types.js';
import { SpendCapError } from '../src/usage/spend-cap.js';

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

function setup(
  generateImpl?: (cellId: string) => Promise<Summary>,
  spendCap?: (cellId: string) => SpendPause | null,
): Fixture {
  const base = tmpDir('summary-scan');
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
    ...(spendCap ? { spendCap } : {}),
  });
  return { db, cells, summaries, settings, scheduler, generate };
}

function recordAt(fixture: Fixture, cellId: string, at: number): Summary {
  vi.setSystemTime(new Date(at));
  return fixture.summaries.record({
    cellId,
    windowStart: at - INTERVAL,
    windowEnd: at,
    windowMinutes: 360,
    content: 'report',
    stats: stats(cellId, at),
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SummaryScheduler', () => {
  it('skips a paused cell and refuses a manual run without failure backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let pause: SpendPause | null = {
      scope: 'cell',
      cellId: 'cell',
      cellName: 'Alpha',
      label: 'Alpha',
      reason: 'cap_reached',
      periodStart: Date.UTC(2026, 0, 1),
      periodEnd: Date.UTC(2026, 1, 1),
      budgetUsd: 10,
      spendUsd: 10,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    };
    const fixture = setup(undefined, () => pause);
    const cell = fixture.cells.create('Alpha');
    pause = { ...(pause as SpendPause), cellId: cell.id };

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(() => fixture.scheduler.runNow(cell.id)).toThrow(SpendCapError);
    expect(fixture.scheduler.statusFor(cell.id).lastError).toBeNull();

    pause = null;
    fixture.scheduler.refresh();
    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    fixture.scheduler.stop();
  });

  it('does not set failure backoff when a cap stops a generation mid-flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const pause: SpendPause = {
      scope: 'overall',
      cellId: null,
      cellName: null,
      label: 'Overall',
      reason: 'cap_reached',
      periodStart: Date.UTC(2026, 0, 1),
      periodEnd: Date.UTC(2026, 1, 1),
      budgetUsd: 10,
      spendUsd: 10,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    };
    let attempts = 0;
    const fixture = setup(async () => {
      attempts += 1;
      throw new SpendCapError(pause);
    });
    const cell = fixture.cells.create('Alpha');

    fixture.scheduler.start();
    await flush();
    expect(attempts).toBe(1);
    expect(fixture.scheduler.statusFor(cell.id).lastError).toBeNull();
    expect(fixture.scheduler.statusFor(cell.id).nextRunAt).toBe(Date.now());

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(attempts).toBe(2);
    expect(fixture.scheduler.statusFor(cell.id).lastError).toBeNull();
    fixture.scheduler.stop();
  });

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

  it('aggregates every cell from one grouped latest-per-cell query', () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(start));
    const fixture = setup();
    const first = fixture.cells.create('Alpha');
    const second = fixture.cells.create('Beta');
    recordAt(fixture, first.id, start);
    const newest = recordAt(fixture, second.id, start + HOUR);
    vi.setSystemTime(new Date(start + 3 * HOUR));

    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');
    const require = vi.spyOn(fixture.cells, 'require');
    const list = vi.spyOn(fixture.cells, 'list');
    const get = vi.spyOn(fixture.settings, 'get');

    const status = fixture.scheduler.status();

    expect(grouped).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(require).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      enabled: true,
      intervalMinutes: 360,
      windowMinutes: 360,
      running: false,
      nextRunAt: start + INTERVAL,
      lastRunAt: newest.createdAt,
      lastError: null,
    });

    fixture.db.close();
  });

  it('skips the grouped summary query when no cells exist', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1)));
    const fixture = setup();
    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');

    expect(fixture.scheduler.status()).toMatchObject({
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      running: false,
      lastError: null,
    });
    expect(grouped).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();

    fixture.db.close();
  });

  it('treats a cell without a report as due now in grouped status', () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(now));
    const fixture = setup();
    fixture.cells.create('Alpha');
    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');

    expect(fixture.scheduler.status()).toMatchObject({
      nextRunAt: now,
      lastRunAt: null,
    });
    expect(grouped).toHaveBeenCalledTimes(1);

    fixture.db.close();
  });

  it('keeps the last run while disabled in grouped status', () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(start));
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    const report = recordAt(fixture, cell.id, start);
    fixture.settings.patch({ summary: { enabled: false } });
    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');

    expect(fixture.scheduler.status()).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastRunAt: report.createdAt,
    });
    expect(grouped).toHaveBeenCalledTimes(1);

    fixture.db.close();
  });

  it('ignores grouped reports for cells that no longer exist', () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(start));
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    recordAt(fixture, cell.id, start);
    recordAt(fixture, 'deleted-cell', start + HOUR);
    vi.setSystemTime(new Date(start + 2 * HOUR));

    expect(fixture.scheduler.status()).toMatchObject({
      nextRunAt: start + INTERVAL,
      lastRunAt: start,
      running: false,
      lastError: null,
    });

    fixture.db.close();
  });

  it('keeps statusFor on its single-cell latest lookup', () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(start));
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    const report = recordAt(fixture, cell.id, start);
    vi.setSystemTime(new Date(start + HOUR));

    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');
    const require = vi.spyOn(fixture.cells, 'require');

    expect(fixture.scheduler.statusFor(cell.id)).toMatchObject({
      nextRunAt: start + INTERVAL,
      lastRunAt: report.createdAt,
      running: false,
      lastError: null,
    });
    expect(grouped).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(cell.id);
    expect(require).toHaveBeenCalledTimes(1);
    expect(require).toHaveBeenCalledWith(cell.id);

    fixture.db.close();
  });

  it('scans due cells from one grouped latest-per-cell query', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(now));
    const fixture = setup();
    const overdue = fixture.cells.create('Overdue');
    const current = fixture.cells.create('Current');
    const missing = fixture.cells.create('Missing');
    recordAt(fixture, overdue.id, now - INTERVAL - HOUR);
    recordAt(fixture, current.id, now - HOUR);
    vi.setSystemTime(new Date(now));

    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');
    const list = vi.spyOn(fixture.cells, 'list');

    fixture.scheduler.start();
    await flush();

    expect(grouped).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(fixture.generate).toHaveBeenCalledWith(overdue.id);
    expect(fixture.generate).toHaveBeenCalledWith(missing.id);
    expect(fixture.generate).not.toHaveBeenCalledWith(current.id);

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('keeps the spend-cap skip while scanning from the grouped query', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let pausedId: string | null = null;
    const pause: SpendPause = {
      scope: 'cell',
      cellId: 'cell',
      cellName: 'Paused',
      label: 'Paused',
      reason: 'cap_reached',
      periodStart: Date.UTC(2026, 0, 1),
      periodEnd: Date.UTC(2026, 1, 1),
      budgetUsd: 10,
      spendUsd: 10,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    };
    const fixture = setup(undefined, (cellId) => (cellId === pausedId ? pause : null));
    const paused = fixture.cells.create('Paused');
    const due = fixture.cells.create('Due');
    pausedId = paused.id;

    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');

    fixture.scheduler.start();
    await flush();

    expect(grouped).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(fixture.generate).toHaveBeenCalledWith(due.id);
    expect(fixture.generate).not.toHaveBeenCalledWith(paused.id);

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('applies failure backoff across grouped scans', async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(start));
    const fixture = setup(async () => {
      throw new Error('model down');
    });
    fixture.cells.create('Alpha');

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).toHaveBeenCalledTimes(1);

    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');

    vi.setSystemTime(new Date(start + 30 * 60_000 - 1_000));
    fixture.scheduler.refresh();
    await flush();
    expect(grouped).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(fixture.generate).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(start + 30 * 60_000 + 1_000));
    fixture.scheduler.refresh();
    await flush();
    expect(grouped).toHaveBeenCalledTimes(2);
    expect(latest).not.toHaveBeenCalled();
    expect(fixture.generate).toHaveBeenCalledTimes(2);

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('skips the grouped scan on an empty board', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1)));
    const fixture = setup();
    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');
    const list = vi.spyOn(fixture.cells, 'list');

    fixture.scheduler.start();
    await flush();

    expect(list).toHaveBeenCalledTimes(1);
    expect(grouped).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(fixture.generate).not.toHaveBeenCalled();

    fixture.scheduler.stop();
    fixture.db.close();
  });

  it('ignores grouped reports for deleted cells during a scan', async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(new Date(start));
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    recordAt(fixture, cell.id, start - HOUR);
    recordAt(fixture, 'deleted-cell', start);
    vi.setSystemTime(new Date(start));

    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');

    fixture.scheduler.start();
    await flush();

    expect(grouped).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(fixture.generate).not.toHaveBeenCalled();

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
    expect(fixture.scheduler.status().running).toBe(true);

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
    const backedOffUntil = Date.now() + 30 * 60_000;
    expect(fixture.scheduler.statusFor(cell.id).nextRunAt).toBe(backedOffUntil);
    expect(fixture.scheduler.status().nextRunAt).toBe(backedOffUntil);

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
    const grouped = vi.spyOn(fixture.summaries, 'latestPerCell');
    const latest = vi.spyOn(fixture.summaries, 'latest');
    const list = vi.spyOn(fixture.cells, 'list');

    fixture.scheduler.start();
    await flush();
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(grouped).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();

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
