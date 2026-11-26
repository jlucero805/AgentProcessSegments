import path from 'node:path';
import { tmpDir } from './tmp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { MasterEventRepository } from '../src/master/events.js';
import { openDb, type Db } from '../src/db.js';
import type { SummaryFailureNotification } from '../src/domain/notifications.js';
import { summarySessionId } from '../src/domain/sessions.js';
import { RequestRepository } from '../src/requests/repository.js';
import { SettingsStore } from '../src/settings.js';
import { SummaryRepository } from '../src/summary/repository.js';
import {
  collectSummaryStats,
  summaryFailureSource,
  SummaryService,
} from '../src/summary/service.js';
import { SpendCapError } from '../src/usage/spend-cap.js';
import type { SummaryStats } from '../src/summary/types.js';
import {
  createHarness,
  errorResultLine,
  initLine,
  resultLine,
  settle,
  textLine,
  type Harness,
} from './helpers.js';

let open: Harness | null = null;

afterEach(() => {
  open?.db.close();
  open = null;
});

function emptyStats(cellId: string, now: number): SummaryStats {
  return {
    windowStart: now - 6 * 60 * 60_000,
    windowEnd: now,
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

function requestAt(
  db: Db,
  repo: RequestRepository,
  cellId: string,
  title: string,
  input: {
    createdAt: number;
    updatedAt: number;
    state?: string;
    agentStatus?: string;
    unchecked?: boolean;
  },
) {
  const request = repo.create({ title, cellId });
  db.prepare(
    `UPDATE requests
        SET created_at = ?, updated_at = ?, state = ?, agent_status = ?, unchecked = ?
      WHERE id = ?`,
  ).run(
    input.createdAt,
    input.updatedAt,
    input.state ?? 'clarify',
    input.agentStatus ?? 'idle',
    input.unchecked ? 1 : 0,
    request.id,
  );
  return repo.require(request.id);
}

function event(
  db: Db,
  input: { id: string; cellId: string; action: string; detail?: string; createdAt: number },
): void {
  db.prepare(
    `INSERT INTO master_events (id, cell_id, request_id, action, detail, created_at)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(input.id, input.cellId, input.action, input.detail ?? '', input.createdAt);
}

describe('summary stats', () => {
  it('collects two windows of request, status, stall, and activity facts', () => {
    const db = openDb(':memory:');
    const repo = new RequestRepository(db);
    const cells = new CellRepository(db);
    const events = new MasterEventRepository(db);
    const cell = cells.create('Alpha');
    const now = 10_000_000_000;
    const hour = 60 * 60_000;
    const windowStart = now - 6 * hour;

    const active = requestAt(db, repo, cell.id, 'Active work', {
      createdAt: now - 1 * hour,
      updatedAt: now - 30 * 60_000,
      state: 'dispatch',
      agentStatus: 'idle',
    });
    requestAt(db, repo, cell.id, 'Older done', {
      createdAt: now - 8 * hour,
      updatedAt: now - 7 * hour,
      state: 'done',
      agentStatus: 'idle',
    });
    const stalled = requestAt(db, repo, cell.id, 'Stalled review', {
      createdAt: now - 7 * hour,
      updatedAt: now - 10 * hour,
      state: 'review',
      agentStatus: 'blocked',
      unchecked: true,
    });
    requestAt(db, repo, cell.id, 'Fresh done', {
      createdAt: now - 2 * hour,
      updatedAt: now - 1 * hour,
      state: 'done',
      agentStatus: 'idle',
    });
    requestAt(db, repo, cell.id, 'Dropped now', {
      createdAt: now - 3 * hour,
      updatedAt: now - 3 * hour,
      state: 'dropped',
      agentStatus: 'idle',
    });
    requestAt(db, repo, cell.id, 'Working', {
      createdAt: now - 2 * hour,
      updatedAt: now - 9 * hour,
      state: 'clarify',
      agentStatus: 'working',
    });

    event(db, { id: 'c1', cellId: cell.id, action: 'cycle', createdAt: now - 1 * hour });
    event(db, { id: 'c2', cellId: cell.id, action: 'cycle', createdAt: now - 2 * hour });
    event(db, { id: 's1', cellId: cell.id, action: 'start', createdAt: now - 1 * hour });
    event(db, { id: 'p1', cellId: cell.id, action: 'prod', createdAt: now - 1 * hour });
    event(db, { id: 'r1', cellId: cell.id, action: 'review', createdAt: now - 1 * hour });
    event(db, { id: 'a1', cellId: cell.id, action: 'advance', createdAt: now - 1 * hour });
    event(db, {
      id: 'f1',
      cellId: cell.id,
      action: 'followup',
      detail: 'Add metrics',
      createdAt: now - 1 * hour,
    });
    event(db, {
      id: 'f2',
      cellId: cell.id,
      action: 'followup',
      detail: 'Write docs',
      createdAt: now - 2 * hour,
    });
    event(db, {
      id: 'k1',
      cellId: cell.id,
      action: 'skip',
      detail: 'concurrency limit reached',
      createdAt: now - 1 * hour,
    });

    event(db, { id: 'pc1', cellId: cell.id, action: 'cycle', createdAt: now - 7 * hour });
    event(db, { id: 'ps1', cellId: cell.id, action: 'start', createdAt: now - 7 * hour });
    event(db, { id: 'ps2', cellId: cell.id, action: 'start', createdAt: now - 8 * hour });
    event(db, { id: 'pa1', cellId: cell.id, action: 'advance', createdAt: now - 7 * hour });
    event(db, {
      id: 'pf1',
      cellId: cell.id,
      action: 'followup',
      detail: 'Old follow-up',
      createdAt: now - 7 * hour,
    });

    const stats = collectSummaryStats({
      requests: repo.list({ cellId: cell.id }),
      activity: events.activityWindow(cell.id, windowStart, now),
      previousActivity: events.activityWindow(cell.id, windowStart - 6 * hour, windowStart),
      cell,
      now,
      windowMinutes: 360,
      idleMinutes: 10,
    });

    expect(stats.windowStart).toBe(windowStart);
    expect(stats.windowEnd).toBe(now);
    expect(stats.requests.total).toBe(6);
    expect(stats.requests.byState).toEqual({
      clarify: 1,
      dispatch: 1,
      review: 1,
      merge: 0,
      finalize: 0,
      done: 2,
      dropped: 1,
    });
    expect(stats.requests.agentStatus).toEqual({
      none: 0,
      idle: 4,
      working: 1,
      blocked: 1,
      error: 0,
    });
    expect(stats.requests.created).toBe(4);
    expect(stats.requests.updated).toBe(3);
    expect(stats.requests.completed).toBe(1);
    expect(stats.requests.dropped).toBe(1);
    expect(stats.requests.unchecked).toBe(1);
    expect(stats.requests.stalled.map((item) => item.id)).toEqual([stalled.id, active.id]);
    expect(stats.requests.stalled[0]).toMatchObject({ title: 'Stalled review', state: 'review' });
    expect(stats.requests.stalled[0]?.ageMinutes).toBe(10 * 60);
    expect(active.state).toBe('dispatch');

    expect(stats.activity).toMatchObject({
      cycles: 2,
      started: 1,
      prodded: 1,
      reviewed: 1,
      advanced: 1,
      followUps: 2,
      skipped: 1,
      followUpTitles: ['Add metrics', 'Write docs'],
      skipReasons: ['concurrency limit reached'],
    });
    expect(stats.previous).toMatchObject({
      created: 2,
      completed: 1,
      dropped: 0,
      activity: {
        cycles: 1,
        started: 2,
        prodded: 0,
        reviewed: 0,
        advanced: 1,
        followUps: 1,
        skipped: 0,
      },
    });
    db.close();
  });
});

describe('SummaryService', () => {
  function setup(
    script: (text: string) => string[],
    options: {
      onSummaryFailure?: (event: SummaryFailureNotification) => void;
    } = {},
  ) {
    const base = tmpDir('summary');
    const harness = createHarness(script, () => ({ model: 'cell-model', effort: 'high' }));
    open = harness;
    const events = new MasterEventRepository(harness.db);
    const summaries = new SummaryRepository(harness.db);
    const settings = new SettingsStore(path.join(base, 'config.json'));
    const errors = { error: vi.fn() };
    const notify = options.onSummaryFailure ?? vi.fn();
    const service = new SummaryService({
      repo: harness.repo,
      cells: harness.cells,
      engine: harness.engine,
      settings,
      events,
      summaries,
      errors,
      onSummaryFailure: notify,
    });
    return { base, harness, events, summaries, settings, errors, notify, service };
  }

  it('writes a scorecard from the summary session and persists the stats', async () => {
    const fixture = setup((text) => [
      initLine('summary-session'),
      textLine(`# Scorecard\n\nAll quiet.\n\n${text.includes('"windowMinutes": 360') ? 'facts ok' : 'missing'}`),
      resultLine(),
    ]);
    const cell = fixture.harness.cells.create('Alpha', null, null, {
      model: 'cell-model',
      effort: 'high',
    });
    const before = fixture.harness.repo.list().length;

    const summary = await fixture.service.generate(cell.id);

    expect(summary.cellId).toBe(cell.id);
    expect(summary.windowMinutes).toBe(360);
    expect(summary.content).toContain('All quiet.');
    expect(summary.content).toContain('facts ok');
    expect(summary.stats.cell).toEqual({ id: cell.id, name: 'Alpha' });
    expect(fixture.summaries.latest(cell.id)?.id).toBe(summary.id);
    expect(fixture.harness.repo.list()).toHaveLength(before);
    expect(fixture.notify).not.toHaveBeenCalled();

    const session = fixture.harness.harness.sessions[0];
    expect(session).toMatchObject({ scope: 'master', requestId: '', model: 'cell-model', effort: 'high' });
    expect(fixture.harness.harness.process?.messages[0]).toContain('"windowMinutes": 360');
    expect(fixture.harness.harness.process?.messages[0]).toContain('Alpha');
    expect(
      fixture.harness.engine
        .transcript(summarySessionId(cell.id))
        .some((message) => message.text.includes('scorecard writer')),
    ).toBe(true);
  });

  it('reuses the summary session on the next run', async () => {
    let run = 0;
    const fixture = setup(() => {
      run += 1;
      return [
        initLine('summary-session'),
        textLine(run === 1 ? '# First report' : '# Second report'),
        resultLine(),
      ];
    });
    const cell = fixture.harness.cells.create('Alpha');

    const first = await fixture.service.generate(cell.id);
    await settle();
    fixture.harness.harness.process?.emitExit(0);
    const second = await fixture.service.generate(cell.id);

    expect(first.content).toContain('# First report');
    expect(first.content).toContain('Derived from request timestamps');
    expect(second.content).toContain('# Second report');
    expect(fixture.harness.harness.sessions).toHaveLength(2);
    expect(fixture.harness.harness.sessions[1]?.sessionId).toBe('summary-session');
  });

  it('records a generation failure and writes no row', async () => {
    const fixture = setup(() => [initLine(), resultLine()]);
    const cell = fixture.harness.cells.create('Alpha');

    await expect(fixture.service.generate(cell.id)).rejects.toThrow('no text');

    expect(fixture.summaries.latest(cell.id)).toBeNull();
    expect(fixture.errors.error).toHaveBeenCalledWith(
      'summary.generate',
      expect.any(Error),
      { cellId: cell.id },
    );
    expect(fixture.notify).toHaveBeenCalledWith({
      cellId: cell.id,
      source: 'summary.empty',
      reason: 'scorecard returned no text',
      occurredAt: expect.any(Number),
    });
  });

  it('notifies for an engine error result with the safe classification', async () => {
    const fixture = setup(() => [
      initLine(),
      errorResultLine('provider secret error'),
      resultLine(),
    ]);
    const cell = fixture.harness.cells.create('Alpha');

    await expect(fixture.service.generate(cell.id)).rejects.toThrow('provider secret error');

    const event = (fixture.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | SummaryFailureNotification
      | undefined;
    expect(event).toMatchObject({
      cellId: cell.id,
      source: 'summary.result',
      reason: 'harness error result',
    });
    expect(JSON.stringify(event)).not.toContain('provider secret error');
  });

  it('notifies for a non-zero exit and maps the safe reason', async () => {
    const fixture = setup(() => []);
    const cell = fixture.harness.cells.create('Alpha');
    const pending = fixture.service.generate(cell.id);
    await settle();
    fixture.harness.harness.process?.emitExit(1);

    await expect(pending).rejects.toThrow('process exited with code 1');

    expect(fixture.notify).toHaveBeenCalledWith({
      cellId: cell.id,
      source: 'summary.exit',
      reason: 'process exited with code 1',
      occurredAt: expect.any(Number),
    });
  });

  it('maps every engine failure source and reports a hook that throws', async () => {
    expect(summaryFailureSource('engine.result')).toBe('summary.result');
    expect(summaryFailureSource('engine.exit')).toBe('summary.exit');
    expect(summaryFailureSource('engine.timeout')).toBe('summary.timeout');
    expect(summaryFailureSource('engine.turn')).toBe('summary.turn');

    const fixture = setup(
      () => [initLine(), errorResultLine('boom'), resultLine()],
      {
        onSummaryFailure: () => {
          throw new Error('observer down');
        },
      },
    );
    const cell = fixture.harness.cells.create('Alpha');

    await expect(fixture.service.generate(cell.id)).rejects.toThrow('boom');
    expect(fixture.errors.error).toHaveBeenCalledWith(
      'notifications.event',
      expect.any(Error),
      { kind: 'summary.failed', cellId: cell.id },
    );
  });

  it('notifies when the scorecard cannot be stored', async () => {
    const fixture = setup(() => [initLine(), textLine('# Report'), resultLine()]);
    const cell = fixture.harness.cells.create('Alpha');
    vi.spyOn(fixture.summaries, 'record').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(fixture.service.generate(cell.id)).rejects.toThrow('disk full');

    expect(fixture.notify).toHaveBeenCalledWith({
      cellId: cell.id,
      source: 'summary.store',
      reason: 'could not save scorecard',
      occurredAt: expect.any(Number),
    });
  });

  it('treats a cap-stopped generation as a pause, not a failure', async () => {
    const fixture = setup(() => []);
    const cell = fixture.harness.cells.create('Alpha');
    const pending = fixture.service.generate(cell.id);
    await settle();

    const pause = {
      scope: 'cell' as const,
      cellId: cell.id,
      cellName: 'Alpha',
      label: 'Alpha',
      periodStart: Date.UTC(2026, 10, 1),
      periodEnd: Date.UTC(2026, 11, 1),
      budgetUsd: 50,
      spendUsd: 50,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    };
    expect(
      fixture.harness.engine.cancelForSpendCap(summarySessionId(cell.id), pause),
    ).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(SpendCapError);

    expect(fixture.summaries.latest(cell.id)).toBeNull();
    expect(fixture.errors.error).not.toHaveBeenCalled();
    expect(fixture.notify).not.toHaveBeenCalled();
    expect(
      fixture.harness.engine
        .transcript(summarySessionId(cell.id))
        .some((message) => message.text.startsWith('⏸')),
    ).toBe(true);
  });

  it('removes stored reports with their cell', () => {
    const fixture = setup(() => []);
    const cell = fixture.harness.cells.create('Alpha');
    fixture.summaries.record({
      cellId: cell.id,
      windowStart: 0,
      windowEnd: 1,
      windowMinutes: 360,
      content: 'report',
      stats: emptyStats(cell.id, 1),
    });

    fixture.harness.cells.remove(cell.id);

    expect(fixture.summaries.latest(cell.id)).toBeNull();
    expect(fixture.summaries.list()).toHaveLength(0);
  });

  it('refuses to start a second generation in the same summary session', async () => {
    const fixture = setup(() => [initLine(), textLine('# Report'), resultLine()]);
    const cell = fixture.harness.cells.create('Alpha');
    const turn = await fixture.harness.engine.startSummary(
      'busy',
      summarySessionId(cell.id),
    );

    await expect(fixture.service.generate(cell.id)).rejects.toThrow('already running');
    await turn.promise;
    await settle();
    expect(fixture.summaries.latest(cell.id)).toBeNull();
    expect(fixture.notify).not.toHaveBeenCalled();
  });
});
