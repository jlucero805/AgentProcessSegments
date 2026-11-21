import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, defaultScript, initLine, resultLine, settle, textLine, type Harness } from './helpers.js';
import { KB_SESSION_ID } from '../src/clarify/engine.js';

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
    expect(h.harness.process?.messages[0]).toContain('Groom me');
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

  it('marks a request started when its first message is sent', async () => {
    const h = fresh(() => defaultScript());
    const request = h.repo.create({ title: 'Send first' });

    const turn = await h.engine.send(request.id, 'hello');
    await turn.promise;
    await settle();

    expect(h.repo.require(request.id).clarifyStarted).toBe(true);
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
});
