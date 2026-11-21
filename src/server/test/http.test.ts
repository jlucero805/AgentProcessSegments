import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelCatalog, HARDCODED_MODELS } from '../src/clarify/models.js';
import { buildServer } from '../src/http/server.js';
import { createHarness, type Harness } from './helpers.js';

interface Open {
  h: Harness;
  app: FastifyInstance;
  base: string;
}

let open: Open | null = null;

async function makeApp(): Promise<Open> {
  const h = createHarness();
  const app = await buildServer({
    repo: h.repo,
    cells: h.cells,
    kb: h.kb,
    engine: h.engine,
    models: new ModelCatalog({ probeModels: async () => null, fallbackModels: HARDCODED_MODELS }),
    plugins: h.plugins,
    config: h.config,
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

  it('serves the clarify snapshot and reports an idle stream', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Snapshot' });

    const snapshot = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.json()).toEqual({ started: false, transcript: [] });

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
    const body = response.json() as { source: string; effortLevels: string[]; models: unknown[] };
    expect(body.source).toBe('fallback');
    expect(body.effortLevels).toContain('xhigh');
    expect(body.models.length).toBeGreaterThan(0);
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
