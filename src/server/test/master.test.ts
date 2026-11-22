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
import { defaultProcess, READY_FOR_IMPLEMENTATION } from '../src/process/defaults.js';
import type { ProcessConfig } from '../src/process/definition.js';
import type { ProcessStore } from '../src/process/store.js';
import { RequestRepository } from '../src/requests/repository.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings.js';

interface Fixture {
  db: Db;
  repo: RequestRepository;
  cells: CellRepository;
  events: MasterEventRepository;
  settings: SettingsStore;
  engine: Engine;
  sent: Array<{ id: string; text: string }>;
  started: string[];
  startTexts: Array<{ id: string; text: string }>;
  turns: Array<{ action: 'start' | 'send'; id: string }>;
  service: MasterService;
}

function setup(overrides: Record<string, unknown> = {}, processConfig?: ProcessConfig): Fixture {
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
  const started: string[] = [];
  const startTexts: Array<{ id: string; text: string }> = [];
  const turns: Array<{ action: 'start' | 'send'; id: string }> = [];
  const turn = () => ({ promise: Promise.resolve() }) as unknown as LiveTurn;
  const engine = {
    hasLive: vi.fn(() => false),
    start: vi.fn(async (id: string, text = '') => {
      started.push(id);
      startTexts.push({ id, text });
      turns.push({ action: 'start', id });
      return turn();
    }),
    send: vi.fn(async (id: string, text: string) => {
      sent.push({ id, text });
      turns.push({ action: 'send', id });
      return turn();
    }),
    transcript: vi.fn(() => [
      { role: 'agent' as const, kind: 'text' as const, text: 'finished. READY FOR REVIEW', ts: 1 },
    ]),
    note: vi.fn(),
  } as unknown as Engine;

  const process = processConfig
    ? ({ get: () => processConfig } as unknown as ProcessStore)
    : undefined;
  const service = new MasterService({ repo, cells, engine, settings, events, process });
  return { db, repo, cells, events, settings, engine, sent, started, startTexts, turns, service };
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

function processFor(mutate: (process: ProcessConfig) => void): ProcessConfig {
  const process = defaultProcess(DEFAULT_SETTINGS.master);
  for (const segment of process.segments) segment.followUps = { ...segment.followUps };
  mutate(process);
  return process;
}

function segment(process: ProcessConfig, id: ProcessConfig['segments'][number]['id']) {
  const found = process.segments.find((item) => item.id === id);
  if (!found) throw new Error(`missing segment ${id}`);
  return found;
}

function age(fixture: Fixture, requestId: string, ageMs: number): void {
  const at = Date.now() - ageMs;
  fixture.db.prepare('UPDATE requests SET updated_at = ? WHERE id = ?').run(at, requestId);
  fixture.db.prepare('UPDATE master_events SET created_at = ? WHERE request_id = ?').run(at, requestId);
}

function setStartDate(fixture: Fixture, requestId: string, at: number): void {
  fixture.db.prepare('UPDATE requests SET created_at = ? WHERE id = ?').run(at, requestId);
}

function requestInState(
  fixture: Fixture,
  title: string,
  state: string,
  cellId: string | null,
  ageMs = 10 * 60_000,
) {
  const request = fixture.repo.create({ title, cellId });
  fixture.db
    .prepare(
      "UPDATE requests SET state = ?, clarify_started = 1, agent_status = 'idle', updated_at = ? WHERE id = ?",
    )
    .run(state, Date.now() - ageMs, request.id);
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
    expect(result.dispatch).toBe(0);

    fixture.cells.setMasterEnabled(cell.id, false);
    const disabled = await fixture.service.runOnce();
    expect(disabled.dispatch).toBe(0);
    expect(fixture.sent).toHaveLength(0);
  });

  it('does not treat viewing a request as activity', async () => {
    const fixture = setup();
    const request = dispatchRequest(fixture, 'Viewed');

    // What POST /api/requests/:id/seen does when the drawer opens.
    fixture.repo.setUnchecked(request.id, false);

    const result = await fixture.service.runOnce();
    expect(result.prodded).toBe(1);
  });

  it('selects at most the cell concurrency from the latest segments, oldest first', async () => {
    const process = processFor((config) => {
      for (const id of ['intake', 'plan', 'implement', 'review'] as const) {
        const item = segment(config, id);
        item.enabled = true;
        item.idleMinutes = 1;
        item.maxPerCycle = 10;
        item.maxConcurrent = null;
      }
      const review = segment(config, 'review');
      review.readyMarker = null;
      review.advanceTo = null;
    });
    const fixture = setup({ includeUnassigned: false }, process);
    const cell = fixture.cells.create('Bounded', null, null, { maxConcurrent: 5 });

    const review = requestInState(fixture, 'Review it', 'review', cell.id);
    const implementing = [
      dispatchRequest(fixture, 'Implement oldest', cell.id),
      dispatchRequest(fixture, 'Implement middle', cell.id),
      dispatchRequest(fixture, 'Implement newest', cell.id),
    ];
    const planningOld = fixture.repo.create({ title: 'Plan oldest', cellId: cell.id });
    fixture.repo.setClarifyStarted(planningOld.id, true);
    age(fixture, planningOld.id, 3 * 60_000);
    const planningNew = fixture.repo.create({ title: 'Plan newest', cellId: cell.id });
    fixture.repo.setClarifyStarted(planningNew.id, true);
    age(fixture, planningNew.id, 2 * 60_000);

    const base = Date.now() - 60 * 60_000;
    setStartDate(fixture, implementing[0]!.id, base + 1_000);
    setStartDate(fixture, implementing[1]!.id, base + 2_000);
    setStartDate(fixture, implementing[2]!.id, base + 3_000);
    setStartDate(fixture, planningOld.id, base + 1_000);
    setStartDate(fixture, planningNew.id, base + 3_000);

    const result = await fixture.service.runOnce();

    expect(result.dispatch).toBe(5);
    expect(result.prodded).toBe(5);
    expect(fixture.turns).toEqual([
      { action: 'send', id: review.id },
      { action: 'send', id: implementing[0]!.id },
      { action: 'send', id: implementing[1]!.id },
      { action: 'send', id: implementing[2]!.id },
      { action: 'send', id: planningOld.id },
    ]);
    expect(fixture.repo.require(planningNew.id).state).toBe('clarify');
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

  it('starts unplanned intake requests when the segment is enabled', async () => {
    const process = processFor((config) => {
      const intake = segment(config, 'intake');
      intake.enabled = true;
      intake.idleMinutes = 1;
      intake.prompt = 'This cell works in the AgentProcessSegments repository.';
    });
    const fixture = setup({}, process);
    const request = fixture.repo.create({ title: 'Raw request' });
    age(fixture, request.id, 2 * 60_000);

    const result = await fixture.service.runOnce();

    expect(result.started).toBe(1);
    expect(fixture.started).toEqual([request.id]);
    expect(fixture.startTexts[0]?.text).toContain('AgentProcessSegments repository');
    expect(fixture.events.list().some((event) => event.action === 'start')).toBe(true);
  });

  it('advances a planned request when the plan segment reports the marker', async () => {
    const process = processFor((config) => {
      const plan = segment(config, 'plan');
      plan.enabled = true;
      plan.idleMinutes = 1;
      segment(config, 'implement').enabled = false;
    });
    const fixture = setup({}, process);
    const request = fixture.repo.create({ title: 'Plan me' });
    fixture.repo.setClarifyStarted(request.id, true);
    age(fixture, request.id, 2 * 60_000);
    (fixture.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'agent', kind: 'text', text: `planned. ${READY_FOR_IMPLEMENTATION}`, ts: 1 },
    ]);

    const result = await fixture.service.runOnce();

    expect(result.advanced).toBe(1);
    expect(fixture.repo.require(request.id).state).toBe('dispatch');
    expect(fixture.sent[0]?.text).toContain('Continue grooming');
    expect(fixture.events.list().some((event) => event.action === 'advance')).toBe(true);
  });

  it('runs finishing segments before planning and intake work', async () => {
    const process = processFor((config) => {
      for (const id of ['intake', 'plan', 'implement'] as const) {
        const item = segment(config, id);
        item.enabled = true;
        item.idleMinutes = 1;
      }
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('Pipeline');
    const implementing = dispatchRequest(fixture, 'Implementing', cell.id);
    const planning = fixture.repo.create({ title: 'Planning', cellId: cell.id });
    fixture.repo.setClarifyStarted(planning.id, true);
    age(fixture, planning.id, 2 * 60_000);
    const raw = fixture.repo.create({ title: 'Raw request', cellId: cell.id });
    age(fixture, raw.id, 2 * 60_000);

    const result = await fixture.service.runOnce();

    expect(result.prodded).toBe(2);
    expect(result.started).toBe(1);
    expect(fixture.turns).toEqual([
      { action: 'send', id: implementing.id },
      { action: 'send', id: planning.id },
      { action: 'start', id: raw.id },
    ]);
  });

  it('uses a cell’s own process instead of the global template', async () => {
    const global = processFor((config) => {
      segment(config, 'intake').enabled = false;
      segment(config, 'implement').enabled = true;
    });
    const cellProcess = processFor((config) => {
      const intake = segment(config, 'intake');
      intake.enabled = true;
      intake.idleMinutes = 1;
      segment(config, 'implement').enabled = false;
    });
    const fixture = setup({ includeUnassigned: false }, global);
    const cell = fixture.cells.create('Strict repo', cellProcess);
    const intakeRequest = fixture.repo.create({ title: 'Raw in cell', cellId: cell.id });
    age(fixture, intakeRequest.id, 2 * 60_000);
    const dispatch = dispatchRequest(fixture, 'Build in cell', cell.id);

    const result = await fixture.service.runOnce();

    expect(result.started).toBe(1);
    expect(fixture.started).toEqual([intakeRequest.id]);
    expect(result.prodded).toBe(0);
    expect(fixture.repo.require(dispatch.id).state).toBe('dispatch');
    const notes = (fixture.engine.note as ReturnType<typeof vi.fn>).mock.calls;
    expect(notes.some(([session]) => session === `__master__:${cell.id}`)).toBe(true);
    expect(notes.every(([session]) => session !== '__master__')).toBe(true);
  });

  it('respects a cell concurrency cap before prodding more work', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Limited', null, null, { maxConcurrent: 1 });
    const working = fixture.repo.create({ title: 'Already working', cellId: cell.id });
    fixture.repo.setAgentStatus(working.id, 'working');
    const request = dispatchRequest(fixture, 'Wait', cell.id);

    const blocked = await fixture.service.runOnce();
    expect(blocked.prodded).toBe(0);
    expect(
      fixture.events.list().some((event) => event.detail.includes('concurrency limit')),
    ).toBe(true);
    expect(fixture.repo.require(request.id).state).toBe('dispatch');

    fixture.repo.setAgentStatus(working.id, 'idle');
    age(fixture, request.id, 2 * 60_000);
    const allowed = await fixture.service.runOnce();
    expect(allowed.prodded).toBe(1);
  });

  it('serializes a merge segment with its own concurrency cap', async () => {
    const process = processFor((config) => {
      segment(config, 'implement').enabled = false;
      const merge = segment(config, 'merge');
      merge.enabled = true;
      merge.idleMinutes = 1;
      merge.maxPerCycle = 1;
      merge.maxConcurrent = 1;
      merge.readyMarker = null;
      merge.advanceTo = null;
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('Merge cell', null, null, { maxConcurrent: 5 });
    const working = requestInState(fixture, 'Merging now', 'merge', cell.id);
    fixture.repo.setAgentStatus(working.id, 'working');
    const waiting = requestInState(fixture, 'Next merge', 'merge', cell.id);

    const blocked = await fixture.service.runOnce();
    expect(blocked.prodded).toBe(0);
    expect(
      fixture.events.list().some((event) => event.detail.includes('segment concurrency limit')),
    ).toBe(true);

    fixture.repo.setAgentStatus(working.id, 'idle');
    age(fixture, waiting.id, 2 * 60_000);
    const allowed = await fixture.service.runOnce();
    expect(allowed.prodded).toBe(1);
  });

  it('creates follow-up requests once per unique callout', async () => {
    const process = processFor((config) => {
      const implement = segment(config, 'implement');
      implement.idleMinutes = 1;
      implement.readyMarker = null;
      implement.advanceTo = null;
      implement.followUps.enabled = true;
    });
    const fixture = setup({}, process);
    const request = dispatchRequest(fixture, 'Build it');
    (fixture.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        role: 'agent',
        kind: 'text',
        text: ['Done.', 'FOLLOW-UP: Add metrics', '- FOLLOW-UP: Add metrics', 'FOLLOW-UP: Write docs'].join(
          '\n',
        ),
        ts: 1,
      },
    ]);

    const first = await fixture.service.runOnce();
    expect(first.followUps).toBe(2);
    const created = fixture.repo
      .list()
      .filter((item) => item.title === 'Add metrics' || item.title === 'Write docs');
    expect(created).toHaveLength(2);
    expect(fixture.events.list().filter((event) => event.action === 'followup')).toHaveLength(2);

    age(fixture, request.id, 2 * 60_000);
    const second = await fixture.service.runOnce();
    expect(second.followUps).toBe(0);
    expect(
      fixture.repo.list().filter((item) => item.title === 'Add metrics' || item.title === 'Write docs'),
    ).toHaveLength(2);
  });
});

describe('MasterScheduler', () => {
  function emptyResult() {
    return {
      ranAt: Date.now(),
      cells: 0,
      dispatch: 0,
      started: 0,
      prodded: 0,
      reviewed: 0,
      advanced: 0,
      followUps: 0,
      skipped: 0,
    };
  }

  it('runs a cell on its own interval and stops when disabled', async () => {
    vi.useFakeTimers();
    try {
      const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-sched-'));
      const settings = new SettingsStore(path.join(base, 'config.json'));
      settings.patch({ master: { includeUnassigned: false } });
      const cells = new CellRepository(openDb(path.join(base, 'db.sqlite')));
      const cell = cells.create('Alpha', null, 2);
      const runCell = vi.fn(async () => emptyResult());
      const service = {
        runOnce: vi.fn(async () => emptyResult()),
        runCell,
        runUnassigned: vi.fn(async () => emptyResult()),
        lastRunAt: null,
        lastResult: null,
        lastFor: vi.fn(() => null),
      } as unknown as MasterService;
      const scheduler = new MasterScheduler(service, settings, cells);
      scheduler.start();

      expect(scheduler.statusFor(cell.id)).toMatchObject({
        enabled: true,
        intervalMinutes: 2,
        running: false,
      });
      expect(scheduler.statusFor(cell.id).nextRunAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runCell).toHaveBeenCalledWith(cell.id);

      settings.patch({ master: { enabled: false } });
      expect(scheduler.statusFor(cell.id).nextRunAt).toBeNull();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runCell).toHaveBeenCalledTimes(1);

      scheduler.stop();
      cells.list();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent run-now calls', async () => {
    const settings = new SettingsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'sbox-sched-')), 'config.json'));
    let release!: (value: unknown) => void;
    const result = emptyResult();
    const runOnce = vi.fn(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    const scheduler = new MasterScheduler(
      {
        runOnce,
        runCell: vi.fn(),
        runUnassigned: vi.fn(),
        lastRunAt: null,
        lastResult: null,
        lastFor: vi.fn(() => null),
      } as unknown as MasterService,
      settings,
      new CellRepository(openDb(':memory:')),
    );

    const first = scheduler.runNow();
    const second = scheduler.runNow();
    expect(runOnce).toHaveBeenCalledTimes(1);
    release(result);
    expect(await first).toBe(result);
    expect(await second).toBe(result);
  });
});
