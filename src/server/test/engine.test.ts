import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, defaultScript, initLine, resultLine, settle, textLine, type Harness } from './helpers.js';
import { KB_SESSION_ID, MASTER_SESSION_ID } from '../src/clarify/engine.js';
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

  it('runs the master chat read-only and appends scheduler notes', async () => {
    const h = fresh(() => defaultScript());

    const turn = await h.engine.startMaster('what are you doing?');
    await turn.promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({ scope: 'master', requestId: '' });
    const transcript = h.engine.transcript(MASTER_SESSION_ID);
    expect(transcript.some((message) => message.text.includes('cell master'))).toBe(true);

    h.engine.note(MASTER_SESSION_ID, 'Master cycle: 0 queued, 0 prodded');
    expect(
      h.engine.transcript(MASTER_SESSION_ID).some((message) =>
        message.text.includes('Master cycle'),
      ),
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
    expect(h.engine.transcript(MASTER_SESSION_ID)).toHaveLength(0);

    h.engine.note(session, 'Cell cycle: 1 prodded');
    expect(
      h.engine.transcript(session).some((message) => message.text.includes('Cell cycle')),
    ).toBe(true);
  });

  it('runs the summary generator read-only in its own session', async () => {
    const h = createHarness(
      () => defaultScript(),
      () => ({ model: 'cell-model', effort: 'high' }),
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
    expect(h.engine.transcript(MASTER_SESSION_ID)).toHaveLength(0);
    expect(h.repo.require(request.id).agentStatus).toBe('none');
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
    h.config.defaultModel = 'opencode-go/deepseek-v4.1-flash';
    const request = h.repo.create({ title: 'Default model' });

    const turn = await h.engine.start(request.id);
    await turn.promise;
    await settle();

    expect(h.harness.sessions[0]).toMatchObject({
      model: 'opencode-go/deepseek-v4.1-flash',
    });
  });

  it('uses cell model and effort defaults, with request overrides winning', async () => {
    const h = createHarness(defaultScript, () => ({
      model: 'cell-model',
      effort: 'high',
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
  });
});
