import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelCatalog, HARDCODED_MODELS } from '../src/clarify/models.js';
import { MASTER_SESSION_ID } from '../src/clarify/engine.js';
import { buildServer } from '../src/http/server.js';
import { MasterEventRepository } from '../src/master/events.js';
import { MasterScheduler } from '../src/master/scheduler.js';
import { MasterService } from '../src/master/service.js';
import { defaultProcess } from '../src/process/defaults.js';
import { ProcessStore } from '../src/process/store.js';
import { SettingsStore } from '../src/settings.js';
import { SkillCatalog } from '../src/skills/catalog.js';
import { createHarness, resultLine, settle, type Harness } from './helpers.js';

interface Open {
  h: Harness;
  app: FastifyInstance;
  base: string;
}

let open: Open | null = null;

async function makeApp(
  config: Partial<Harness['config']> = {},
  script?: (text: string) => string[],
): Promise<Open> {
  const h = createHarness(script);
  const settings = new SettingsStore(h.config.configPath);
  const process = new ProcessStore(h.config.processPath, () => defaultProcess(settings.get().master));
  const skills = new SkillCatalog({ home: h.config.dataDir, cwd: h.config.dataDir, env: {} });
  const masterEvents = new MasterEventRepository(h.db);
  const master = new MasterScheduler(
    new MasterService({ repo: h.repo, cells: h.cells, engine: h.engine, settings, events: masterEvents, process }),
    settings,
    h.cells,
  );
  const app = await buildServer({
    repo: h.repo,
    cells: h.cells,
    kb: h.kb,
    engine: h.engine,
    models: new ModelCatalog({ probeModels: async () => null, fallbackModels: HARDCODED_MODELS }),
    plugins: h.plugins,
    settings,
    master,
    masterEvents,
    process,
    skills,
    config: { ...h.config, ...config },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  open = { h, app, base: `http://127.0.0.1:${port}` };
  return open;
}

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: () => any; text: string }> {
  if (!open) throw new Error('no server');
  const response = await fetch(`${open.base}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: () => (text === '' ? null : JSON.parse(text)),
  };
}

afterEach(async () => {
  if (open) {
    await open.app.close();
    open.h.db.close();
    open = null;
  }
});

describe('http api', () => {
  it('reports health', async () => {
    await makeApp();
    const response = await call('GET', '/health');
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('reports terminal availability without starting a shell', async () => {
    const { h } = await makeApp();
    const response = await call('GET', '/api/terminal');
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ available: true, cwd: h.config.terminalCwd });
  });

  it('creates, reads, and lists requests', async () => {
    await makeApp();

    const created = await call('POST', '/api/requests', { title: 'First', body: 'body text' });
    expect(created.status).toBe(201);
    const request = created.json() as { id: string; state: string };
    expect(request.state).toBe('clarify');

    const fetched = await call('GET', `/api/requests/${request.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json().title).toBe('First');

    const listed = await call('GET', '/api/requests?view=intake');
    expect(listed.json()).toHaveLength(1);
  });

  it('rejects a request pointed at a missing cell', async () => {
    const { h } = await makeApp();
    const cell = h.cells.create('Alpha');

    const missing = await call('POST', '/api/requests', { title: 'x', cellId: 'ghost' });
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe('not_found');

    const created = await call('POST', '/api/requests', { title: 'x', cellId: cell.id });
    expect(created.status).toBe(201);
    expect(created.json().cellId).toBe(cell.id);

    const badPatch = await call('PATCH', `/api/requests/${created.json().id}`, {
      cellId: 'ghost',
    });
    expect(badPatch.status).toBe(404);
  });

  it('starts workflow turns without holding the response open when detach=1', async () => {
    const { h } = await makeApp({}, () => []);
    const startRequest = h.repo.create({ title: 'Detached start' });
    const dispatchRequest = h.repo.create({ title: 'Detached dispatch' });

    const started = await call(
      'POST',
      `/api/requests/${startRequest.id}/clarify/start?detach=1`,
    );
    expect(started.status).toBe(200);
    expect(started.json()).toEqual({ started: true });
    expect(h.engine.hasLive(startRequest.id)).toBe(true);

    const dispatched = await call(
      'POST',
      `/api/requests/${dispatchRequest.id}/dispatch?detach=1`,
    );
    expect(dispatched.status).toBe(200);
    expect(dispatched.json()).toEqual({ started: true });
    expect(h.repo.require(dispatchRequest.id).state).toBe('dispatch');

    await call('POST', `/api/requests/${startRequest.id}/drop`);
    await call('POST', `/api/requests/${dispatchRequest.id}/drop`);
  });

  it('maps validation, missing, and illegal transitions to the documented codes', async () => {
    await makeApp();

    const invalid = await call('POST', '/api/requests', { title: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.json().error).toBe('invalid');

    const missing = await call('GET', '/api/requests/nope');
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe('not_found');

    const created = await call('POST', '/api/requests', { title: 'x' });
    const { id } = created.json() as { id: string };

    const illegal = await call('POST', `/api/requests/${id}/transition`, { to: 'done' });
    expect(illegal.status).toBe(409);
    expect(illegal.json().error).toBe('illegal_transition');
  });

  it('patches fields and clears unchecked on seen', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Patch me' });
    h.repo.setUnchecked(request.id, true);

    const patched = await call('PATCH', `/api/requests/${request.id}`, {
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      skills: ['tdd'],
      kbDigest: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json()).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', kbDigest: false });
    expect(patched.json().skills).toEqual(['tdd']);

    const seen = await call('POST', `/api/requests/${request.id}/seen`);
    expect(seen.json().unchecked).toBe(false);
  });

  it('reads and patches master settings through the API', async () => {
    const { h } = await makeApp();
    const before = await call('GET', '/api/config');
    expect(before.status).toBe(200);
    expect(before.json()).toMatchObject({
      path: h.config.configPath,
      master: { intervalMinutes: 5, idleMinutes: 10, enabled: true },
    });

    const patched = await call('PATCH', '/api/config', {
      master: { intervalMinutes: 7, enabled: false },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().master).toMatchObject({
      intervalMinutes: 7,
      enabled: false,
      idleMinutes: 10,
    });

    const after = await call('GET', '/api/config');
    expect(after.json().master.intervalMinutes).toBe(7);

    const bad = await call('PATCH', '/api/config', { master: { intervalMinutes: 0 } });
    expect(bad.status).toBe(400);
  });

  it('reads and patches process segments through the API', async () => {
    await makeApp();

    const before = await call('GET', '/api/process');
    expect(before.status).toBe(200);
    expect(before.json().segments).toHaveLength(5);
    expect(before.json().path).toContain('process.json');
    const segments = before.json().segments as Array<{ id: string; enabled: boolean }>;
    const intake = segments.find((segment) => segment.id === 'intake');
    expect(intake).toBeDefined();
    intake!.enabled = true;

    const patched = await call('PATCH', '/api/process', { segments });
    expect(patched.status).toBe(200);
    expect(patched.json().segments.find((segment: { id: string }) => segment.id === 'intake').enabled).toBe(
      true,
    );

    const after = await call('GET', '/api/process');
    expect(after.json().segments.find((segment: { id: string }) => segment.id === 'intake').enabled).toBe(
      true,
    );

    const bad = await call('PATCH', '/api/process', {
      segments: [{ id: 'intake' }, { id: 'intake' }],
    });
    expect(bad.status).toBe(400);
  });

  it('reports master status, runs a cycle, and lists events', async () => {
    await makeApp();
    const status = await call('GET', '/api/master/status');
    expect(status.status).toBe(200);
    expect(status.json()).toMatchObject({ enabled: true, running: false, intervalMinutes: 5 });

    const run = await call('POST', '/api/master/run');
    expect(run.status).toBe(200);
    expect(run.json()).toMatchObject({ prodded: 0, reviewed: 0, dispatch: 0 });

    const events = await call('GET', '/api/master/events?limit=10');
    expect(events.status).toBe(200);
    expect(Array.isArray(events.json())).toBe(true);
  });

  it('creates a cell with its own process and can replace it', async () => {
    await makeApp();
    const configured = (await call('GET', '/api/process')).json().segments as Array<{
      id: string;
      enabled: boolean;
    }>;
    const intake = configured.find((segment) => segment.id === 'intake');
    if (!intake) throw new Error('missing intake');
    intake.enabled = true;

    const created = await call('POST', '/api/cells', {
      name: 'Strict repo',
      process: { version: 1, segments: configured },
      masterIntervalMinutes: 3,
      maxConcurrent: 2,
      model: 'cell-model',
      effort: 'high',
    });
    expect(created.status).toBe(201);
    expect(created.json().masterIntervalMinutes).toBe(3);
    expect(created.json().maxConcurrent).toBe(2);
    expect(created.json().model).toBe('cell-model');
    expect(created.json().effort).toBe('high');
    expect(
      created
        .json()
        .process.segments.find((segment: { id: string }) => segment.id === 'intake').enabled,
    ).toBe(true);

    const detail = await call('GET', `/api/cells/${created.json().id}`);
    expect(detail.json().process.segments).toHaveLength(5);

    const cleared = await call('PATCH', `/api/cells/${created.json().id}`, { process: null });
    expect(cleared.json().process).toBeNull();
  });

  it('toggles a cell master through the cells patch', async () => {
    await makeApp();
    const created = await call('POST', '/api/cells', { name: 'Mastered' });
    expect(created.json().masterEnabled).toBe(true);

    const patched = await call('PATCH', `/api/cells/${created.json().id}`, {
      masterEnabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json().masterEnabled).toBe(false);

    const listed = await call('GET', '/api/cells');
    expect(listed.json()[0].masterEnabled).toBe(false);
  });

  it('serves the clarify snapshot and reports an idle stream', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Snapshot' });

    const snapshot = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.json()).toEqual({ started: false, transcript: [], active: false });

    const idle = await call('GET', `/api/requests/${request.id}/clarify/stream`);
    expect(idle.json()).toEqual({ active: false });
  });

  it('creates cells, renames them, and detaches requests on delete', async () => {
    const { h } = await makeApp();

    const created = await call('POST', '/api/cells', { name: 'Floor 1' });
    expect(created.status).toBe(201);
    const cell = created.json() as { id: string; name: string };

    const request = h.repo.create({ title: 'In a cell', cellId: cell.id });

    const renamed = await call('PATCH', `/api/cells/${cell.id}`, { name: 'Floor One' });
    expect(renamed.json().name).toBe('Floor One');

    const removed = await call('DELETE', `/api/cells/${cell.id}`);
    expect(removed.status).toBe(204);
    expect(h.repo.require(request.id).cellId).toBeNull();

    const list = await call('GET', '/api/cells');
    expect(list.json()).toEqual([]);
  });

  it('stores knowledge-base entries', async () => {
    await makeApp();
    const created = await call('POST', '/api/kb', {
      requestId: 'r1',
      title: 'Digest',
      content: 'what we learned',
    });
    expect(created.status).toBe(201);

    const list = await call('GET', '/api/kb');
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].content).toBe('what we learned');

    const search = await call('GET', '/api/kb?q=learned');
    expect(search.json()).toHaveLength(1);
    expect(search.json()[0].requestId).toBe('r1');

    const miss = await call('GET', '/api/kb?q=absent');
    expect(miss.json()).toEqual([]);
  });

  it('indexes a digest and finishes the request', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Ship it' });
    h.repo.transition(request.id, 'dispatch');
    h.repo.transition(request.id, 'review');
    h.repo.transition(request.id, 'finalize');

    const indexed = await call('POST', `/api/requests/${request.id}/index`, {
      digest: 'The decision we keep',
      index: true,
    });

    expect(indexed.status).toBe(200);
    expect(indexed.json().state).toBe('done');
    expect(indexed.json().digest).toBe('The decision we keep');
    expect(h.kb.getByRequest(request.id)?.content).toBe('The decision we keep');
  });

  it('drops a request and disposes its session', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Abandon' });

    const dropped = await call('POST', `/api/requests/${request.id}/drop`);
    expect(dropped.status).toBe(200);
    expect(dropped.json().state).toBe('dropped');
  });

  it('lists plugins and commands and maps plugin errors', async () => {
    await makeApp();

    expect((await call('GET', '/api/plugins')).json()).toEqual([]);
    expect((await call('GET', '/api/commands')).json()).toEqual([]);
    expect((await call('GET', '/api/skills')).json()).toEqual([]);

    const bad = await call('POST', '/api/plugins', { url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toBe('bad_source');

    const missing = await call('DELETE', '/api/plugins/ghost');
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe('not_found');
  });

  it('falls back to the hardcoded model list when the CLI is absent', async () => {    await makeApp();
    const response = await call('GET', '/api/models');

    expect(response.status).toBe(200);
    const body = response.json() as {
      source: string;
      effortLevels: string[];
      models: unknown[];
      harness: string;
      supportsEffort: boolean;
    };
    expect(body.source).toBe('fallback');
    expect(body.effortLevels).toContain('xhigh');
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.harness).toBe('claude');
    expect(body.supportsEffort).toBe(true);
  });

  it('reports an OpenCode harness without effort support', async () => {
    await makeApp({ harness: 'opencode', harnessBin: 'opencode' });
    const response = await call('GET', '/api/models');

    expect(response.status).toBe(200);
    const body = response.json() as { harness: string; supportsEffort: boolean };
    expect(body.harness).toBe('opencode');
    expect(body.supportsEffort).toBe(false);
  });

  it('reports a live clarify turn and clears it when the turn finishes', async () => {
    const { h } = await makeApp({}, () => []);
    const request = h.repo.create({ title: 'Live snapshot' });

    const turn = await h.engine.start(request.id);
    const live = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(live.status).toBe(200);
    expect(live.json()).toMatchObject({ started: true, active: true });

    h.harness.process?.emit(resultLine());
    await turn.promise;
    await settle();

    const after = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(after.json().active).toBe(false);
  });

  it('serves the master chat and scheduler notes', async () => {
    const { h } = await makeApp();
    h.engine.note(MASTER_SESSION_ID, 'Master cycle: 1 queued, 1 prodded');

    const snapshot = await call('GET', `/api/requests/${MASTER_SESSION_ID}/clarify`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.json()).toMatchObject({ started: true, active: false });
    expect(
      snapshot.json().transcript.some((message: { text: string }) =>
        message.text.includes('Master cycle'),
      ),
    ).toBe(true);

    const sent = await call('POST', `/api/requests/${MASTER_SESSION_ID}/clarify/send`, {
      text: 'what are you doing?',
    });
    expect(sent.status).toBe(200);
    expect(sent.text).toContain('"t":"done"');
    expect(h.harness.sessions[0]).toMatchObject({ scope: 'master', requestId: '' });
  });

  it('serves a separate master chat and status per cell', async () => {
    const { h } = await makeApp();
    const cell = h.cells.create('Alpha', null, 3);
    const session = `__master__:${cell.id}`;
    h.engine.note(session, 'Cell cycle: 1 prodded');

    const snapshot = await call('GET', `/api/requests/${session}/clarify`);
    expect(snapshot.status).toBe(200);
    expect(
      snapshot.json().transcript.some((message: { text: string }) =>
        message.text.includes('Cell cycle'),
      ),
    ).toBe(true);

    const sent = await call('POST', `/api/requests/${session}/clarify/send`, {
      text: 'what is this cell doing?',
    });
    expect(sent.status).toBe(200);
    expect(sent.text).toContain('"t":"done"');
    expect(h.harness.sessions[0]).toMatchObject({ scope: 'master', requestId: '' });

    const status = await call('GET', `/api/master/status?cellId=${cell.id}`);
    expect(status.json()).toMatchObject({ enabled: true, intervalMinutes: 3 });
  });

  it('stops a live turn over HTTP', async () => {
    const { h } = await makeApp({}, () => []);
    const request = h.repo.create({ title: 'Stop HTTP' });
    const turn = await h.engine.start(request.id);

    const stopped = await call('POST', `/api/requests/${request.id}/clarify/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.json()).toEqual({ stopped: true });

    await turn.promise;
    await settle();
    const snapshot = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(snapshot.json().active).toBe(false);

    const again = await call('POST', `/api/requests/${request.id}/clarify/stop`);
    expect(again.json()).toEqual({ stopped: false });
  });

  it('vends SPA assets added after boot and keeps missing assets as 404s', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-web-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><body>spa-index</body>');
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("asset")');
    await makeApp({ webDir: dir });

    const index = await call('GET', '/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('spa-index');

    const asset = await call('GET', '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.text).toContain('console.log');

    const deep = await call('GET', '/boards/abc');
    expect(deep.status).toBe(200);
    expect(deep.text).toContain('spa-index');

    const missing = await call('GET', '/assets/missing.js');
    expect(missing.status).toBe(404);
  });

  it('streams a clarify turn as NDJSON over a real socket', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Stream me' });

    const response = await fetch(`${open?.base}/api/requests/${request.id}/clarify/start`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');

    const body = await response.text();
    const events = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { t: string; text?: string });

    expect(events.map((event) => event.t)).toContain('text');
    expect(events.at(-1)?.t).toBe('done');
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
  });
});
