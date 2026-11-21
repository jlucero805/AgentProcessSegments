import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, streamNdjson } from './api';
import { jsonResponse, ndjsonResponse } from './test/fixtures';

describe('streamNdjson', () => {
  it('parses events split across transport chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse([
          '{"t":"text","text":"hel',
          'lo"}\n{"t":"to',
          'ol","id":"t1","name":"Read","input":"x"}\n',
        ]),
      ),
    );

    const events: unknown[] = [];
    await streamNdjson('/stream', (event) => events.push(event));

    expect(events).toEqual([
      { t: 'text', text: 'hello' },
      { t: 'tool', id: 't1', name: 'Read', input: 'x' },
    ]);
  });

  it('emits a trailing line without a newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ndjsonResponse(['{"t":"done","request":null,"transcript":[]}'])),
    );

    const events: unknown[] = [];
    await streamNdjson('/stream', (event) => events.push(event));
    expect(events).toEqual([{ t: 'done', request: null, transcript: [] }]);
  });

  it('rejects with a typed error on a failed stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'not_found', message: 'missing' }, 404)),
    );

    await expect(streamNdjson('/stream', () => {})).rejects.toMatchObject({
      status: 404,
      message: 'missing',
    });
  });
});

describe('api client', () => {
  it('builds list queries and drops empty params', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.getRequests({ view: 'intake', state: undefined });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/requests?view=intake');
  });

  it('sends JSON on create', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 'r1' }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.createRequest({ title: 'T' });
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ title: 'T' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('surfaces the server error message and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid', message: 'bad title' }, 400)),
    );

    const promise = api.createRequest({ title: '' });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(api.createRequest({ title: '' })).rejects.toMatchObject({
      status: 400,
      message: 'bad title',
    });
  });
});
