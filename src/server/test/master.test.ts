import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import type { Engine, LiveTurn } from '../src/clarify/engine.js';
import { openDb, type Db } from '../src/db.js';
import { MasterEventRepository } from '../src/master/events.js';
import { MasterScheduler } from '../src/master/scheduler.js';
import { MasterService } from '../src/master/service.js';
import type { SpendPause } from '../src/domain/budget.js';
import type { MasterErrorNotification } from '../src/domain/notifications.js';
import type { MasterResult } from '../src/master/types.js';
import { defaultProcess, READY_FOR_IMPLEMENTATION } from '../src/process/defaults.js';
import type { ProcessConfig } from '../src/process/definition.js';
import type { ProcessStore } from '../src/process/store.js';
import { RequestRepository } from '../src/requests/repository.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { SpendCapError } from '../src/usage/spend-cap.js';

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
  masterErrors: MasterErrorNotification[];
  service: MasterService;
  setTurnStoppedBy: (pause: SpendPause | null) => void;
}

function setup(
  overrides: Record<string, unknown> = {},
  processConfig?: ProcessConfig,
  spendCap?: (cellId: string) => SpendPause | null,
  errors?: ErrorSink,
): Fixture {
  const base = tmpDir('master');
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
      ...overrides,
    },
  });

  const sent: Array<{ id: string; text: string }> = [];
  const started: string[] = [];
  const startTexts: Array<{ id: string; text: string }> = [];
  const turns: Array<{ action: 'start' | 'send'; id: string }> = [];
  let turnStoppedBy: SpendPause | null = null;
  const masterErrors: MasterErrorNotification[] = [];
  const turn = () =>
    ({ promise: Promise.resolve(), stoppedBy: turnStoppedBy }) as unknown as LiveTurn;
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
  const service = new MasterService({
    repo,
    cells,
    engine,
    settings,
    events,
    process,
    ...(spendCap ? { spendCap } : {}),
    ...(errors ? { errors } : {}),
    onMasterError: (event) => masterErrors.push(event),
  });
  return {
    db,
    repo,
    cells,
    events,
    settings,
    engine,
    sent,
    started,
    startTexts,
    turns,
    masterErrors,
    service,
    setTurnStoppedBy: (pause) => {
      turnStoppedBy = pause;
    },
  };
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

/** Let background turn settlements run after the light cycle returns. */
async function settleMaster(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Test-only equivalent of the old run-all: one pass over every enabled cell. */
async function runEnabledCells(fixture: Fixture) {
  const results = [];
  for (const cell of fixture.cells.list()) {
    if (!cell.masterEnabled) continue;
    results.push(await fixture.service.runCell(cell.id));
  }
  await settleMaster();

  const total = {
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
  for (const result of results) {
    total.cells += result.cells;
    total.dispatch += result.dispatch;
    total.started += result.started;
    total.prodded += result.prodded;
    total.reviewed += result.reviewed;
    total.advanced += result.advanced;
    total.followUps += result.followUps;
    total.skipped += result.skipped;
  }
  return total;
}

describe('MasterService', () => {
  it('prods an idle dispatch request and moves it to Review on the marker', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    const request = dispatchRequest(fixture, 'Build it', cell.id);

    const result = await runEnabledCells(fixture);

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

  it('reports a master turn failure and ignores an expected spend refusal', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    const request = dispatchRequest(fixture, 'Will fail', cell.id);
    (fixture.engine.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('spawn failed'),
    );

    await runEnabledCells(fixture);

    expect(fixture.masterErrors).toHaveLength(1);
    expect(fixture.masterErrors[0]).toMatchObject({
      source: 'master.turn',
      cellId: cell.id,
      requestId: request.id,
      segment: 'implement',
    });

    const second = setup();
    const secondCell = second.cells.create('Capped');
    dispatchRequest(second, 'Capped request', secondCell.id);
    (second.engine.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new SpendCapError({
        scope: 'cell',
        cellId: secondCell.id,
        cellName: secondCell.name,
        label: secondCell.name,
        periodStart: Date.now(),
        periodEnd: Date.now() + 1,
        budgetUsd: 1,
        spendUsd: 2,
        spendIsLowerBound: false,
        unpricedTurns: 0,
        percentUsed: 200,
      }),
    );

    await runEnabledCells(second);
    expect(second.masterErrors).toHaveLength(0);
  });

  it('reports a failure in the completion handler', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Alpha');
    const request = dispatchRequest(fixture, 'Settle fails', cell.id);
    (fixture.engine.transcript as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('transcript unreadable');
    });

    await runEnabledCells(fixture);
    await settleMaster();

    expect(fixture.masterErrors).toHaveLength(1);
    expect(fixture.masterErrors[0]).toMatchObject({
      source: 'master.turn',
      cellId: cell.id,
      requestId: request.id,
      segment: 'implement',
    });
  });

  it('skips fresh, live, and disabled-cell queues', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Busy');
    dispatchRequest(fixture, 'Fresh', cell.id, 0);
    const live = dispatchRequest(fixture, 'Live', cell.id);
    (fixture.engine.hasLive as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => id === live.id,
    );

    const result = await runEnabledCells(fixture);
    expect(result.prodded).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.dispatch).toBe(0);

    fixture.cells.setMasterEnabled(cell.id, false);
    const disabled = await runEnabledCells(fixture);
    expect(disabled.dispatch).toBe(0);
    expect(fixture.sent).toHaveLength(0);
  });

  it('does not treat viewing a request as activity', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Viewed cell');
    const request = dispatchRequest(fixture, 'Viewed', cell.id);

    // What POST /api/requests/:id/seen does when the drawer opens.
    fixture.repo.setUnchecked(request.id, false);

    const result = await runEnabledCells(fixture);
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
    const fixture = setup({}, process);
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

    const result = await runEnabledCells(fixture);

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

  it('starts the whole selected batch and returns before any turn settles', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Parallel', null, null, { maxConcurrent: 4 });
    dispatchRequest(fixture, 'One', cell.id);
    dispatchRequest(fixture, 'Two', cell.id);
    dispatchRequest(fixture, 'Three', cell.id);

    const pending: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    (fixture.engine.send as ReturnType<typeof vi.fn>).mockImplementation(
      async (): Promise<LiveTurn> => {
        active += 1;
        peak = Math.max(peak, active);
        return {
          promise: new Promise<void>((resolve) => {
            pending.push(() => {
              active -= 1;
              resolve();
            });
          }),
        } as unknown as LiveTurn;
      },
    );

    const result = await fixture.service.runCell(cell.id);

    expect(result.dispatch).toBe(3);
    expect(result.prodded).toBe(3);
    expect(pending).toHaveLength(3);
    expect(peak).toBe(3);

    for (const release of pending) release();
    await settleMaster();
  });

  it('does not prod the same request twice inside the interval', async () => {
    const fixture = setup({ autoReview: false });
    const cell = fixture.cells.create('Gap');
    const request = dispatchRequest(fixture, 'Once', cell.id);

    expect((await runEnabledCells(fixture)).prodded).toBe(1);
    expect(fixture.repo.require(request.id).state).toBe('dispatch');

    const second = await runEnabledCells(fixture);
    expect(second.prodded).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('leaves work in dispatch without autoReview or the marker', async () => {
    const noAuto = setup({ autoReview: false });
    const cell = noAuto.cells.create('No auto');
    const request = dispatchRequest(noAuto, 'Manual review', cell.id);
    expect((await runEnabledCells(noAuto)).reviewed).toBe(0);
    expect(noAuto.repo.require(request.id).state).toBe('dispatch');

    const noMarker = setup();
    (noMarker.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'agent', kind: 'text', text: 'still working', ts: 1 },
    ]);
    const other = dispatchRequest(noMarker, 'Not ready', noMarker.cells.create('Other').id);
    expect((await runEnabledCells(noMarker)).reviewed).toBe(0);
    expect(noMarker.repo.require(other.id).state).toBe('dispatch');
  });

  it('leaves requests without a cell untouched', async () => {
    const fixture = setup();
    const request = dispatchRequest(fixture, 'Unassigned');
    const cell = fixture.cells.create('Alpha');

    const result = await fixture.service.runCell(cell.id);

    expect(result.prodded).toBe(0);
    expect(fixture.sent).toHaveLength(0);
    expect(fixture.started).toHaveLength(0);
    expect(fixture.events.list().filter((event) => event.requestId === request.id)).toHaveLength(0);
    expect(fixture.repo.require(request.id).state).toBe('dispatch');
  });

  it('keeps each cell to its own requests when every cell runs', async () => {
    const fixture = setup();
    const alpha = fixture.cells.create('Alpha');
    const beta = fixture.cells.create('Beta');
    const alphaRequest = dispatchRequest(fixture, 'Alpha work', alpha.id);
    const betaRequest = dispatchRequest(fixture, 'Beta work', beta.id);

    const result = await runEnabledCells(fixture);

    expect(result.prodded).toBe(2);
    expect(fixture.sent.map((call) => call.id).sort()).toEqual(
      [alphaRequest.id, betaRequest.id].sort(),
    );
    expect(fixture.turns).toHaveLength(2);
    const events = fixture.events.list();
    expect(events.filter((event) => event.requestId === alphaRequest.id).every(
      (event) => event.cellId === alpha.id,
    )).toBe(true);
    expect(events.filter((event) => event.requestId === betaRequest.id).every(
      (event) => event.cellId === beta.id,
    )).toBe(true);
    const notes = (fixture.engine.note as ReturnType<typeof vi.fn>).mock.calls;
    expect(notes.every(([session]) => session !== '__master__')).toBe(true);
  });

  it('does not prod a request reassigned after the queue snapshot', async () => {
    const fixture = setup();
    const alpha = fixture.cells.create('Alpha');
    const beta = fixture.cells.create('Beta');
    const request = dispatchRequest(fixture, 'Moved work', alpha.id);
    const original = fixture.repo.list.bind(fixture.repo);
    let moved = false;
    vi.spyOn(fixture.repo, 'list').mockImplementation((filter = {}) => {
      const rows = original(filter);
      if (!moved && filter.cellId === alpha.id) {
        moved = true;
        fixture.repo.edit(request.id, { cellId: beta.id });
      }
      return rows;
    });

    const result = await fixture.service.runCell(alpha.id);

    expect(moved).toBe(true);
    expect(result.prodded).toBe(0);
    expect(fixture.turns).toHaveLength(0);
    expect(fixture.events.list().filter((event) => event.requestId === request.id)).toHaveLength(0);
    expect(fixture.repo.require(request.id)).toMatchObject({
      state: 'dispatch',
      cellId: beta.id,
    });
  });

  it('records a skip event when sending the prod fails', async () => {
    const fixture = setup();
    const cell = fixture.cells.create('Broken');
    dispatchRequest(fixture, 'Explodes', cell.id);
    (fixture.engine.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session gone'));

    const result = await runEnabledCells(fixture);
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
    const cell = fixture.cells.create('Intake cell');
    const request = fixture.repo.create({ title: 'Raw request', cellId: cell.id });
    age(fixture, request.id, 2 * 60_000);

    const result = await runEnabledCells(fixture);

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
    const cell = fixture.cells.create('Plan cell');
    const request = fixture.repo.create({ title: 'Plan me', cellId: cell.id });
    fixture.repo.setClarifyStarted(request.id, true);
    age(fixture, request.id, 2 * 60_000);
    (fixture.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'agent', kind: 'text', text: `planned. ${READY_FOR_IMPLEMENTATION}`, ts: 1 },
    ]);

    const result = await runEnabledCells(fixture);

    expect(result.advanced).toBe(1);
    expect(fixture.repo.require(request.id).state).toBe('dispatch');
    expect(fixture.sent[0]?.text).toContain('Continue grooming');
    expect(fixture.events.list().some((event) => event.action === 'advance')).toBe(true);
  });

  it('never prods finalize even when the segment is enabled', async () => {
    const process = processFor((config) => {
      segment(config, 'implement').enabled = false;
      const finalize = segment(config, 'finalize');
      finalize.enabled = true;
      finalize.idleMinutes = 1;
      finalize.maxPerCycle = 10;
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('Finalize gate');
    const first = requestInState(fixture, 'Index me', 'finalize', cell.id);
    const second = requestInState(fixture, 'Index me too', 'finalize', cell.id);

    const result = await runEnabledCells(fixture);

    expect(result).toMatchObject({ dispatch: 0, prodded: 0, started: 0 });
    expect(fixture.turns).toEqual([]);
    expect(fixture.sent).toEqual([]);
    expect(fixture.started).toEqual([]);
    expect(fixture.events.list().filter((event) => event.requestId !== null)).toEqual([]);
    expect(fixture.engine.note).not.toHaveBeenCalled();
    expect(fixture.repo.require(first.id).state).toBe('finalize');
    expect(fixture.repo.require(second.id).state).toBe('finalize');
  });

  it('does not let an enabled finalize backlog take the cell concurrency', async () => {
    const process = processFor((config) => {
      const implement = segment(config, 'implement');
      implement.enabled = true;
      implement.idleMinutes = 1;
      implement.readyMarker = null;
      implement.advanceTo = null;
      const finalize = segment(config, 'finalize');
      finalize.enabled = true;
      finalize.idleMinutes = 1;
      finalize.maxPerCycle = 10;
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('Gate and build', null, null, { maxConcurrent: 1 });
    const waitingToIndex = requestInState(fixture, 'Index first', 'finalize', cell.id);
    const implementing = dispatchRequest(fixture, 'Build now', cell.id);

    const result = await runEnabledCells(fixture);

    expect(result).toMatchObject({ dispatch: 1, prodded: 1 });
    expect(fixture.sent.map((call) => call.id)).toEqual([implementing.id]);
    expect(
      fixture.events.list().filter((event) => event.requestId === waitingToIndex.id),
    ).toEqual([]);
    expect(fixture.repo.require(waitingToIndex.id).state).toBe('finalize');
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

    const result = await runEnabledCells(fixture);

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
    const fixture = setup({}, global);
    const cell = fixture.cells.create('Strict repo', cellProcess);
    const intakeRequest = fixture.repo.create({ title: 'Raw in cell', cellId: cell.id });
    age(fixture, intakeRequest.id, 2 * 60_000);
    const dispatch = dispatchRequest(fixture, 'Build in cell', cell.id);

    const result = await runEnabledCells(fixture);

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

    const blocked = await runEnabledCells(fixture);
    expect(blocked.prodded).toBe(0);
    expect(
      fixture.events.list().some((event) => event.detail.includes('concurrency limit')),
    ).toBe(true);
    expect(fixture.repo.require(request.id).state).toBe('dispatch');

    fixture.repo.setAgentStatus(working.id, 'idle');
    age(fixture, request.id, 2 * 60_000);
    const allowed = await runEnabledCells(fixture);
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

    const blocked = await runEnabledCells(fixture);
    expect(blocked.prodded).toBe(0);
    expect(
      fixture.events.list().some((event) => event.detail.includes('segment concurrency limit')),
    ).toBe(true);

    fixture.repo.setAgentStatus(working.id, 'idle');
    age(fixture, waiting.id, 2 * 60_000);
    const allowed = await runEnabledCells(fixture);
    expect(allowed.prodded).toBe(1);
  });

  it('selects only the segment cap in one parallel batch', async () => {
    const process = processFor((config) => {
      segment(config, 'implement').enabled = false;
      const merge = segment(config, 'merge');
      merge.enabled = true;
      merge.idleMinutes = 1;
      merge.maxPerCycle = 10;
      merge.maxConcurrent = 1;
      merge.readyMarker = null;
      merge.advanceTo = null;
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('One merge', null, null, { maxConcurrent: 5 });
    requestInState(fixture, 'First merge', 'merge', cell.id);
    requestInState(fixture, 'Second merge', 'merge', cell.id);

    const result = await runEnabledCells(fixture);

    expect(result.prodded).toBe(1);
    expect(fixture.turns).toHaveLength(1);
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
    const cell = fixture.cells.create('Follow-up cell');
    const request = dispatchRequest(fixture, 'Build it', cell.id);
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

    const first = await runEnabledCells(fixture);
    expect(first.followUps).toBe(2);
    const created = fixture.repo
      .list()
      .filter((item) => item.title === 'Add metrics' || item.title === 'Write docs');
    expect(created).toHaveLength(2);
    expect(created.every((item) => item.cellId === cell.id)).toBe(true);
    expect(created.every((item) => item.harness === null)).toBe(true);
    expect(created.every((item) => item.targetRepo === null)).toBe(true);
    expect(fixture.events.list().filter((event) => event.action === 'followup')).toHaveLength(2);

    age(fixture, request.id, 2 * 60_000);
    const second = await runEnabledCells(fixture);
    expect(second.followUps).toBe(0);
    expect(
      fixture.repo.list().filter((item) => item.title === 'Add metrics' || item.title === 'Write docs'),
    ).toHaveLength(2);
  });

  it('does not resurrect activity when a cell is deleted before a turn settles', async () => {
    const process = processFor((config) => {
      const implement = segment(config, 'implement');
      implement.idleMinutes = 1;
      implement.readyMarker = null;
      implement.advanceTo = null;
      implement.followUps.enabled = true;
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('Doomed');
    dispatchRequest(fixture, 'Build it', cell.id);

    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    (fixture.engine.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promise,
    } as LiveTurn);
    (fixture.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'agent', kind: 'text', text: 'FOLLOW-UP: Orphan', ts: 1 },
    ]);

    const result = await fixture.service.runCell(cell.id);
    expect(result.prodded).toBe(1);

    fixture.cells.remove(cell.id);
    (fixture.engine.note as ReturnType<typeof vi.fn>).mockClear();
    release();
    await settleMaster();

    expect(fixture.events.list({ cellId: cell.id })).toHaveLength(0);
    expect(fixture.repo.list().filter((item) => item.title === 'Orphan')).toHaveLength(0);
    expect(fixture.engine.note).not.toHaveBeenCalled();
  });

  it('carries the source harness and target repo into follow-ups', async () => {
    const repoUrl = 'https://github.com/example/repo';
    const process = processFor((config) => {
      const implement = segment(config, 'implement');
      implement.idleMinutes = 1;
      implement.readyMarker = null;
      implement.advanceTo = null;
      implement.followUps.enabled = true;
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('Override cell');
    const request = dispatchRequest(fixture, 'Build it', cell.id);
    fixture.repo.edit(request.id, { harness: 'opencode', targetRepo: repoUrl });
    age(fixture, request.id, 10 * 60_000);
    (fixture.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'agent', kind: 'text', text: 'FOLLOW-UP: Ship the fix', ts: 1 },
    ]);

    const result = await runEnabledCells(fixture);

    expect(result.followUps).toBe(1);
    const [followUp] = fixture.repo.list().filter((item) => item.title === 'Ship the fix');
    expect(followUp).toMatchObject({
      cellId: cell.id,
      harness: 'opencode',
      targetRepo: repoUrl,
    });
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
      const base = tmpDir('sched');
      const settings = new SettingsStore(path.join(base, 'config.json'));
      settings.patch({ master: { enabled: true } });
      const cells = new CellRepository(openDb(path.join(base, 'db.sqlite')));
      const cell = cells.create('Alpha', null, 2);
      const runCell = vi.fn(async () => emptyResult());
      const service = {
        runCell,
        lastRunAt: null,
        lastResult: null,
        lastFor: vi.fn(() => null),
      pauseFor: vi.fn(() => null),
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

  it('reports a scheduler cycle rejection', async () => {
    vi.useFakeTimers();
    try {
      const base = tmpDir('sched-error');
      const settings = new SettingsStore(path.join(base, 'config.json'));
      settings.patch({ master: { enabled: true } });
      const cells = new CellRepository(openDb(path.join(base, 'db.sqlite')));
      const cell = cells.create('Broken', null, 2);
      const service = {
        runCell: vi.fn(async () => {
          throw new Error('database is locked');
        }),
        lastRunAt: null,
        lastResult: null,
        lastFor: vi.fn(() => null),
        pauseFor: vi.fn(() => null),
      } as unknown as MasterService;
      const onError = vi.fn();
      const scheduler = new MasterScheduler(service, settings, cells, undefined, onError);
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2 * 60_000);

      expect(onError).toHaveBeenCalledWith({
        source: 'master.cycle',
        cellId: cell.id,
        requestId: null,
        segment: null,
        occurredAt: expect.any(Number),
      });
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a tick while a cell run is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const base = tmpDir('sched');
      const settings = new SettingsStore(path.join(base, 'config.json'));
      const cells = new CellRepository(openDb(path.join(base, 'db.sqlite')));
      const cell = cells.create('Alpha', null, 2);
      let release!: (value: MasterResult) => void;
      let calls = 0;
      const runCell = vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<MasterResult>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(emptyResult());
      });
      const scheduler = new MasterScheduler(
        {
          runCell,
          lastRunAt: null,
          lastResult: null,
          lastFor: vi.fn(() => null),
      pauseFor: vi.fn(() => null),
        } as unknown as MasterService,
        settings,
        cells,
      );
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runCell).toHaveBeenCalledTimes(1);
      expect(scheduler.status().running).toBe(true);
      expect(scheduler.statusFor(cell.id).running).toBe(true);
      const firstNextRunAt = scheduler.statusFor(cell.id).nextRunAt;

      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runCell).toHaveBeenCalledTimes(1);
      expect(scheduler.statusFor(cell.id).running).toBe(true);
      expect(scheduler.statusFor(cell.id).nextRunAt).toBeGreaterThan(firstNextRunAt ?? 0);

      release(emptyResult());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runCell).toHaveBeenCalledTimes(2);

      scheduler.stop();
      cells.list();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create an unassigned timer when no cells exist', async () => {
    vi.useFakeTimers();
    try {
      const settings = new SettingsStore(
        path.join(tmpDir('sched'), 'config.json'),
      );
      const runCell = vi.fn(async () => emptyResult());
      const scheduler = new MasterScheduler(
        {
          runCell,
          lastRunAt: null,
          lastResult: null,
          lastFor: vi.fn(() => null),
      pauseFor: vi.fn(() => null),
        } as unknown as MasterService,
        settings,
        new CellRepository(openDb(':memory:')),
      );
      scheduler.start();

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(runCell).not.toHaveBeenCalled();
      expect(scheduler.status()).toMatchObject({ nextRunAt: null, running: false });
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a paused cell once, then resumes without per-tick spam', async () => {
    let pause: SpendPause | null = {
      scope: 'overall',
      cellId: null,
      cellName: null,
      label: 'Overall',
      reason: 'cap_reached',
      periodStart: Date.UTC(2026, 10, 1),
      periodEnd: Date.UTC(2026, 11, 1),
      budgetUsd: 100,
      spendUsd: 100,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    };
    const fixture = setup({}, undefined, () => pause);
    const cell = fixture.cells.create('Alpha');
    dispatchRequest(fixture, 'Blocked work', cell.id);

    const first = await fixture.service.runCell(cell.id);
    expect(first.skipped).toBe(1);
    expect(fixture.turns).toHaveLength(0);
    expect(fixture.events.list({ cellId: cell.id })).toHaveLength(1);

    const second = await fixture.service.runCell(cell.id);
    expect(second.skipped).toBe(1);
    expect(fixture.events.list({ cellId: cell.id })).toHaveLength(1);
    expect(fixture.engine.note).toHaveBeenCalledTimes(1);

    // A different reason for the same scope/period/budget is a new episode.
    pause = {
      ...pause,
      reason: 'unknown_cost',
      spendUsd: 5,
      unpricedTurns: 1,
    };
    const third = await fixture.service.runCell(cell.id);
    expect(third.skipped).toBe(1);
    expect(fixture.events.list({ cellId: cell.id })).toHaveLength(2);
    expect(fixture.engine.note).toHaveBeenCalledTimes(2);
    expect(fixture.engine.note).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('cannot be verified'),
    );

    pause = null;
    await fixture.service.runCell(cell.id);
    await settleMaster();
    expect(fixture.turns).toHaveLength(1);
    expect(fixture.engine.note).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Resumed new work'),
    );
  });

  it('does not advance or add follow-ups when a cap stops the turn', async () => {
    const process = processFor((config) => {
      const plan = segment(config, 'plan');
      plan.enabled = true;
      plan.idleMinutes = 1;
      segment(config, 'implement').enabled = false;
    });
    const fixture = setup({}, process);
    const cell = fixture.cells.create('Plan cell');
    const request = fixture.repo.create({ title: 'Plan me', cellId: cell.id });
    fixture.repo.setClarifyStarted(request.id, true);
    age(fixture, request.id, 2 * 60_000);
    (fixture.engine.transcript as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'agent', kind: 'text', text: `planned. ${READY_FOR_IMPLEMENTATION}`, ts: 1 },
    ]);
    fixture.setTurnStoppedBy({
      scope: 'overall',
      cellId: null,
      cellName: null,
      label: 'Overall',
      periodStart: Date.UTC(2026, 10, 1),
      periodEnd: Date.UTC(2026, 11, 1),
      budgetUsd: 100,
      spendUsd: 100,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    });

    await fixture.service.runCell(cell.id);
    await settleMaster();

    expect(fixture.repo.require(request.id).state).toBe('clarify');
    expect(fixture.events.list().some((event) => event.action === 'advance')).toBe(false);
    expect(fixture.events.list().some((event) => event.action === 'followup')).toBe(false);
    expect(fixture.engine.note).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Moved'),
    );
  });

  it('treats an admission race as a quiet skipped candidate', async () => {
    const errors = { error: vi.fn() };
    const fixture = setup({}, undefined, undefined, errors);
    const cell = fixture.cells.create('Alpha');
    dispatchRequest(fixture, 'Raced work', cell.id);
    (fixture.engine.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SpendCapError({
        scope: 'overall',
        cellId: null,
        cellName: null,
        label: 'Overall',
        periodStart: Date.UTC(2026, 10, 1),
        periodEnd: Date.UTC(2026, 11, 1),
        budgetUsd: 100,
        spendUsd: 100,
        spendIsLowerBound: false,
        unpricedTurns: 0,
        percentUsed: 100,
      }),
    );

    const result = await fixture.service.runCell(cell.id);

    expect(result.started).toBe(0);
    expect(result.prodded).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(errors.error).not.toHaveBeenCalled();
    expect(fixture.events.list().some((event) => event.action === 'skip')).toBe(false);
    expect(fixture.engine.note).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Could not run'),
    );
  });

  it('coalesces concurrent run-now calls for one cell', async () => {
    const base = tmpDir('sched');
    const settings = new SettingsStore(path.join(base, 'config.json'));
    const cells = new CellRepository(openDb(path.join(base, 'db.sqlite')));
    const cell = cells.create('Alpha');
    let release!: (value: unknown) => void;
    const result = emptyResult();
    const runCell = vi.fn(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    const scheduler = new MasterScheduler(
      {
        runCell,
        lastRunAt: null,
        lastResult: null,
        lastFor: vi.fn(() => null),
      pauseFor: vi.fn(() => null),
      } as unknown as MasterService,
      settings,
      cells,
    );

    const first = scheduler.runNow(cell.id);
    const second = scheduler.runNow(cell.id);
    expect(runCell).toHaveBeenCalledTimes(1);
    release(result);
    expect(await first).toBe(result);
    expect(await second).toBe(result);
  });
});
