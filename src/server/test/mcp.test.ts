import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_SERVER_KEY,
  MCP_SERVER_VERSION,
} from '../src/mcp/identity.js';
import { buildMcpServer, readMcpEnv, type FetchLike } from '../src/mcp/server.js';

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PARENT = {
  id: 'req-1',
  title: 'Scoped',
  cellId: 'cell-1',
  harness: 'opencode',
  targetRepo: 'https://example.test/repo',
};

function makeBrain(parent: Record<string, unknown> = PARENT): {
  calls: Recorded[];
  fetchImpl: FetchLike;
} {
  const calls: Recorded[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const parsed = new URL(url);
    calls.push({
      method,
      path: `${parsed.pathname}${parsed.search}`,
      body:
        typeof init?.body === 'string' && init.body !== ''
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });

    if (method === 'PATCH' && parsed.pathname.startsWith('/api/requests/')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ id: 'req-1', ...body });
    }
    if (method === 'POST' && parsed.pathname === '/api/kb') return json({ id: 'kb-1' }, 201);
    if (method === 'POST' && parsed.pathname === '/api/requests') {
      return json({ id: 'spawned' }, 201);
    }
    if (parsed.pathname === '/api/kb') return json([{ id: 'kb-1', content: 'cells are floors' }]);
    if (parsed.pathname === '/api/requests/req-1') return json(parent);
    if (parsed.pathname === '/api/requests') return json([{ id: 'req-1' }]);
    if (parsed.pathname === '/api/cell-drafts/draft-1') {
      return method === 'PATCH'
        ? json({ id: 'draft-1', ...(JSON.parse(String(init?.body)) as object) })
        : json({ id: 'draft-1', name: 'Draft' });
    }
    return json({ error: 'not_found' }, 404);
  };

  return { calls, fetchImpl };
}

let close: (() => Promise<void>) | null = null;

async function connect(
  requestId: string,
  scope?: 'request' | 'kb' | 'master' | 'setup',
  draftId?: string,
  options: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    parent?: Record<string, unknown>;
  } = {},
): Promise<{
  client: Client;
  calls: Recorded[];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
}> {
  const { calls, fetchImpl } = makeBrain(options.parent);
  const server = buildMcpServer({
    brainUrl: 'http://brain.test',
    requestId,
    scope,
    draftId,
    fetchImpl: options.fetchImpl ?? fetchImpl,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'mcp-test', version: '1.0.0' });
  await client.connect(clientTransport);

  close = async () => {
    await client.close();
    await server.close();
  };

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  return { client, calls, call };
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

afterEach(async () => {
  await close?.();
  close = null;
});

describe('bundled aps mcp server', () => {
  it('identifies as the bundled aps server', async () => {
    const { client } = await connect('req-1');
    expect(client.getServerVersion()).toMatchObject({
      name: MCP_SERVER_KEY,
      version: MCP_SERVER_VERSION,
    });
    expect(MCP_SERVER_VERSION).toBe('0.1.0');
  });

  it('exposes the request tools scoped to one request', async () => {
    const { client } = await connect('req-1');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_request',
      'index_to_kb',
      'list_requests',
      'spawn_request',
      'update_request',
    ]);
  });

  it('exposes only read tools to the knowledge-base session', async () => {
    const { client } = await connect('');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_kb', 'search_kb']);
  });

  it('gives the master chat read-only board and KB tools', async () => {
    const { client, call, calls } = await connect('', 'master');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_request',
      'list_kb',
      'list_requests',
      'search_kb',
    ]);

    const result = await call('get_request', { id: 'req-1' });
    expect(textOf(result)).toContain('Scoped');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/requests/req-1' });
  });

  it('gives the setup wizard only draft read/update', async () => {
    const { client, call, calls } = await connect('', 'setup', 'draft-1');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_cell_draft',
      'update_cell_draft',
    ]);

    await call('get_cell_draft');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/cell-drafts/draft-1' });

    const updated = await call('update_cell_draft', { maxConcurrent: 2 });
    expect(textOf(updated)).toContain('maxConcurrent');
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      path: '/api/cell-drafts/draft-1',
      body: { maxConcurrent: 2 },
    });

    await call('update_cell_draft', { autocompactPercent: 65 });
    expect(calls[2]).toMatchObject({
      method: 'PATCH',
      path: '/api/cell-drafts/draft-1',
      body: { autocompactPercent: 65 },
    });

    await call('update_cell_draft', {
      segmentUpdates: [{ id: 'review', enabled: true }],
    });
    expect(calls[3]).toMatchObject({
      method: 'PATCH',
      path: '/api/cell-drafts/draft-1',
      body: { segmentUpdates: [{ id: 'review', enabled: true }] },
    });

    await call('update_cell_draft', { harness: 'opencode' });
    expect(calls[4]).toMatchObject({
      method: 'PATCH',
      path: '/api/cell-drafts/draft-1',
      body: { harness: 'opencode' },
    });
  });

  it('returns the flow contract when a draft update is rejected', async () => {
    const rejecting: FetchLike = async (_url, init) => {
      if (init?.method === 'PATCH') {
        return json(
          {
            error: 'invalid',
            issues: [
              {
                code: 'custom',
                path: ['segments', 0, 'advanceTo'],
                message: 'intake moves to plan by starting clarification',
              },
            ],
          },
          400,
        );
      }
      return json({});
    };
    const { call } = await connect('', 'setup', 'draft-1', { fetchImpl: rejecting });

    const result = await call('update_cell_draft', { segments: [] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('intake moves to plan');
    expect(textOf(result)).toContain('intake: leave advanceTo null');
  });

  it('turns a stalled brain request into an MCP error result', async () => {
    const never: FetchLike = () => new Promise<Response>(() => {});
    const { call } = await connect('', 'master', undefined, {
      fetchImpl: never,
      timeoutMs: 20,
    });

    const result = await call('list_kb');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('timed out after 20 ms');
  });

  it('defaults get_request to the scoped request', async () => {
    const { call, calls } = await connect('req-1');
    const result = await call('get_request');

    expect(textOf(result)).toContain('"id": "req-1"');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/requests/req-1' });
  });

  it('patches only the fields the agent provided', async () => {
    const { call, calls } = await connect('req-1');
    const result = await call('update_request', { acceptanceCriteria: 'tests pass', groomed: true });

    const patch = calls.find((entry) => entry.method === 'PATCH');
    expect(patch?.path).toBe('/api/requests/req-1');
    expect(patch?.body).toEqual({ acceptanceCriteria: 'tests pass', groomed: true });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('tests pass');
  });

  it('forwards a harness override and clears it with null', async () => {
    const { call, calls } = await connect('req-1');

    await call('update_request', { harness: 'opencode' });
    await call('update_request', { harness: null });

    const patches = calls.filter((entry) => entry.method === 'PATCH');
    expect(patches[0]?.body).toEqual({ harness: 'opencode' });
    expect(patches[1]?.body).toEqual({ harness: null });
  });

  it('spawns a request and stores a digest under the request title', async () => {
    const { call, calls } = await connect('req-1');

    await call('spawn_request', { title: 'Follow-up' });
    await call('index_to_kb', { content: 'what we learned' });

    const spawn = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/requests');
    expect(spawn?.body).toEqual({
      title: 'Follow-up',
      cellId: 'cell-1',
      harness: 'opencode',
      targetRepo: 'https://example.test/repo',
    });

    const store = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/kb');
    expect(store?.body).toEqual({ requestId: 'req-1', title: 'Scoped', content: 'what we learned' });
  });

  it('inherits the parent harness when the same cell is passed explicitly', async () => {
    const { call, calls } = await connect('req-1');

    await call('spawn_request', { title: 'Same cell', cellId: 'cell-1' });

    const spawn = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/requests');
    expect(spawn?.body).toEqual({
      title: 'Same cell',
      cellId: 'cell-1',
      harness: 'opencode',
      targetRepo: 'https://example.test/repo',
    });
  });

  it('does not leak the parent harness or repo into a different cell', async () => {
    const { call, calls } = await connect('req-1');

    await call('spawn_request', { title: 'Elsewhere', cellId: 'cell-2' });

    const spawn = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/requests');
    expect(spawn?.body).toEqual({ title: 'Elsewhere', cellId: 'cell-2' });
  });

  it('keeps explicit spawn fields and clears them with null', async () => {
    const { call, calls } = await connect('req-1');

    await call('spawn_request', {
      title: 'Moved',
      cellId: 'cell-2',
      harness: 'claude',
      targetRepo: null,
    });

    const spawn = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/requests');
    expect(spawn?.body).toEqual({
      title: 'Moved',
      cellId: 'cell-2',
      harness: 'claude',
      targetRepo: null,
    });
  });

  it('clears only the inherited harness with an explicit null', async () => {
    const { call, calls } = await connect('req-1');

    await call('spawn_request', { title: 'No override', harness: null });

    const spawn = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/requests');
    expect(spawn?.body).toEqual({
      title: 'No override',
      cellId: 'cell-1',
      harness: null,
      targetRepo: 'https://example.test/repo',
    });
  });

  it('spawns without invented fields when the parent has none', async () => {
    const { call, calls } = await connect('req-1', undefined, undefined, {
      parent: { id: 'req-1', title: 'Scoped', cellId: null, harness: null, targetRepo: null },
    });

    await call('spawn_request', { title: 'Unassigned' });

    const spawn = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/requests');
    expect(spawn?.body).toEqual({ title: 'Unassigned' });
  });

  it('refuses to spawn when the parent request cannot be read', async () => {
    const calls: Recorded[] = [];
    const failing: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, path: new URL(url).pathname, body: undefined });
      return method === 'GET' ? json({ error: 'not_found' }, 404) : json({ id: 'spawned' }, 201);
    };
    const { call } = await connect('req-1', undefined, undefined, { fetchImpl: failing });

    const result = await call('spawn_request', { title: 'Orphan' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('404');
    expect(calls.some((entry) => entry.method === 'POST')).toBe(false);
  });

  it('advertises the spawn inheritance fields', async () => {
    const { client } = await connect('req-1');
    const { tools } = await client.listTools();
    const spawn = tools.find((tool) => tool.name === 'spawn_request');

    expect(spawn?.description).toContain('inherits');
    expect(spawn?.inputSchema.properties).toHaveProperty('cellId');
    expect(spawn?.inputSchema.properties).toHaveProperty('harness');
  });

  it('passes the query and limit through to the knowledge base', async () => {
    const { call, calls } = await connect('');
    await call('search_kb', { query: 'cells', limit: 5 });

    expect(calls[0]?.path).toBe('/api/kb?q=cells&limit=5');
  });

  it('turns a brain error into an MCP error result instead of throwing', async () => {
    const { call } = await connect('req-1');
    const result = await call('get_request', { id: 'missing' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('404');
  });
});

describe('readMcpEnv', () => {
  it('prefers APS_* and falls back to the legacy SBOX_* names', () => {
    expect(
      readMcpEnv({
        APS_BRAIN_URL: 'http://aps:7391',
        SBOX_BRAIN_URL: 'http://legacy:7391',
        APS_REQUEST_ID: 'req-aps',
        SBOX_REQUEST_ID: 'req-legacy',
        APS_SESSION_SCOPE: 'master',
        SBOX_SESSION_SCOPE: 'request',
        APS_SETUP_DRAFT_ID: 'draft-aps',
        APS_MCP_TIMEOUT_MS: '2000',
      }),
    ).toEqual({
      brainUrl: 'http://aps:7391',
      requestId: 'req-aps',
      scope: 'master',
      draftId: 'draft-aps',
      timeoutMs: 2000,
    });

    expect(
      readMcpEnv({
        SBOX_BRAIN_URL: 'http://legacy:7391',
        SBOX_REQUEST_ID: 'req-legacy',
        SBOX_SESSION_SCOPE: 'kb',
        SBOX_MCP_TIMEOUT_MS: '3000',
      }),
    ).toEqual({
      brainUrl: 'http://legacy:7391',
      requestId: 'req-legacy',
      scope: 'kb',
      draftId: undefined,
      timeoutMs: 3000,
    });
  });

  it('keeps the default brain URL, timeout, and an empty request id', () => {
    expect(readMcpEnv({})).toEqual({
      brainUrl: 'http://127.0.0.1:7391',
      requestId: '',
      scope: undefined,
      draftId: undefined,
      timeoutMs: 15_000,
    });
  });

  it('ignores an unknown scope and a non-positive timeout', () => {
    const env = readMcpEnv({ APS_SESSION_SCOPE: 'unknown', APS_MCP_TIMEOUT_MS: '0' });

    expect(env.scope).toBeUndefined();
    expect(env.timeoutMs).toBe(15_000);
  });
});
