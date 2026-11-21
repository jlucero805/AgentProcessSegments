import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import type { Engine, LiveTurn } from '../src/clarify/engine.js';
import { openDb, type Db } from '../src/db.js';
import { MasterEventRepository } from '../src/master/events.js';
import { MasterScheduler } from '../src/master/scheduler.js';
import { MasterService } from '../src/master/service.js';
import { RequestRepository } from '../src/requests/repository.js';
import { SettingsStore } from '../src/settings.js';

interface Fixture {
  db: Db;
  repo: RequestRepository;
  cells: CellRepository;
  events: MasterEventRepository;
  settings: SettingsStore;
  engine: Engine;
  sent: Array<{ id: string; text: string }>;
  service: MasterService;
}

function setup(overrides: Record<string, unknown> = {}): Fixture {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-master-'));
  const db = openDb(path.join(base, 'db.sqlite'));
  const repo = new RequestRepository(db);
  const cells = new CellRepository(db);
  const events = new MasterEventRepository(db);
  const settings = new SettingsStore(path.join(base, 'config.json'));
  settings.patch({
    master: {
      enabled: true,
      idleMinutes: 1,
      intervalMinutes: 5,
      autoReview: true,
      includeUnassigned: true,
      ...overrides,
    },
  });

  const sent: Array<{ id: string; text: string }> = [];
  const engine = {
    hasLive: vi.fn(() => false),
    send: vi.fn(async (id: string, text: string) => {
      sent.push({ id, text });
      return { promise: Promise.resolve() } as unknown as LiveTurn;
    }),
    transcript: vi.fn(() => [
      { role: 'agent' as const, kind: 'text' as const, text: 'finished. READY FOR REVIEW', ts: 1 },
    ]),
    note: vi.fn(),
  } as unknown as Engine;

  const service = new MasterService({ repo, cells, engine, settings, events });
  return { db, repo, cells, events, settings, engine, sent, service };
}

function dispatchRequest(
  fixture: Fixture,
  title: string,
  cellId: string | null = null,
  ageMs = 10 * 60_000,
) {
  const request = fixture.repo.create({ title, cellId });
  fixture.repo.transition(request.id, 'dispatch');
  fixture.db
    .prepare("UPDATE requests SET agent_status = 'idle', updated_at = ? WHERE id = ?")
    .run(Date.now() - ageMs, request.id);
  return fixture.repo.require(request.id);
}

describe('MasterService', () => {
  it('prods an idle dispatch request and moves it to Review on the marker', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    const request = dispatchRequest(fixture, 'Build it', cell.id);

    const result = await fixture.service.runOnce();

    expect(result).toMatchObject({ prodded: 1, reviewed: 1, dispatch: 1 });
    expect(fixture.sent).toEqual([{ id: request.id, text: expect.stringContaining('cell master') }]);
    expect(fixture.repo.require(request.id).state).toBe('review');

    const actions = fixture.events.list().map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['prod', 'review', 'cycle']));
    const notes = (fixture.engine.note as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, text]) => String(text),
    );
    expect(notes.some((text) => text.includes('Prodded'))).toBe(true);
    expect(notes.some((text) => text.includes('Moved'))).toBe(true);
    expect(notes.some((text) => text.includes('Master cycle'))).toBe(true);
  });

  it('skips fresh, live, and disabled-cell queues', async () => {
    const fixture = setup({ includeUnassigned: false });
    const cell = fixture.cells.create('Busy');
    dispatchRequest(fixture, 'Fresh', cell.id, 0);
    const live = dispatchRequest(fixture, 'Live', cell.id);
    (fixture.engine.hasLive as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => id === live.id,
    );

    const result = await fixture.service.runOnce();
    expect(result.prodded).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.dispatch).toBe(2);

    fixture.cells.setMasterEnabled(cell.id, false);
    const disabled = await fixture.service.runOnce();
    expect(disabled.dispatch).toBe(0);
    expect(fixture.sent).toHaveLength(0);
  });

  it('does not prod the same request twice inside the interval', async () => {
    const fixture = setup({ autoReview: false });
    const cell = fixture.cells.create('Gap');
    const request = dispatchRequest(fixture, 'Once', cell.id);

    expect((await fixture.service.runOnce()).prodded).toBe(1);
    expect(fixture.repo.require(request.id).state).toBe('dispatch');

    const second = await fixture.service.runOnce();
    expect(second.prodded).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('leaves work in dispatch without autoReview or the marker', async () => {
    const noAuto = setup({ autoReview: false });
    const cell = noAuto.cells.create('No auto');
    const request = dispatchRequest(noAuto, 'Manual review', cell.id);
    expect((await noAuto.service.runOnce()).reviewed).toBe(0);
    expect(noAuto.repo.require(request.id).state).toBe('dispatch');

    const noMarker = setup();
    (noMarker.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'agent', kind: 'text', text: 'still working', ts: 1 },
    ]);
    const other = dispatchRequest(noMarker, 'Not ready', noMarker.cells.create('Other').id);
    expect((await noMarker.service.runOnce()).reviewed).toBe(0);
    expect(noMarker.repo.require(other.id).state).toBe('dispatch');
  });

  it('includes unassigned work only when configured', async () => {
    const excluded = setup({ includeUnassigned: false });
    dispatchRequest(excluded, 'Unassigned');
    expect((await excluded.service.runOnce()).prodded).toBe(0);

    const included = setup({ includeUnassigned: true });
    dispatchRequest(included, 'Unassigned');
    expect((await included.service.runOnce()).prodded).toBe(1);
  });

  it('records a skip event when sending the prod fails', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Broken');
    dispatchRequest(fixture, 'Explodes', cell.id);
    (fixture.engine.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session gone'));

    const result = await fixture.service.runOnce();
    expect(result.skipped).toBe(1);
    const skip = fixture.events.list().find((event) => event.action === 'skip');
    expect(skip?.detail).toContain('session gone');
  });
});

describe('MasterScheduler', () => {
  it('runs on the configured cadence and stops when disabled', async () => {
    vi.useFakeTimers();
    try {
      const settings = new SettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'sbox-sched-')), 'config.json'));
      const runOnce = vi.fn(async () => ({
        ranAt: Date.now(),
        cells: 0,
        dispatch: 0,
        prodded: 0,
        reviewed: 0,
        skipped: 0,
      }));
      const service = {
        runOnce,
        lastRunAt: null,
        lastResult: null,
      } as unknown as MasterService;
      const scheduler = new MasterScheduler(service, settings);
      scheduler.start();

      expect(scheduler.status()).toMatchObject({
        enabled: true,
        intervalMinutes: 5,
        running: false,
      });
      expect(scheduler.status().nextRunAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(runOnce).toHaveBeenCalledTimes(1);

      settings.patch({ master: { enabled: false } });
      expect(scheduler.status().nextRunAt).toBeNull();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(runOnce).toHaveBeenCalledTimes(1);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent run-now calls', async () => {
    const settings = new SettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'sbox-sched-')), 'config.json'));
    let release!: (value: unknown) => void;
    const result = { ranAt: 1, cells: 0, dispatch: 0, prodded: 0, reviewed: 0, skipped: 0 };
    const runOnce = vi.fn(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    const scheduler = new MasterScheduler(
      { runOnce, lastRunAt: null, lastResult: null } as unknown as MasterService,
      settings,
    );

    const first = scheduler.runNow();
    const second = scheduler.runNow();
    expect(runOnce).toHaveBeenCalledTimes(1);
    release(result);
    expect(await first).toBe(result);
    expect(await second).toBe(result);
  });
});
