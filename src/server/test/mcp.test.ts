import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpServer, type FetchLike } from '../src/mcp/server.js';

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

function makeBrain(): { calls: Recorded[]; fetchImpl: FetchLike } {
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
    if (parsed.pathname === '/api/requests/req-1') return json({ id: 'req-1', title: 'Scoped' });
    if (parsed.pathname === '/api/requests') return json([{ id: 'req-1' }]);
    return json({ error: 'not_found' }, 404);
  };

  return { calls, fetchImpl };
}

let close: (() => Promise<void>) | null = null;

async function connect(
  requestId: string,
  scope?: 'request' | 'kb' | 'master',
): Promise<{
  client: Client;
  calls: Recorded[];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
}> {
  const { calls, fetchImpl } = makeBrain();
  const server = buildMcpServer({ brainUrl: 'http://brain.test', requestId, scope, fetchImpl });
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
  const block = result.content[0];
  return block !== undefined && block.type === 'text' ? block.text : '';
}

afterEach(async () => {
  await close?.();
  close = null;
});

describe('harness mcp server', () => {
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

  it('spawns a request and stores a digest under the request title', async () => {
    const { call, calls } = await connect('req-1');

    await call('spawn_request', { title: 'Follow-up' });
    await call('index_to_kb', { content: 'what we learned' });

    const spawn = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/requests');
    expect(spawn?.body).toEqual({ title: 'Follow-up' });

    const store = calls.find((entry) => entry.method === 'POST' && entry.path === '/api/kb');
    expect(store?.body).toEqual({ requestId: 'req-1', title: 'Scoped', content: 'what we learned' });
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
