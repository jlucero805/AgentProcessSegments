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

  it('skips non-JSON noise instead of aborting the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse(['not json\n', '{"t":"text","text":"ok"}\n']),
      ),
    );

    const events: unknown[] = [];
    await streamNdjson('/stream', (event) => events.push(event));
    expect(events).toEqual([{ t: 'text', text: 'ok' }]);
  });

  it('sets the JSON content type for bodies sent over the stream', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ndjsonResponse(['{"t":"done","request":null,"transcript":[]}\n']),
    );
    vi.stubGlobal('fetch', fetchMock);

    await streamNdjson('/send', () => {}, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    });

    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
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

  it('builds delivery history queries and posts resend to an encoded id', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ deliveries: [], total: 0, limit: 10, offset: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.getNotificationDeliveries({
      source: 'budget',
      channel: 'webhook',
      status: 'failed',
      alertId: 'a b',
      from: 1,
      to: 2,
      limit: 10,
      offset: 20,
    });
    await api.getNotificationDeliveries({ kind: 'turn.failed', limit: 5, offset: 0 });
    await api.resendNotificationDelivery('d/1');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/notifications/deliveries?source=budget&channel=webhook&status=failed&alertId=a+b&from=1&to=2&limit=10&offset=20',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      '/api/notifications/deliveries?kind=turn.failed&limit=5&offset=0',
    );
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      '/api/notifications/deliveries/d%2F1/resend',
    );
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST');
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

  it('calls the scorecard routes with cell filters and patches both settings blocks', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.getSummaries({
      cellId: 'c1',
      limit: 5,
      since: 1_000,
      until: 3_000,
      before: 2_000,
      beforeId: 's1',
    });
    await api.getLatestSummary('c1');
    await api.getSummaryStatus('c1');
    await api.runSummary('c1');
    await api.patchConfig({ summary: { intervalMinutes: 60 } });
    await api.patchConfig({ retention: { masterEventsDays: 30 } });
    await api.patchConfig({ retention: { cellSummariesDays: 30 } });
    await api.patchConfig({ retention: { requestArtifactsDays: 7 } });
    await api.patchConfig({ retention: { budgetAlertsDays: 30 } });
    await api.patchConfig({ retention: { notificationEventsDays: 30 } });
    await api.patchConfig({ retention: { spendCapOverridesDays: 60 } });

    const calls = fetchMock.mock.calls.map((call) => ({
      url: String(call[0]),
      init: call[1],
    }));
    expect(calls[0]?.url).toBe(
      '/api/summaries?cellId=c1&limit=5&since=1000&until=3000&before=2000&beforeId=s1',
    );
    expect(calls[1]?.url).toBe('/api/summaries/latest?cellId=c1');
    expect(calls[2]?.url).toBe('/api/summaries/status?cellId=c1');
    expect(calls[3]?.url).toBe('/api/summaries/run?cellId=c1');
    expect(calls[3]?.init?.method).toBe('POST');
    expect(calls[4]?.url).toBe('/api/config');
    expect(calls[4]?.init?.body).toBe(
      JSON.stringify({ summary: { intervalMinutes: 60 } }),
    );
    expect(calls[5]?.url).toBe('/api/config');
    expect(calls[5]?.init?.body).toBe(
      JSON.stringify({ retention: { masterEventsDays: 30 } }),
    );
    expect(calls[6]?.url).toBe('/api/config');
    expect(calls[6]?.init?.body).toBe(
      JSON.stringify({ retention: { cellSummariesDays: 30 } }),
    );
    expect(calls[7]?.url).toBe('/api/config');
    expect(calls[7]?.init?.body).toBe(
      JSON.stringify({ retention: { requestArtifactsDays: 7 } }),
    );
    expect(calls[8]?.url).toBe('/api/config');
    expect(calls[8]?.init?.body).toBe(
      JSON.stringify({ retention: { budgetAlertsDays: 30 } }),
    );
    expect(calls[9]?.url).toBe('/api/config');
    expect(calls[9]?.init?.body).toBe(
      JSON.stringify({ retention: { notificationEventsDays: 30 } }),
    );
    expect(calls[10]?.url).toBe('/api/config');
    expect(calls[10]?.init?.body).toBe(
      JSON.stringify({ retention: { spendCapOverridesDays: 60 } }),
    );
  });

  it('omits absent summary history filters', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.getSummaries({ cellId: 'c1' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/summaries?cellId=c1');
  });

  it('requests grouped scorecards with only the supplied filters', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ groups: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.getSummaryGroups({ limit: 25, since: 1_000 });
    await api.getSummaryGroups();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/summaries/grouped?limit=25&since=1000',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/summaries/grouped');
  });

  it('surfaces the first validation issue when there is no message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: 'invalid',
            issues: [
              { code: 'invalid_type', path: [], message: 'Expected object, received string' },
            ],
          },
          400,
        ),
      ),
    );

    await expect(api.createRequest({ title: 'x' })).rejects.toMatchObject({
      status: 400,
      message: 'Expected object, received string',
    });
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

  it('exposes the machine-readable error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'turn_active', message: 'A turn is already running.' }, 409),
      ),
    );

    await expect(streamNdjson('/clarify/send', () => {})).rejects.toMatchObject({
      status: 409,
      code: 'turn_active',
      message: 'A turn is already running.',
    });
  });
});
