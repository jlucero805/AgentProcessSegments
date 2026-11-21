#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { EFFORT_LEVELS, STATES } from '../domain/request.js';
import { errorMessage } from '../util/errors.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BrainResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

/** Thin HTTP client over the loopback brain. The only dependency is fetch. */
export class BrainApi {
  constructor(
    private readonly brainUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async call(method: string, path: string, body?: unknown): Promise<BrainResponse> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }

    const response = await this.fetchImpl(`${this.brainUrl}${path}`, init);
    const text = await response.text();

    let data: unknown = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return { ok: response.ok, status: response.status, data };
  }
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function respond(pending: Promise<BrainResponse>): Promise<CallToolResult> {
  try {
    const response = await pending;
    if (response.ok) return ok(response.data);
    const detail = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    return fail(`brain returned ${response.status}: ${detail}`);
  } catch (error) {
    return fail(errorMessage(error));
  }
}

function defined<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const listFilterSchema = {
  state: z.enum(STATES).optional(),
  view: z.literal('intake').optional(),
  cellId: z.string().optional(),
};

function listFilterQuery(filter: { state?: string; view?: string; cellId?: string }): string {
  const params = new URLSearchParams();
  if (filter.state) params.set('state', filter.state);
  if (filter.view) params.set('view', filter.view);
  if (filter.cellId) params.set('cellId', filter.cellId);
  return params.toString();
}

function registerKbTools(server: McpServer, api: BrainApi): void {
  server.registerTool(
    'search_kb',
    {
      title: 'Search the knowledge base',
      description: 'Find knowledge-base entries whose title or content contains the query.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const params = new URLSearchParams({ q: query });
      if (limit !== undefined) params.set('limit', String(limit));
      return respond(api.call('GET', `/api/kb?${params.toString()}`));
    },
  );

  server.registerTool(
    'list_kb',
    {
      title: 'List the knowledge base',
      description: 'List stored knowledge-base entries, newest first.',
      annotations: { readOnlyHint: true },
    },
    async () => respond(api.call('GET', '/api/kb')),
  );
}

/**
 * The board readers are identical in request and master scope; only the
 * default request id and the `get_request` schema differ.
 */
function registerBoardTools(
  server: McpServer,
  api: BrainApi,
  defaultRequestId: string | null,
): void {
  server.registerTool(
    'list_requests',
    {
      title: 'List requests',
      description: 'List requests, optionally filtered by state, intake view, or cell.',
      inputSchema: listFilterSchema,
      annotations: { readOnlyHint: true },
    },
    async (filter) => {
      const query = listFilterQuery(filter);
      return respond(api.call('GET', `/api/requests${query ? `?${query}` : ''}`));
    },
  );

  const idSchema = defaultRequestId === null ? z.string().min(1) : z.string().optional();

  server.registerTool(
    'get_request',
    {
      title: 'Read a request',
      description:
        defaultRequestId === null
          ? 'Read any request by id.'
          : 'Read the current request, or another request by id.',
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ id }: { id?: string }) =>
      respond(
        api.call(
          'GET',
          `/api/requests/${encodeURIComponent(id ?? defaultRequestId ?? '')}`,
        ),
      ),
  );
}

export type SessionScope = 'request' | 'kb' | 'master';

export interface McpOptions {
  brainUrl: string;
  /** Empty string for the knowledge-base/master sessions, which have no request scope. */
  requestId: string;
  /** Defaults to `kb` when requestId is empty, otherwise `request`. */
  scope?: SessionScope;
  fetchImpl?: FetchLike;
}

export function buildMcpServer(options: McpOptions): McpServer {
  const api = new BrainApi(options.brainUrl, options.fetchImpl);
  const server = new McpServer({ name: 'harness', version: '0.1.0' });
  const requestId = options.requestId;
  const scope = options.scope ?? (requestId === '' ? 'kb' : 'request');

  if (scope !== 'request') {
    registerKbTools(server, api);
    if (scope === 'kb') return server;

    // The master chat can read the board and the KB, but never mutate them.
    registerBoardTools(server, api, null);
    return server;
  }

  registerBoardTools(server, api, requestId);

  server.registerTool(
    'update_request',
    {
      title: 'Update this request',
      description:
        'Edit this request. Only the fields you pass change. Null clears a nullable field.',
      inputSchema: {
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        targetRepo: z.string().nullable().optional(),
        acceptanceCriteria: z.string().nullable().optional(),
        context: z.string().nullable().optional(),
        skills: z.array(z.string()).optional(),
        groomed: z.boolean().optional(),
        model: z.string().nullable().optional(),
        effort: z.enum(EFFORT_LEVELS).nullable().optional(),
        kbDigest: z.boolean().optional(),
        digest: z.string().nullable().optional(),
        cellId: z.string().nullable().optional(),
      },
    },
    async (fields) =>
      respond(
        api.call(
          'PATCH',
          `/api/requests/${encodeURIComponent(requestId)}`,
          defined(fields),
        ),
      ),
  );

  server.registerTool(
    'spawn_request',
    {
      title: 'Create a request',
      description: 'Create a follow-up request on the board and return it.',
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional(),
        targetRepo: z.string().nullable().optional(),
      },
    },
    async (input) =>
      respond(api.call('POST', '/api/requests', defined(input))),
  );

  server.registerTool(
    'index_to_kb',
    {
      title: 'Store a knowledge-base entry',
      description:
        'Store text in the knowledge base for this request. This does not finish the request.',
      inputSchema: {
        content: z.string().min(1),
        title: z.string().optional(),
      },
    },
    async ({ content, title }) => {
      const current = await api.call('GET', `/api/requests/${encodeURIComponent(requestId)}`);
      if (!current.ok) return respond(Promise.resolve(current));
      const record =
        typeof current.data === 'object' && current.data !== null
          ? (current.data as Record<string, unknown>)
          : {};
      const requestTitle = typeof record['title'] === 'string' ? record['title'] : requestId;
      return respond(
        api.call('POST', '/api/kb', {
          requestId,
          title: title ?? requestTitle,
          content,
        }),
      );
    },
  );

  return server;
}

async function main(): Promise<void> {
  const brainUrl = process.env.SBOX_BRAIN_URL ?? 'http://127.0.0.1:7391';
  const requestId = process.env.SBOX_REQUEST_ID ?? '';
  const rawScope = process.env.SBOX_SESSION_SCOPE;
  const scope =
    rawScope === 'request' || rawScope === 'kb' || rawScope === 'master' ? rawScope : undefined;
  const server = buildMcpServer({ brainUrl, requestId, scope });
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
