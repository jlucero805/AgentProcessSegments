import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import {
  createHarness,
  defaultScript,
  errorResultLine,
  initLine,
  line,
  resultLine,
  settle,
  textLine,
  type Harness,
} from './helpers.js';
import { KB_SESSION_ID, MASTER_SESSION_ID } from '../src/clarify/engine.js';
import { OpencodeTurnParser } from '../src/clarify/harnesses/opencode.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { requestDir } from '../src/config.js';
import { masterSessionId, setupSessionId, summarySessionId } from '../src/domain/sessions.js';
import type { SpendPause } from '../src/domain/budget.js';
import type { TurnFailureNotification } from '../src/domain/notifications.js';
import { SpendCapError } from '../src/usage/spend-cap.js';
import { SpendCapEnforcer } from '../src/usage/spend-cap-enforcer.js';

let harness: Harness | null = null;

function fresh(script?: (text: string) => string[]): Harness {
  harness = createHarness(script);
  return harness;
}

function freshWithErrors(script: (text: string) => string[], errors: ErrorSink): Harness {
  harness = createHarness(script, undefined, undefined, errors);
  return harness;
}

function spendPause(overrides: Partial<SpendPause> = {}): SpendPause {
  return {
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
    ...overrides,
  };
}

function freshWithTurnFailures(
  script: (text: string) => string[],
  failures: TurnFailureNotification[],
  configOverrides: Partial<Harness['config']> = {},
): Harness {
  harness = createHarness(
    script,
    undefined,
    undefined,
    undefined,
    configOverrides,
    undefined,
    (event) => failures.push(event),
  );
  return harness;
}

/** A real repo, since the engine only creates worktrees for a real checkout. */
function gitRepo(): string {
  const dir = tmpDir('engine-git');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  );
  return dir;
}

function gitBranches(repo: string): string {
  return execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' });
}

/** POSIX permission bits for a path (owner/group/other). */
function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

afterEach(() => {
  harness?.db.close();
  harness = null;
});

describe('turn engine', () => {
  it('runs a turn, persists the transcript, and lands in idle plus unchecked', async () => {
    const h = fresh((text) => [initLine('sess-1'), textLine(`heard: ${text}`), resultLine()]);
    const request = h.repo.create({ title: 'Groom me', body: 'details' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(h.repo.require(request.id).clarifyStarted).toBe(true);
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(h.repo.require(request.id).unchecked).toBe(true);

    const done = turn.events.find((event) => event.t === 'done');
    expect(done?.t).toBe('done');
    if (done?.t === 'done') {
      expect(done.request?.id).toBe(request.id);
      expect(done.transcript.some((msg) => msg.role === 'you')).toBe(true);
      expect(done.transcript.some((msg) => msg.kind === 'text' && msg.text.includes('Groom me'))).toBe(true);
    }

    const persisted = h.engine.transcript(request.id);
    expect(persisted.filter((msg) => msg.kind === 'text')).toHaveLength(2);

    const session = h.harness.sessions[0];
    expect(session?.requestId).toBe(request.id);
    expect(session?.scope).toBe('request');
    expect(h.harness.process?.messages[0]).toContain('Groom me');
  });

  it('records one usage row with the resolved request model and cell', async () => {
    const h = fresh(() => [
      initLine('sess-usage'),
      resultLine('done', {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      }, 0.0123),
    ]);
    const cell = h.cells.create('Alpha');
    const request = h.repo.create({ title: 'Metered', cellId: cell.id });
    h.repo.edit(request.id, { model: 'request-model', effort: 'high' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    const rows = h.db.prepare('SELECT * FROM usage_events').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turn_id: turn.turnId,
      session_id: request.id,
      scope: 'request',
      cell_id: cell.id,
      request_id: request.id,
      model: 'request-model',
      effort: 'high',
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      reasoning_tokens: 0,
      cost_usd: 0.0123,
    });
  });

  it('records Claude usage deltas across resumed turns', async () => {
    let call = 0;
    const h = fresh(() => {
      call += 1;
      return [
        initLine(`sess-${call}`),
        textLine('done'),
        resultLine(
          'done',
          { input_tokens: call === 1 ? 10 : 25, output_tokens: 0 },
          call === 1 ? 0.1 : 0.25,
        ),
      ];
    });
    const request = h.repo.create({ title: 'Cumulative Claude' });

    const first = await h.engine.start(request.id);
    await first.promise;
    await settle();
    const second = await h.engine.send(request.id, 'again');
    await second.promise;
    await settle();

    const rows = h.db
      .prepare('SELECT input_tokens, cost_usd FROM usage_events ORDER BY rowid')
      .all() as Array<{ input_tokens: number; cost_usd: number | null }>;
    expect(rows).toEqual([
      { input_tokens: 10, cost_usd: 0.1 },
      { input_tokens: 15, cost_usd: 0.15 },
    ]);
  });

  it('records master, KB, and setup turns without a request id', async () => {
    const h = fresh(() => [
      initLine('sess-usage'),
      resultLine('done', { input_tokens: 3, output_tokens: 2 }, 0.001),
    ]);

    const master = await h.engine.startMaster('status?', '__master__:cell-1');
    await master.promise;
    await settle();
    const kb = await h.engine.startKb('search');
    await kb.promise;
    await settle();
    const setup = await h.engine.startSetup('defaults', '__setup__:draft-1');
    await setup.promise;
    await settle();

    const rows = h.db
      .prepare('SELECT session_id, scope, cell_id, request_id FROM usage_events ORDER BY created_at, rowid')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { session_id: '__master__:cell-1', scope: 'master', cell_id: 'cell-1', request_id: null },
      { session_id: '__kb__', scope: 'kb', cell_id: null, request_id: null },
      { session_id: '__setup__:draft-1', scope: 'setup', cell_id: null, request_id: null },
    ]);
  });

  it('does not record cancelled, timed-out, or usage-less turns', async () => {
    const h = fresh(() => [initLine('sess-usage')]);
    const request = h.repo.create({ title: 'Cancelled' });

    const turn = await h.engine.start(request.id);
    await settle();
    h.engine.cancel(request.id);
    await turn.promise;
    await settle();
    expect(h.usage.query({}).totals.turns).toBe(0);

    const noUsage = await h.engine.send(request.id, 'again');
    h.harness.process?.emit(initLine('sess-usage'));
    h.harness.process?.emit(resultLine());
    await noUsage.promise;
    await settle();
    expect(h.usage.query({}).totals.turns).toBe(0);
  });

  it('keeps the turn alive when a usage insert fails', async () => {
    const h = fresh(() => [
      initLine('sess-usage'),
      resultLine('done', { input_tokens: 4, output_tokens: 1 }, 0.001),
    ]);
    const request = h.repo.create({ title: 'Write failure' });
    h.usage.record = () => {
      throw new Error('disk full');
    };

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(turn.events.some((event) => event.t === 'done')).toBe(true);
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(h.engine.transcript(request.id).some((message) => message.kind === 'text')).toBe(true);
  });

  it('includes enabled intake instructions in the first clarification turn', async () => {
    const h = fresh(() => defaultScript());
    const request = h.repo.create({ title: 'Repo context' });

    const turn = await h.engine.start(
      request.id,
      'This cell works in the AgentProcessSegments repository.',
    );
    await turn.promise;
    await settle();

    const messages = h.engine.transcript(request.id);
    expect(
      messages.some((message) =>
        message.text.includes('Additional process instructions'),
      ),
    ).toBe(true);
    expect(
      messages.some((message) => message.text.includes('AgentProcessSegments repository')),
    ).toBe(true);
  });

  it('replays buffered events to a subscriber that attaches mid-turn', async () => {
    const h = fresh(() => []);
    const request = h.repo.create({ title: 'Live' });

    const turn = await h.engine.start(request.id);
    await settle();

    const seen: string[] = [];
    expect(h.engine.attach(request.id, (event) => seen.push(event.t))).toBe(true);
    expect(h.engine.hasLive(request.id)).toBe(true);

    h.harness.process?.emit(initLine('sess-live'));
    h.harness.process?.emit(textLine('streaming'));
    h.harness.process?.emit(resultLine());
    await settle();
    await turn.promise;
    await settle();

    expect(seen).toEqual(['text', 'done']);
    expect(h.engine.hasLive(request.id)).toBe(false);
    expect(h.engine.attach(request.id, () => {})).toBe(false);
  });

  it('is idempotent while a turn is in flight', async () => {
    const h = fresh(() => []);
    const request = h.repo.create({ title: 'Only one' });

    const first = await h.engine.start(request.id);
    const second = await h.engine.start(request.id);

    expect(second).toBe(first);
    expect(h.harness.sessions).toHaveLength(1);
    h.harness.process?.emit(resultLine());
    await first.promise;
    await settle();
  });

  it('stops a live turn and keeps the saved session for the next message', async () => {
    const h = fresh(() => [initLine('sess-stop')]);
    const request = h.repo.create({ title: 'Stop me' });

    const first = await h.engine.start(request.id);
    await settle();
    expect(h.engine.hasLive(request.id)).toBe(true);

    expect(h.engine.cancel(request.id)).toBe(true);
    await first.promise;
    await settle();

    expect(h.engine.hasLive(request.id)).toBe(false);
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(h.harness.process?.killed).toBe(true);
    expect(first.stoppedBy).toBeNull();
    expect(first.events.some((event) => event.t === 'paused')).toBe(false);
    expect(first.events.some((event) => event.t === 'done')).toBe(true);
    expect(h.engine.cancel(request.id)).toBe(false);

    const second = await h.engine.send(request.id, 'interject');
    await settle();
    h.harness.process?.emit(resultLine());
    await second.promise;
    await settle();
    expect(h.harness.sessions[1]?.sessionId).toBe('sess-stop');
  });

  it('stops a live turn for a hard cap, saves the reason, and keeps the session', async () => {
    const h = fresh(() => [initLine('sess-cap')]);
    const cell = h.cells.create('Alpha');
    const request = h.repo.create({ title: 'Capped turn', cellId: cell.id });
    const turn = await h.engine.start(request.id);
    await settle();
    expect(h.engine.liveTurns()).toEqual([
      { id: request.id, cellId: cell.id, scope: 'request' },
    ]);

    const cap = spendPause({
      scope: 'cell',
      cellId: cell.id,
      cellName: 'Alpha',
      label: 'Alpha',
    });
    expect(h.engine.cancelForSpendCap(request.id, cap)).toBe(true);
    await turn.promise;
    await settle();

    expect(turn.stoppedBy).toEqual(cap);
    expect(turn.failure).toBeNull();
    expect(turn.events.map((event) => event.t)).toEqual(['paused', 'done']);
    expect(h.engine.liveTurns()).toEqual([]);
    expect(h.engine.hasLive(request.id)).toBe(false);
    expect(h.harness.process?.killed).toBe(true);

    const stopped = h.engine
      .transcript(request.id)
      .filter((message) => message.kind === 'text' && message.text.startsWith('⏸'));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.text).toContain('Alpha monthly spend cap');
    expect(stopped[0]?.text).toContain('This turn was stopped');

    const after = h.repo.require(request.id);
    expect(after.agentStatus).toBe('idle');
    expect(after.unchecked).toBe(true);
    expect(h.usage.query({}).totals.turns).toBe(0);
    expect(h.engine.cancelForSpendCap('missing', cap)).toBe(false);

    // The saved harness session survives the stop and is reused on resume.
    const next = await h.engine.send(request.id, 'continue');
    await settle();
    h.harness.process?.emit(resultLine());
    await next.promise;
    await settle();
    expect(h.harness.sessions[1]?.sessionId).toBe('sess-cap');
  });

  it('stops sibling turns when a completed usage row crosses the overall cap', async () => {
    const errors = { error: vi.fn() };
    const cap = spendPause({ budgetUsd: 1, spendUsd: 1 });
    let enforcement: SpendCapEnforcer | null = null;
    harness = createHarness(
      () => [],
      undefined,
      undefined,
      errors,
      {},
      () => enforcement?.check(),
    );
    const h = harness;
    enforcement = new SpendCapEnforcer({
      engine: h.engine,
      admission: () => ((h.usage.query({}).totals.costUsd ?? 0) >= 1 ? cap : null),
      errors,
    });
    const cell = h.cells.create('Alpha');
    const first = h.repo.create({ title: 'First', cellId: cell.id });
    const second = h.repo.create({ title: 'Second', cellId: cell.id });

    const firstTurn = await h.engine.start(first.id);
    await settle();
    const firstProcess = h.harness.process;
    const secondTurn = await h.engine.start(second.id);
    await settle();
    const secondProcess = h.harness.process;

    secondProcess?.emit(initLine('sess-second'));
    secondProcess?.emit(resultLine('ok', { input_tokens: 10, output_tokens: 5 }, 1));
    await secondTurn.promise;
    await settle();

    expect(secondTurn.stoppedBy).toBeNull();
    expect(secondTurn.events.some((event) => event.t === 'paused')).toBe(false);
    expect(firstTurn.stoppedBy).toEqual(cap);
    expect(firstTurn.events.map((event) => event.t)).toEqual(['paused', 'done']);
    expect(firstProcess?.killed).toBe(true);
    expect(
      h.engine
        .transcript(first.id)
        .some((message) => message.text.startsWith('⏸') && message.text.includes('Overall')),
    ).toBe(true);
    expect(h.repo.require(first.id).agentStatus).toBe('idle');
    expect(h.repo.require(first.id).unchecked).toBe(true);
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('records harness-reported spend when a hard cap stops an opencode turn', async () => {
    const h = fresh(() => []);
    h.opencode.parserFactory = (transcript) => new OpencodeTurnParser(transcript);
    const request = h.repo.create({ title: 'Metered stop' });
    h.repo.edit(request.id, { harness: 'opencode' });
    const turn = await h.engine.start(request.id);
    await settle();

    h.opencode.process?.emit(
      line({
        type: 'text',
        sessionID: 'ses_partial',
        part: { type: 'text', text: 'working' },
      }),
    );
    h.opencode.process?.emit(
      line({
        type: 'step_finish',
        part: {
          reason: 'tool-calls',
          cost: 0.25,
          tokens: { input: 100, output: 20, cache: { read: 5, write: 0 } },
        },
      }),
    );
    await settle();

    expect(h.engine.cancelForSpendCap(request.id, spendPause())).toBe(true);
    await turn.promise;
    await settle();

    const rows = h.db.prepare('SELECT * FROM usage_events').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: request.id,
      scope: 'request',
      cost_usd: 0.25,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 5,
    });
    expect(h.engine.transcript(request.id).some((message) => message.text.startsWith('⏸'))).toBe(
      true,
    );
  });

  it('runs a cell master chat read-only and appends scheduler notes', async () => {
    const h = fresh(() => defaultScript());
    const session = '__master__:cell-1';

    const turn = await h.engine.startMaster('what are you doing?', session);
    await turn.promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({ scope: 'master', requestId: '' });
    const transcript = h.engine.transcript(session);
    expect(transcript.some((message) => message.text.includes('cell master'))).toBe(true);

    h.engine.note(session, 'Master cycle: 0 queued, 0 prodded');
    expect(
      h.engine.transcript(session).some((message) => message.text.includes('Master cycle')),
    ).toBe(true);
  });

  it('runs a separate master chat per cell session', async () => {
    const h = fresh(() => defaultScript());
    const session = '__master__:cell-1';

    const turn = await h.engine.startMaster('what is this cell doing?', session);
    await turn.promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({ scope: 'master', requestId: '' });
    expect(h.engine.transcript(session).some((message) => message.text.includes('cell master'))).toBe(
      true,
    );
    expect(h.engine.transcript('__master__')).toHaveLength(0);

    h.engine.note(session, 'Cell cycle: 1 prodded');
    expect(
      h.engine.transcript(session).some((message) => message.text.includes('Cell cycle')),
    ).toBe(true);
  });

  it('discards cell-owned session directories and refuses new turns', async () => {
    const h = fresh(() => defaultScript());
    const cell = h.cells.create('Doomed');
    const master = masterSessionId(cell.id);
    const summary = summarySessionId(cell.id);

    const masterTurn = await h.engine.startMaster('hello', master);
    await masterTurn.promise;
    await settle();
    const summaryTurn = await h.engine.startSummary('facts', summary, 'Cell: Doomed');
    await summaryTurn.promise;
    await settle();

    const masterDir = requestDir(h.config, master);
    const summaryDir = requestDir(h.config, summary);
    expect(existsSync(masterDir)).toBe(true);
    expect(existsSync(summaryDir)).toBe(true);

    await h.engine.discardSession(master);
    await h.engine.discardSession(summary);
    expect(existsSync(masterDir)).toBe(false);
    expect(existsSync(summaryDir)).toBe(false);
    expect(h.engine.hasLive(master)).toBe(false);
    expect(h.engine.hasLive(summary)).toBe(false);

    await h.engine.discardSession(master);
    h.engine.note(master, 'late note');
    expect(existsSync(masterDir)).toBe(false);

    await expect(h.engine.startMaster('again', master)).rejects.toThrow(/discarded/);
    await expect(h.engine.startSummary('again', summary)).rejects.toThrow(/discarded/);
    expect(existsSync(masterDir)).toBe(false);
    expect(existsSync(summaryDir)).toBe(false);
  });

  it('removes a session directory only after a pending prepare settles', async () => {
    const h = fresh(() => defaultScript());
    const cell = h.cells.create('Slow prepare');
    const session = masterSessionId(cell.id);
    const dir = requestDir(h.config, session);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = h.harness.prepare.bind(h.harness);
    h.harness.prepare = async (input) => {
      await gate;
      return prepare(input);
    };

    const turn = await h.engine.startMaster('hello', session);
    expect(existsSync(dir)).toBe(true);

    const discarding = h.engine.discardSession(session);
    release();
    await discarding;
    await turn.promise;
    await settle();

    expect(existsSync(dir)).toBe(false);
    expect(h.engine.hasLive(session)).toBe(false);
  });

  it('leaves another live cell session alone when one is discarded', async () => {
    const h = fresh(() => []);
    const doomed = h.cells.create('Doomed');
    const alive = h.cells.create('Alive');
    const doomedSession = masterSessionId(doomed.id);
    const aliveSession = masterSessionId(alive.id);

    await h.engine.startMaster('bye', doomedSession);
    await h.engine.startMaster('stay', aliveSession);
    await settle();

    await h.engine.discardSession(doomedSession);
    expect(existsSync(requestDir(h.config, doomedSession))).toBe(false);
    expect(h.engine.hasLive(aliveSession)).toBe(true);
    expect(existsSync(requestDir(h.config, aliveSession))).toBe(true);

    await h.engine.discardSession(aliveSession);
  });

  it('runs the summary generator read-only in its own session', async () => {
    const h = createHarness(
      () => defaultScript(),
      () => ({ model: 'cell-model', effort: 'high', harness: null }),
    );
    harness = h;
    const request = h.repo.create({ title: 'Tracked work' });
    const session = summarySessionId('cell-1');

    const turn = await h.engine.startSummary('facts', session, 'Cell: Alpha');
    await turn.promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({
      scope: 'master',
      requestId: '',
      model: 'cell-model',
      effort: 'high',
    });
    expect(
      h.engine.transcript(session).some((message) => message.text.includes('scorecard writer')),
    ).toBe(true);
    expect(h.engine.transcript('__master__')).toHaveLength(0);
    expect(h.repo.require(request.id).agentStatus).toBe('none');
  });

  it('routes each request through its cell harness', async () => {
    const h = fresh((text) => [initLine('sess-routed'), textLine(`heard: ${text}`), resultLine()]);
    const claudeCell = h.cells.create('Claude cell', null, null, { harness: 'claude' });
    const openCell = h.cells.create('Open cell', null, null, { harness: 'opencode' });
    const claudeRequest = h.repo.create({ title: 'Claude work', cellId: claudeCell.id });
    const openRequest = h.repo.create({ title: 'Open work', cellId: openCell.id });

    const first = await h.engine.start(claudeRequest.id);
    await first.promise;
    await settle();
    expect(h.harness.sessions).toHaveLength(1);
    expect(h.opencode.sessions).toHaveLength(0);

    const second = await h.engine.start(openRequest.id);
    await second.promise;
    await settle();
    expect(h.harness.sessions).toHaveLength(1);
    expect(h.opencode.sessions).toHaveLength(1);
    expect(h.opencode.sessions[0]?.requestId).toBe(openRequest.id);
    expect(h.opencode.sessions[0]?.model).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('uses the default harness for null cells, setup, and unassigned master', async () => {
    const h = fresh(() => defaultScript());
    const inherited = h.cells.create('Inherited', null, null, { harness: null });
    const request = h.repo.create({ title: 'Inherited work', cellId: inherited.id });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();
    expect(h.harness.sessions).toHaveLength(1);
    expect(h.opencode.sessions).toHaveLength(0);

    const setup = await h.engine.startSetup('defaults', '__setup__:draft-1');
    await setup.promise;
    await settle();
    expect(h.harness.sessions).toHaveLength(2);

    const master = await h.engine.startMaster('status', MASTER_SESSION_ID);
    await master.promise;
    await settle();
    expect(h.harness.sessions).toHaveLength(3);
  });

  it('routes a summary session through its cell harness', async () => {
    const h = fresh(() => defaultScript());
    const cell = h.cells.create('Open cell', null, null, { harness: 'opencode' });
    const turn = await h.engine.startSummary('facts', summarySessionId(cell.id));
    await turn.promise;
    await settle();

    expect(h.opencode.sessions).toHaveLength(1);
    expect(h.opencode.sessions[0]).toMatchObject({ scope: 'master' });
    expect(h.harness.sessions).toHaveLength(0);
  });

  it('discards the old process and session when a cell harness changes', async () => {
    const h = fresh((text) => [initLine('sess-open'), textLine(`heard: ${text}`), resultLine()]);
    const cell = h.cells.create('Switching', null, null, { harness: 'opencode' });
    const request = h.repo.create({ title: 'Switch me', cellId: cell.id });

    const first = await h.engine.start(request.id);
    await first.promise;
    await settle();
    expect(h.opencode.sessions).toHaveLength(1);
    expect(h.opencode.process?.killed).toBe(false);

    h.cells.setHarness(cell.id, 'claude');
    const second = await h.engine.send(request.id, 'continue');
    await second.promise;
    await settle();

    expect(h.opencode.process?.killed).toBe(true);
    expect(h.harness.sessions).toHaveLength(1);
    expect(h.harness.sessions[0]?.sessionId).toBeNull();
    expect(h.engine.transcript(request.id).length).toBeGreaterThan(0);
  });

  it('runs a request override on the other adapter and skips cell model defaults', async () => {
    const h = fresh((text) => [initLine('sess-override'), textLine(`heard: ${text}`), resultLine()]);
    const cell = h.cells.create('Claude cell', null, null, {
      harness: 'claude',
      model: 'cell-model',
      effort: 'high',
    });
    const request = h.repo.create({
      title: 'Override to OpenCode',
      cellId: cell.id,
      harness: 'opencode',
    });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(h.harness.sessions).toHaveLength(0);
    expect(h.opencode.sessions[0]).toMatchObject({
      model: 'opencode-go/deepseek-v4.1-flash',
      effort: null,
    });

    const sameHarness = h.repo.create({
      title: 'Same harness',
      cellId: cell.id,
      harness: 'claude',
    });
    const second = await h.engine.start(sameHarness.id);
    await second.promise;
    await settle();
    expect(h.harness.sessions[0]).toMatchObject({
      model: 'cell-model',
      effort: 'high',
    });
  });

  it('discards the old process and session when a request harness changes', async () => {
    const h = fresh((text) => [initLine('sess-request-switch'), textLine(`heard: ${text}`), resultLine()]);
    const request = h.repo.create({ title: 'Switch request harness' });

    const first = await h.engine.start(request.id);
    await first.promise;
    await settle();
    const sessionFile = path.join(requestDir(h.config, request.id), 'session.json');
    expect(JSON.parse(readFileSync(sessionFile, 'utf8'))).toMatchObject({
      harness: 'claude',
      sessionId: 'sess-request-switch',
    });

    h.repo.edit(request.id, { harness: 'opencode' });
    const second = await h.engine.send(request.id, 'continue');
    await second.promise;
    await settle();

    expect(h.harness.process?.killed).toBe(true);
    expect(h.opencode.sessions[0]?.sessionId).toBeNull();
    expect(JSON.parse(readFileSync(sessionFile, 'utf8'))).toMatchObject({
      harness: 'opencode',
      sessionId: 'sess-request-switch',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'writes request state with owner-only permissions',
    async () => {
      const h = fresh(() => defaultScript());
      const request = h.repo.create({ title: 'Owner-only state' });

      const turn = await h.engine.start(request.id);
      await turn.promise;
      await settle();

      const dir = requestDir(h.config, request.id);
      expect(modeOf(path.join(h.config.dataDir, 'requests'))).toBe(0o700);
      expect(modeOf(dir)).toBe(0o700);
      expect(modeOf(path.join(dir, 'cwd'))).toBe(0o700);
      expect(modeOf(path.join(dir, 'session.json'))).toBe(0o600);
      expect(modeOf(path.join(dir, 'transcript.json'))).toBe(0o600);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'repairs a world-readable request workdir on the next write',
    async () => {
      const h = fresh(() => defaultScript());
      const request = h.repo.create({ title: 'Repair request state' });
      const dir = requestDir(h.config, request.id);
      const requests = path.join(h.config.dataDir, 'requests');
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      chmodSync(requests, 0o755);
      chmodSync(dir, 0o755);

      const sessionFile = path.join(dir, 'session.json');
      const transcriptFile = path.join(dir, 'transcript.json');
      writeFileSync(
        sessionFile,
        JSON.stringify({ harness: 'claude', sessionId: 'old-session' }, null, 2),
        { mode: 0o644 },
      );
      chmodSync(sessionFile, 0o644);
      writeFileSync(
        transcriptFile,
        JSON.stringify([{ role: 'you', kind: 'text', text: 'old', ts: 1 }], null, 2),
        { mode: 0o644 },
      );
      chmodSync(transcriptFile, 0o644);

      const turn = await h.engine.start(request.id);
      await turn.promise;
      await settle();

      expect(modeOf(requests)).toBe(0o700);
      expect(modeOf(dir)).toBe(0o700);
      expect(modeOf(sessionFile)).toBe(0o600);
      expect(modeOf(transcriptFile)).toBe(0o600);
      expect(
        h.engine.transcript(request.id).some((message) => message.text === 'old'),
      ).toBe(true);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    },
  );

  it('treats missing conversation state as empty without reporting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = { error: vi.fn() };
    const h = freshWithErrors(() => defaultScript(), errors);
    const request = h.repo.create({ title: 'Missing state' });

    expect(h.engine.transcript(request.id)).toEqual([]);
    expect(errors.error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(requestDir(h.config, request.id))).toBe(false);

    warn.mockRestore();
  });

  it('reports but does not move a corrupt transcript', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = { error: vi.fn() };
    const h = freshWithErrors(() => defaultScript(), errors);
    const request = h.repo.create({ title: 'Corrupt transcript read' });
    const dir = requestDir(h.config, request.id);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transcript.json');
    const payload = '{"secret":"tok-123",';
    writeFileSync(file, payload);

    expect(h.engine.transcript(request.id)).toEqual([]);
    expect(h.engine.transcript(request.id)).toEqual([]);

    expect(readFileSync(file, 'utf8')).toBe(payload);
    expect(readdirSync(dir).filter((name) => name.includes('.unreadable-'))).toEqual([]);
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'engine.transcript.unreadable',
      expect.any(Error),
      { session: request.id, file, reason: 'invalid JSON' },
    );
    expect(String(errors.error.mock.calls[0]?.[1])).toBe('Error: invalid JSON');
    expect(JSON.stringify(errors.error.mock.calls[0])).not.toContain('tok-123');
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a corrupt transcript before the next write',
    () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors = { error: vi.fn() };
      const h = freshWithErrors(() => defaultScript(), errors);
      const request = h.repo.create({ title: 'Corrupt transcript write' });
      const dir = requestDir(h.config, request.id);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'transcript.json');
      const payload = '{"secret":"tok-123",';
      writeFileSync(file, payload);

      h.engine.note(request.id, 'after');

      const names = readdirSync(dir);
      const quarantine = names.find((name) => name.startsWith('transcript.json.unreadable-'));
      expect(quarantine).toBeDefined();
      if (!quarantine) throw new Error('quarantine file missing');

      const quarantineFile = path.join(dir, quarantine);
      expect(readFileSync(quarantineFile, 'utf8')).toBe(payload);
      expect(modeOf(quarantineFile)).toBe(0o600);
      expect(modeOf(file)).toBe(0o600);
      expect(names.filter((name) => name.includes('.tmp-'))).toEqual([]);
      expect(h.engine.transcript(request.id)).toMatchObject([
        { role: 'agent', kind: 'text', text: 'after' },
      ]);

      warn.mockRestore();
    },
  );

  it('quarantines a corrupt session file during a turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = { error: vi.fn() };
    const h = freshWithErrors(() => defaultScript(), errors);
    const request = h.repo.create({ title: 'Corrupt session turn' });
    const dir = requestDir(h.config, request.id);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.json');
    writeFileSync(file, '[]');

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith('engine.session.unreadable', expect.any(Error), {
      session: request.id,
      file,
      reason: 'not a JSON object',
    });

    const names = readdirSync(dir);
    const quarantine = names.find((name) => name.startsWith('session.json.unreadable-'));
    expect(quarantine).toBeDefined();
    if (!quarantine) throw new Error('quarantine file missing');
    expect(readFileSync(path.join(dir, quarantine), 'utf8')).toBe('[]');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      harness: 'claude',
      sessionId: 'session-1',
    });
    expect(turn.events.some((event) => event.t === 'done')).toBe(true);
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(names.filter((name) => name.includes('.tmp-'))).toEqual([]);

    warn.mockRestore();
  });

  it.skipIf(process.platform === 'win32')(
    'quarantines a transcript path that is not a regular file',
    () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors = { error: vi.fn() };
      const h = freshWithErrors(() => defaultScript(), errors);
      const request = h.repo.create({ title: 'Transcript is a directory' });
      const dir = requestDir(h.config, request.id);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'transcript.json');
      mkdirSync(file);

      h.engine.note(request.id, 'after');

      expect(errors.error).toHaveBeenCalledWith(
        'engine.transcript.unreadable',
        expect.any(Error),
        { session: request.id, file, reason: 'unreadable: EISDIR' },
      );
      const names = readdirSync(dir);
      const quarantine = names.find((name) => name.startsWith('transcript.json.unreadable-'));
      expect(quarantine).toBeDefined();
      if (!quarantine) throw new Error('quarantine directory missing');
      expect(statSync(path.join(dir, quarantine)).isDirectory()).toBe(true);
      expect(statSync(file).isFile()).toBe(true);
      expect(h.engine.transcript(request.id)).toMatchObject([
        { role: 'agent', kind: 'text', text: 'after' },
      ]);

      warn.mockRestore();
    },
  );

  it('runs a separate setup chat for the cell wizard', async () => {
    const h = fresh(() => defaultScript());
    const session = '__setup__:draft-1';

    const turn = await h.engine.startSetup('help me configure this cell', session);
    await turn.promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({
      scope: 'setup',
      requestId: '',
      draftId: 'draft-1',
    });
    expect(
      h.engine.transcript(session).some((message) =>
        message.text.includes('setup assistant for one Agent Process Segments cell'),
      ),
    ).toBe(true);
    expect(
      h.engine.transcript(session).some((message) =>
        message.text.includes('never use an interactive question tool'),
      ),
    ).toBe(true);
  });

  it('refuses every new turn before mutating state when a spend cap is active', async () => {
    let active: SpendPause | null = {
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
    harness = createHarness(undefined, undefined, () => active);
    const h = harness;
    const cell = h.cells.create('Alpha');
    const request = h.repo.create({ title: 'Capped', cellId: cell.id });
    const draft = setupSessionId('draft-1');

    const attempts = [
      () => h.engine.start(request.id),
      () => h.engine.send(request.id, 'hello'),
      () => h.engine.kickoffDispatch(request.id),
      () => h.engine.kickoffFinalize(request.id),
      () => h.engine.startKb('kb'),
      () => h.engine.startMaster('hello', masterSessionId(cell.id)),
      () => h.engine.startSummary('facts', summarySessionId(cell.id)),
      () => h.engine.startSetup('setup', draft),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(SpendCapError);
    }

    const after = h.repo.require(request.id);
    expect(after.clarifyStarted).toBe(false);
    expect(after.state).toBe('clarify');
    expect(after.agentStatus).toBe('none');
    expect(h.engine.hasLive(request.id)).toBe(false);
    expect(h.harness.sessions).toHaveLength(0);

    active = null;
    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();
    expect(h.repo.require(request.id).clarifyStarted).toBe(true);
    expect(h.harness.sessions).toHaveLength(1);
  });

  it('pauses one cell without blocking another and resumes when the cap clears', async () => {
    const paused: SpendPause = {
      scope: 'cell',
      cellId: 'cell-a',
      cellName: 'Alpha',
      label: 'Alpha',
      reason: 'cap_reached',
      periodStart: Date.UTC(2026, 10, 1),
      periodEnd: Date.UTC(2026, 11, 1),
      budgetUsd: 50,
      spendUsd: 50,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    };
    let pausedCell: string | null = null;
    harness = createHarness(defaultScript, undefined, (cellId) =>
      cellId === pausedCell ? paused : null,
    );
    const h = harness;
    const alpha = h.cells.create('Alpha');
    const beta = h.cells.create('Beta');
    pausedCell = alpha.id;
    paused.cellId = alpha.id;
    const alphaRequest = h.repo.create({ title: 'Alpha work', cellId: alpha.id });
    const betaRequest = h.repo.create({ title: 'Beta work', cellId: beta.id });

    await expect(h.engine.start(alphaRequest.id)).rejects.toBeInstanceOf(SpendCapError);

    const betaTurn = await h.engine.start(betaRequest.id);
    await betaTurn.promise;
    await settle();
    expect(h.repo.require(betaRequest.id).clarifyStarted).toBe(true);

    pausedCell = null;
    const alphaTurn = await h.engine.start(alphaRequest.id);
    await alphaTurn.promise;
    await settle();
    expect(h.repo.require(alphaRequest.id).clarifyStarted).toBe(true);
  });

  it('marks a request started when its first message is sent', async () => {
    const h = fresh(() => defaultScript());
    const request = h.repo.create({ title: 'Send first' });

    const turn = await h.engine.send(request.id, 'hello');
    await turn.promise;
    await settle();

    expect(h.repo.require(request.id).clarifyStarted).toBe(true);
  });

  it('ends a live turn when the request is disposed', async () => {
    const h = fresh(() => []);
    const request = h.repo.create({ title: 'Dispose me' });

    const turn = await h.engine.start(request.id);
    await settle();
    expect(h.engine.hasLive(request.id)).toBe(true);

    await h.engine.dispose(request.id);
    await turn.promise;
    await settle();

    expect(h.harness.process?.killed).toBe(true);
    expect(h.engine.hasLive(request.id)).toBe(false);
    expect(turn.events.find((event) => event.t === 'done')).toBeTruthy();
  });

  it('resumes the saved session id on the next spawn', async () => {
    const h = fresh(() => [initLine('sess-persist'), resultLine()]);
    const request = h.repo.create({ title: 'Remember me' });

    const first = await h.engine.start(request.id);
    await first.promise;
    await settle();

    h.engine.dispose(request.id);
    const second = await h.engine.send(request.id, 'carry on');
    await second.promise;
    await settle();

    expect(h.harness.sessions).toHaveLength(2);
    expect(h.harness.sessions[1]?.sessionId).toBe('sess-persist');
  });

  it('uses the configured default model when no request or cell model is set', async () => {
    const h = fresh(() => defaultScript());
    h.config.defaultModels = {
      ...h.config.defaultModels,
      claude: 'opencode-go/deepseek-v4.1-flash',
    };
    const request = h.repo.create({ title: 'Default model' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({
      model: 'opencode-go/deepseek-v4.1-flash',
    });
  });

  it('passes the cell auto-compaction percentage to request sessions only', async () => {
    let cellId = '';
    const h = createHarness(defaultScript, (id) =>
      id === cellId
        ? { model: null, effort: null, harness: null, autocompactPercent: 60 }
        : null,
    );
    harness = h;
    const cell = h.cells.create('Compact cell');
    cellId = cell.id;

    const assigned = h.repo.create({ title: 'Assigned', cellId: cell.id });
    await (await h.engine.start(assigned.id)).promise;
    await settle();

    const unassigned = h.repo.create({ title: 'Unassigned' });
    await (await h.engine.start(unassigned.id)).promise;
    await settle();

    await (await h.engine.startMaster('status', MASTER_SESSION_ID)).promise;
    await settle();

    await (await h.engine.startSetup('defaults', '__setup__:draft-1')).promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({ scope: 'request', autocompactPercent: 60 });
    expect(h.harness.sessions[1]).toMatchObject({ scope: 'request', autocompactPercent: 80 });
    expect(h.harness.sessions[2]).toMatchObject({ scope: 'master', autocompactPercent: null });
    expect(h.harness.sessions[3]).toMatchObject({ scope: 'setup', autocompactPercent: null });
  });

  it('uses cell model and effort defaults, with request overrides winning', async () => {
    const h = createHarness(defaultScript, () => ({
      model: 'cell-model',
      effort: 'high',
      harness: null,
    }));
    harness = h;
    const cell = h.cells.create('Cell', null, null, {
      maxConcurrent: 2,
      model: 'cell-model',
      effort: 'high',
    });
    const inherited = h.repo.create({ title: 'Inherit', cellId: cell.id });
    const turn = await h.engine.start(inherited.id);
    await turn.promise;
    await settle();
    expect(h.harness.sessions[0]).toMatchObject({ model: 'cell-model', effort: 'high' });

    const overridden = h.repo.create({ title: 'Override', cellId: cell.id });
    h.repo.edit(overridden.id, { model: 'request-model', effort: 'low' });
    const second = await h.engine.send(overridden.id, 'continue');
    await second.promise;
    await settle();
    expect(h.harness.sessions[1]).toMatchObject({ model: 'request-model', effort: 'low' });
  });

  it('transitions on the dispatch kickoff and tells the agent not to push', async () => {
    const h = fresh(() => defaultScript());
    const request = h.repo.create({ title: 'Build it' });

    const turn = await h.engine.kickoffDispatch(request.id);
    await turn.promise;
    await settle();

    expect(h.repo.require(request.id).state).toBe('dispatch');
    expect(h.repo.require(request.id).branch).toBeNull();
    expect(h.harness.process?.messages[0]).toContain('Do not push');
  });

  it('keeps the knowledge-base session read-only with no request scope', async () => {
    const h = fresh(() => defaultScript());

    const turn = await h.engine.startKb('what did we decide about cells?');
    await turn.promise;
    await settle();

    const session = h.harness.sessions[0];
    expect(session?.requestId).toBe('');
    expect(session?.pluginDirs).toEqual([]);

    const done = turn.events.find((event) => event.t === 'done');
    expect(done?.t).toBe('done');
    if (done?.t === 'done') expect(done.request).toBeNull();
    expect(h.engine.hasLive(KB_SESSION_ID)).toBe(false);
  });

  it('surfaces an agent exit as an error instead of hanging', async () => {
    const h = fresh(() => []);
    const request = h.repo.create({ title: 'Crashy' });

    const turn = await h.engine.start(request.id);
    await settle();
    h.harness.process?.emitExit(1);

    await turn.promise;
    await settle();

    const error = turn.events.find((event) => event.t === 'error');
    expect(error?.t).toBe('error');
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(h.engine.hasLive(request.id)).toBe(false);
  });

  it('includes recent child stderr when a process exits early', async () => {
    const h = fresh(() => []);
    const request = h.repo.create({ title: 'Stderr exit' });

    const turn = await h.engine.start(request.id);
    await settle();
    h.harness.process?.emitStderr('authentication failed: no credentials');
    h.harness.process?.emitExit(1);

    await turn.promise;
    await settle();

    const error = turn.events.find((event) => event.t === 'error');
    expect(error?.t).toBe('error');
    if (error?.t === 'error') {
      expect(error.message).toContain('authentication failed: no credentials');
    }
    expect(
      h.engine
        .transcript(request.id)
        .some((message) => message.text.includes('authentication failed: no credentials')),
    ).toBe(true);
  });

  it('surfaces a harness-reported error result once and persists it', async () => {
    const errorSpy = vi.fn();
    const h = freshWithErrors(
      () => [
        initLine('sess-error-result'),
        textLine('partial output'),
        errorResultLine('authentication expired', {
          usage: { input_tokens: 4, output_tokens: 2 },
          totalCostUsd: 0.002,
        }),
      ],
      { error: errorSpy },
    );
    const request = h.repo.create({ title: 'Expired auth' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    const errors = turn.events.filter((event) => event.t === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.t === 'error') expect(errors[0].message).toBe('authentication expired');

    const done = turn.events.find((event) => event.t === 'done');
    expect(done?.t).toBe('done');
    if (done?.t === 'done') {
      expect(
        done.transcript.filter((message) => message.text === '⚠ authentication expired'),
      ).toHaveLength(1);
    }
    expect(
      h.engine.transcript(request.id).filter((message) => message.text === '⚠ authentication expired'),
    ).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('engine.result');
    expect(errorSpy.mock.calls[0]?.[2]).toMatchObject({
      session: request.id,
      harness: 'claude',
      request: request.id,
    });
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(h.repo.require(request.id).unchecked).toBe(true);
    expect(h.engine.hasLive(request.id)).toBe(false);
    expect(turn.events.filter((event) => event.t === 'done')).toHaveLength(1);
    expect(h.usage.query({}).totals.turns).toBe(1);
  });

  it('reports a harness error result as one failed-turn event', async () => {
    const failures: TurnFailureNotification[] = [];
    const h = freshWithTurnFailures(
      () => [initLine('sess-notify-error'), errorResultLine('authentication expired')],
      failures,
    );
    const cell = h.cells.create('Alpha');
    const request = h.repo.create({ title: 'Notify this failure', cellId: cell.id });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      turnId: turn.turnId,
      requestId: request.id,
      requestTitle: 'Notify this failure',
      state: 'clarify',
      cellId: cell.id,
      harness: 'claude',
      source: 'engine.result',
      reason: 'harness error result',
    });
    expect(failures[0]?.occurredAt).toEqual(expect.any(Number));
  });

  it('reports a process exit with only its code, not stderr', async () => {
    const failures: TurnFailureNotification[] = [];
    const h = freshWithTurnFailures(() => [], failures);
    const request = h.repo.create({ title: 'Crashy notify' });

    const turn = await h.engine.start(request.id);
    await settle();
    h.harness.process?.emitStderr('token=super-secret');
    h.harness.process?.emitExit(7);
    await turn.promise;
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      source: 'engine.exit',
      reason: 'process exited with code 7',
    });
    expect(JSON.stringify(failures)).not.toContain('super-secret');
  });

  it('reports a timeout as a failure and never forwards stderr', async () => {
    const failures: TurnFailureNotification[] = [];
    const h = freshWithTurnFailures(() => [], failures, { turnTimeoutMs: 10 });
    const request = h.repo.create({ title: 'Slow notify' });

    const turn = await h.engine.start(request.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await turn.promise;
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.source).toBe('engine.timeout');
    expect(failures[0]?.reason).toMatch(/^timeout after /);
  });

  it('reports an engine exception without raw error text', async () => {
    const failures: TurnFailureNotification[] = [];
    const h = freshWithTurnFailures(defaultScript, failures);
    (
      h.harness as unknown as { prepare: () => Promise<never> }
    ).prepare = async () => {
      throw new Error('/definitely/secret/path');
    };
    const request = h.repo.create({ title: 'Broken worktree' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      source: 'engine.turn',
      reason: 'engine error',
    });
    expect(JSON.stringify(failures)).not.toContain('/definitely/secret/path');
    expect(turn.events.filter((event) => event.t === 'error')).toHaveLength(1);
    expect(turn.events.filter((event) => event.t === 'done')).toHaveLength(1);
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(h.repo.require(request.id).unchecked).toBe(true);
    expect(
      h.engine
        .transcript(request.id)
        .some((message) => message.kind === 'text' && message.text.startsWith('⚠')),
    ).toBe(true);
  });

  it('resolves the turn promise when the harness spawn throws', async () => {
    const failures: TurnFailureNotification[] = [];
    const h = freshWithTurnFailures(defaultScript, failures);
    (h.harness as unknown as { spawn: () => never }).spawn = () => {
      throw new Error('spawn failed');
    };
    const request = h.repo.create({ title: 'Broken spawn' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      source: 'engine.turn',
      reason: 'engine error',
    });
    expect(turn.events.filter((event) => event.t === 'done')).toHaveLength(1);
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
  });

  it('does not report successful, cancelled, or non-request turns', async () => {
    const failures: TurnFailureNotification[] = [];
    const h = freshWithTurnFailures(defaultScript, failures);
    const request = h.repo.create({ title: 'Successful' });
    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    const cancelled = h.repo.create({ title: 'Cancelled' });
    const live = await h.engine.start(cancelled.id);
    h.engine.cancel(cancelled.id);
    await live.promise;
    await settle();

    const kb = await h.engine.startKb('seed');
    await kb.promise;
    await settle();

    expect(failures).toHaveLength(0);
  });

  it('does not let a throwing failure hook change the turn outcome', async () => {
    const errorSpy = vi.fn();
    const h = freshWithErrors(() => [initLine('sess-hook-throw'), errorResultLine('boom')], {
      error: errorSpy,
    });
    const request = h.repo.create({ title: 'Hook throws' });
    // Replace the hook after construction so the turn still completes normally.
    const failures: TurnFailureNotification[] = [];
    (
      h.engine as unknown as {
        deps: { onTurnFailure?: (event: TurnFailureNotification) => void };
      }
    ).deps.onTurnFailure = () => {
      throw new Error('hook exploded');
    };

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(failures).toHaveLength(0);
    expect(turn.events.some((event) => event.t === 'done')).toBe(true);
    expect(errorSpy.mock.calls.some(([source]) => source === 'notifications.event')).toBe(true);
  });

  it('does not report a successful result as an error', async () => {
    const errorSpy = vi.fn();
    const h = freshWithErrors(defaultScript, { error: errorSpy });
    const request = h.repo.create({ title: 'Successful turn' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(turn.events.some((event) => event.t === 'error')).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(h.engine.transcript(request.id).some((message) => message.text.startsWith('⚠'))).toBe(
      false,
    );
  });

  it('persists a fallback warning when an error result carries no text', async () => {
    const h = freshWithErrors(() => [initLine('sess-empty-error'), errorResultLine()], {
      error: vi.fn(),
    });
    const request = h.repo.create({ title: 'Empty error' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    const error = turn.events.find((event) => event.t === 'error');
    expect(error?.t).toBe('error');
    if (error?.t === 'error') expect(error.message).toBe('agent reported an error');
    expect(
      h.engine.transcript(request.id).filter((message) => message.text === '⚠ agent reported an error'),
    ).toHaveLength(1);
  });

  it('suppresses duplicate error events and a late exit', async () => {
    const errorSpy = vi.fn();
    const h = freshWithErrors(
      () => [initLine('sess-duplicate-error'), errorResultLine('first failure'), errorResultLine('second failure')],
      { error: errorSpy },
    );
    const request = h.repo.create({ title: 'Duplicate error' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();
    h.harness.process?.emitExit(1);
    await settle();

    const errors = turn.events.filter((event) => event.t === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.t === 'error') expect(errors[0].message).toBe('first failure');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const warnings = h.engine
      .transcript(request.id)
      .filter((message) => message.kind === 'text' && message.text.startsWith('⚠'));
    expect(warnings.map((message) => message.text)).toEqual(['⚠ first failure']);
    expect(turn.events.filter((event) => event.t === 'done')).toHaveLength(1);
  });

  it('persists a repeated identical error once per turn', async () => {
    const h = freshWithErrors(
      () => [initLine('sess-repeat-error'), errorResultLine('rate limited')],
      { error: vi.fn() },
    );
    const request = h.repo.create({ title: 'Repeat error' });

    const first = await h.engine.start(request.id);
    await first.promise;
    await settle();
    const second = await h.engine.send(request.id, 'try again');
    await second.promise;
    await settle();

    expect(
      h.engine.transcript(request.id).filter((message) => message.text === '⚠ rate limited'),
    ).toHaveLength(2);
    expect(first.events.filter((event) => event.t === 'error')).toHaveLength(1);
    expect(second.events.filter((event) => event.t === 'error')).toHaveLength(1);
  });

  it('persists and logs an OpenCode error event once', async () => {
    const errorSpy = vi.fn();
    const h = freshWithErrors(
      () => [line({ type: 'error', message: 'provider unavailable' })],
      { error: errorSpy },
    );
    h.opencode.parserFactory = (transcript) => new OpencodeTurnParser(transcript);
    const request = h.repo.create({ title: 'OpenCode error', harness: 'opencode' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();
    h.opencode.process?.emitExit(1);
    await settle();

    const errors = turn.events.filter((event) => event.t === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.t === 'error') expect(errors[0].message).toBe('provider unavailable');
    expect(
      h.engine.transcript(request.id).filter((message) => message.text === '⚠ provider unavailable'),
    ).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('engine.result');
    expect(errorSpy.mock.calls[0]?.[2]).toMatchObject({
      session: request.id,
      harness: 'opencode',
      request: request.id,
    });
    expect(turn.events.filter((event) => event.t === 'done')).toHaveLength(1);
  });

  it('times out a silent turn and emits an error plus done', async () => {
    const h = fresh(() => []);
    h.config.turnTimeoutMs = 25;
    const request = h.repo.create({ title: 'Silent' });

    const turn = await h.engine.start(request.id);
    await settle();
    h.harness.process?.emitStderr('stuck in MCP handshake');
    await new Promise((resolve) => setTimeout(resolve, 75));
    await turn.promise;
    await settle();

    const error = turn.events.find((event) => event.t === 'error');
    expect(error?.t).toBe('error');
    if (error?.t === 'error') {
      expect(error.message).toContain('timed out after');
      expect(error.message).toContain('stuck in MCP handshake');
    }
    expect(turn.events.some((event) => event.t === 'done')).toBe(true);
    const done = turn.events.find((event) => event.t === 'done');
    if (done?.t === 'done') {
      expect(done.transcript.some((message) => message.text.includes('timed out after'))).toBe(
        true,
      );
    }
    expect(h.harness.process?.killed).toBe(true);
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
    expect(h.engine.hasLive(request.id)).toBe(false);
    expect(
      h.engine.transcript(request.id).some((message) => message.text.includes('timed out after')),
    ).toBe(true);
    expect(h.usage.query({}).totals.turns).toBe(0);
  });
});

describe('request worktree branches', () => {
  it('creates the worktree on aps/<id> and records the branch', async () => {
    const h = fresh();
    const repo = gitRepo();
    const request = h.repo.create({ title: 'Branch me', targetRepo: repo });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    const dir = path.join(h.config.dataDir, 'worktrees', request.id);
    expect(h.repo.require(request.id).branch).toBe(`aps/${request.id}`);
    expect(existsSync(dir)).toBe(true);
    expect(h.harness.commands[0]?.cwd).toBe(dir);
  });

  it('reuses a legacy sbox/<id> branch and keeps it in the dispatch prompt', async () => {
    const h = fresh();
    const repo = gitRepo();
    const request = h.repo.create({ title: 'Legacy branch', targetRepo: repo });
    execFileSync('git', ['-C', repo, 'branch', `sbox/${request.id}`]);
    h.repo.setBranch(request.id, `sbox/${request.id}`);

    const turn = await h.engine.kickoffDispatch(request.id);
    await turn.promise;
    await settle();

    expect(h.repo.require(request.id).branch).toBe(`sbox/${request.id}`);
    expect(gitBranches(repo)).not.toContain(`aps/${request.id}`);
    const prompt = h.harness.process?.messages[0] ?? '';
    expect(prompt).toContain(`sbox/${request.id}`);
    expect(prompt).not.toContain(`aps/${request.id}`);
    expect(h.harness.commands[0]?.cwd).toBe(
      path.join(h.config.dataDir, 'worktrees', request.id),
    );
  });
});

describe('terminal legacy branch cleanup', () => {
  function errorSink(): { errors: ErrorSink; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      errors: {
        error: (source, error, context) =>
          calls.push({ source, error, ...(context ?? {}) }),
      },
    };
  }

  function commitOn(repo: string, parent: string, text: string): string {
    const tree = execFileSync('git', ['-C', repo, 'rev-parse', `${parent}^{tree}`], {
      encoding: 'utf8',
    }).trim();
    return execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.email=a@b',
        '-c',
        'user.name=t',
        'commit-tree',
        tree,
        '-p',
        parent,
        '-m',
        text,
      ],
      { encoding: 'utf8' },
    ).trim();
  }

  it('renames a legacy branch after a terminal dispose removes the worktree', async () => {
    const h = fresh(defaultScript);
    const repo = gitRepo();
    const request = h.repo.create({ title: 'Finish legacy work', targetRepo: repo });
    execFileSync('git', ['-C', repo, 'branch', `sbox/${request.id}`]);
    h.repo.setBranch(request.id, `sbox/${request.id}`);
    const dir = path.join(h.config.dataDir, 'worktrees', request.id);

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();
    expect(existsSync(dir)).toBe(true);

    h.repo.transition(request.id, 'dropped');
    const updatedAt = h.repo.require(request.id).updatedAt;
    await h.engine.dispose(request.id);

    expect(existsSync(dir)).toBe(false);
    expect(gitBranches(repo)).not.toContain(`sbox/${request.id}`);
    expect(gitBranches(repo)).toContain(`aps/${request.id}`);
    const stored = h.repo.require(request.id);
    expect(stored.branch).toBe(`aps/${request.id}`);
    expect(stored.updatedAt).toBe(updatedAt);
  });

  it('leaves a legacy branch alone when dispose is not terminal', async () => {
    const h = fresh(defaultScript);
    const repo = gitRepo();
    const request = h.repo.create({ title: 'Still in flight', targetRepo: repo });
    execFileSync('git', ['-C', repo, 'branch', `sbox/${request.id}`]);
    h.repo.setBranch(request.id, `sbox/${request.id}`);
    const dir = path.join(h.config.dataDir, 'worktrees', request.id);

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();
    await h.engine.dispose(request.id);

    expect(existsSync(dir)).toBe(false);
    expect(gitBranches(repo)).toContain(`sbox/${request.id}`);
    expect(gitBranches(repo)).not.toContain(`aps/${request.id}`);
    expect(h.repo.require(request.id).branch).toBe(`sbox/${request.id}`);
  });

  it('logs a diverged pair and leaves both refs for manual review', async () => {
    const { errors, calls } = errorSink();
    const h = freshWithErrors(defaultScript, errors);
    const repo = gitRepo();
    const request = h.repo.create({ title: 'Diverged work', targetRepo: repo });
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', repo, 'branch', `sbox/${request.id}`, commitOn(repo, base, 'legacy')]);
    execFileSync('git', ['-C', repo, 'branch', `aps/${request.id}`, commitOn(repo, base, 'canonical')]);
    h.repo.setBranch(request.id, `sbox/${request.id}`);
    h.repo.transition(request.id, 'dropped');

    await h.engine.dispose(request.id);

    expect(gitBranches(repo)).toContain(`sbox/${request.id}`);
    expect(gitBranches(repo)).toContain(`aps/${request.id}`);
    expect(h.repo.require(request.id).branch).toBe(`sbox/${request.id}`);
    expect(calls).toEqual([
      expect.objectContaining({
        source: 'maintenance.legacy-branches',
        requestId: request.id,
        action: 'skip-diverged',
        phase: 'transition',
      }),
    ]);
  });

  it('treats a missing target repo as a silent no-op', async () => {
    const { errors, calls } = errorSink();
    const h = freshWithErrors(defaultScript, errors);
    const absent = path.join(h.config.dataDir, 'missing-repo');
    const request = h.repo.create({ title: 'No checkout', targetRepo: absent });
    h.repo.setBranch(request.id, `sbox/${request.id}`);
    h.repo.transition(request.id, 'dropped');

    await expect(h.engine.dispose(request.id)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(h.repo.require(request.id).branch).toBe(`sbox/${request.id}`);
  });
});
