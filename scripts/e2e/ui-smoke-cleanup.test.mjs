import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupUiSmokeArtifacts } from './ui-smoke-cleanup.mjs';

function response(status, body = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET' };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

test('captured ids are dropped before the cell is deleted', async () => {
  const { calls, fetchImpl } = createFetch(({ url, method }) => {
    if (url === 'http://brain.example/api/requests/req-1/drop' && method === 'POST') {
      return response(200, {});
    }
    if (url === 'http://brain.example/api/cells/cell-1' && method === 'DELETE') {
      return response(204);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });

  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example/',
    request: { id: 'req-1', title: 'Browser smoke' },
    cell: { id: 'cell-1', name: 'Smoke cell' },
    fetchImpl,
  });

  assert.deepEqual(failures, []);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      'POST http://brain.example/api/requests/req-1/drop',
      'DELETE http://brain.example/api/cells/cell-1',
    ],
  );
});

test('missing ids resolve by exact name outside the baseline', async () => {
  const requests = [
    { id: 'old-request', title: 'Browser smoke' },
    { id: 'new-request', title: 'Browser smoke' },
    { id: 'lookalike-request', title: 'Browser smoke extra' },
  ];
  const cells = [
    { id: 'old-cell', name: 'Smoke cell' },
    { id: 'new-cell', name: 'Smoke cell' },
    { id: 'lookalike-cell', name: 'Smoke cell extra' },
  ];
  const { calls, fetchImpl } = createFetch(({ url, method }) => {
    if (url === 'http://brain.example/api/requests' && method === 'GET') {
      return response(200, requests);
    }
    if (url === 'http://brain.example/api/cells' && method === 'GET') {
      return response(200, cells);
    }
    if (url === 'http://brain.example/api/requests/new-request/drop' && method === 'POST') {
      return response(200, {});
    }
    if (url === 'http://brain.example/api/cells/new-cell' && method === 'DELETE') {
      return response(204);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });

  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    request: { title: 'Browser smoke' },
    cell: { name: 'Smoke cell' },
    baselineRequestIds: new Set(['old-request']),
    baselineCellIds: new Set(['old-cell']),
    fetchImpl,
  });

  assert.deepEqual(failures, []);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      'GET http://brain.example/api/requests',
      'GET http://brain.example/api/cells',
      'POST http://brain.example/api/requests/new-request/drop',
      'DELETE http://brain.example/api/cells/new-cell',
    ],
  );
});

test('an empty list leaves no artifact actions', async () => {
  const { calls, fetchImpl } = createFetch(({ url, method }) => {
    if (method !== 'GET') throw new Error(`unexpected ${method} ${url}`);
    return response(200, []);
  });

  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    request: { title: 'Browser smoke' },
    cell: { name: 'Smoke cell' },
    baselineRequestIds: new Set(),
    baselineCellIds: new Set(),
    fetchImpl,
  });

  assert.deepEqual(failures, []);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ['GET http://brain.example/api/requests', 'GET http://brain.example/api/cells'],
  );
});

test('404 means the artifact is already gone', async () => {
  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    request: { id: 'req-1', title: 'Browser smoke' },
    cell: { id: 'cell-1', name: 'Smoke cell' },
    fetchImpl: async () => response(404),
  });

  assert.deepEqual(failures, []);
});

test('a failed drop still deletes the cell', async () => {
  const { calls, fetchImpl } = createFetch(({ url, method }) => {
    if (url.endsWith('/api/requests/req-1/drop') && method === 'POST') return response(500);
    if (url.endsWith('/api/cells/cell-1') && method === 'DELETE') return response(204);
    throw new Error(`unexpected ${method} ${url}`);
  });

  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    request: { id: 'req-1', title: 'Browser smoke' },
    cell: { id: 'cell-1', name: 'Smoke cell' },
    fetchImpl,
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'request');
  assert.match(failures[0].message, /500/);
  assert.ok(calls.some((call) => call.method === 'DELETE'));
});

test('a network failure is reported and never escapes', async () => {
  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    request: { id: 'req-1', title: 'Browser smoke' },
    cell: { id: 'cell-1', name: 'Smoke cell' },
    fetchImpl: async (_url, init = {}) => {
      if (init.method === 'POST') throw new Error('connection reset');
      return response(204);
    },
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'request');
  assert.match(failures[0].message, /connection reset/);
});

test('a failed list does not skip a known id', async () => {
  const { calls, fetchImpl } = createFetch(({ url, method }) => {
    if (url.endsWith('/api/cells') && method === 'GET') throw new Error('brain offline');
    if (url.endsWith('/api/requests/req-1/drop') && method === 'POST') return response(200, {});
    throw new Error(`unexpected ${method} ${url}`);
  });

  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    request: { id: 'req-1', title: 'Browser smoke' },
    cell: { name: 'Smoke cell' },
    baselineRequestIds: new Set(),
    baselineCellIds: new Set(),
    fetchImpl,
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'cell');
  assert.match(failures[0].message, /brain offline/);
  assert.ok(calls.some((call) => call.url.endsWith('/api/requests/req-1/drop')));
});

test('missing ids without a baseline are reported instead of matched by name', async () => {
  const { calls, fetchImpl } = createFetch(({ method, url }) => {
    throw new Error(`unexpected ${method} ${url}`);
  });

  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    request: { title: 'Browser smoke' },
    cell: { name: 'Smoke cell' },
    fetchImpl,
  });

  assert.equal(failures.length, 2);
  assert.deepEqual(calls, []);
});

test('an empty cleanup makes no requests', async () => {
  const { calls, fetchImpl } = createFetch(({ method, url }) => {
    throw new Error(`unexpected ${method} ${url}`);
  });

  const { failures } = await cleanupUiSmokeArtifacts({
    base: 'http://brain.example',
    fetchImpl,
  });

  assert.deepEqual(failures, []);
  assert.deepEqual(calls, []);
});
