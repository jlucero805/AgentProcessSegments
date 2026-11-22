import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHarness, defaultScript, initLine, resultLine, settle, textLine, type Harness } from './helpers.js';
import { KB_SESSION_ID, MASTER_SESSION_ID } from '../src/clarify/engine.js';
import { requestDir } from '../src/config.js';
import { summarySessionId } from '../src/domain/sessions.js';

let harness: Harness | null = null;

function fresh(script?: (text: string) => string[]): Harness {
  harness = createHarness(script);
  return harness;
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
    const h = fresh((text) => [initLine('sess-stop')]);
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
    expect(first.events.some((event) => event.t === 'done')).toBe(true);
    expect(h.engine.cancel(request.id)).toBe(false);

    const second = await h.engine.send(request.id, 'interject');
    await settle();
    h.harness.process?.emit(resultLine());
    await second.promise;
    await settle();
    expect(h.harness.sessions[1]?.sessionId).toBe('sess-stop');
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
