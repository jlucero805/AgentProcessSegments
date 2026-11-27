import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { jsonResponse, makeProcessResponse, makeRequest, makeUsageResponse } from './test/fixtures';
import type { BudgetAlert, CellDetail, Request } from './types';

// These flows chain several reloads (banners, cells, budgets). Give their queries and
// whole-case budgets room under full-suite load while keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;
const APP_TEST_TIMEOUT_MS = 30_000;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DOC_PAGES = [
  { slug: 'getting-started', title: 'Getting started', group: 'Getting started' },
  { slug: '07-process-segments', title: 'Process segments', group: 'Guides' },
  { slug: '08-user-workflows', title: 'User workflows', group: 'Guides' },
];

const DOCS: Record<string, unknown> = {
  'getting-started': {
    slug: 'getting-started',
    title: 'Getting started',
    group: 'Getting started',
    markdown: '# Help article\n\nHelp article body.\n\n## Setup',
    updatedAt: 1,
  },
  '07-process-segments': {
    slug: '07-process-segments',
    title: 'Process segments',
    group: 'Guides',
    markdown: '# Process segments\n\nProcess segments article.',
    updatedAt: 2,
  },
  '08-user-workflows': {
    slug: '08-user-workflows',
    title: 'User workflows',
    group: 'Guides',
    markdown: [
      '# User workflows',
      '',
      'Configure alert delivery.',
      '',
      '### Verify webhook signatures',
      '',
      'Verify the raw body.',
    ].join('\n'),
    updatedAt: 3,
  },
};

function makeCell(id = 'c1', name = 'Alpha'): CellDetail {
  const process = makeProcessResponse();
  return {
    id,
    name,
    masterEnabled: true,
    masterIntervalMinutes: 3,
    maxConcurrent: 3,
    harness: null,
    model: null,
    effort: null,
    monthlyBudgetUsd: null,
    pauseOnExceeded: false,
    pauseOnUnknownCost: false,
    autocompactPercent: 80,
    process: { version: process.version, segments: process.segments },
    createdAt: 1,
  };
}

function makeBudgetAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    id: 'alert-1',
    scope: 'overall',
    cellId: null,
    cellName: null,
    threshold: 'warning',
    alertAtPercent: 80,
    budgetUsd: 100,
    spendUsd: 85,
    unknownCostTurns: 1,
    periodStart: Date.UTC(2026, 10, 1),
    createdAt: 10,
    acknowledgedAt: null,
    ...overrides,
  };
}

function makePausedBudgetView(overridden = false) {
  const periodStart = Date.UTC(2026, 10, 1);
  const periodEnd = Date.UTC(2026, 11, 1);
  return {
    periodStart,
    periodEnd,
    alertAtPercent: 80,
    statuses: [
      {
        scope: 'overall',
        cellId: null,
        cellName: null,
        label: 'Overall',
        periodStart,
        periodEnd,
        budgetUsd: 100,
        spendUsd: 100,
        remainingUsd: 0,
        percentUsed: 100,
        pricedTurns: 3,
        unknownCostTurns: 0,
        spendIsLowerBound: false,
        state: 'exceeded',
        pauseOnExceeded: true,
        pauseOnUnknownCost: false,
        capSpendUsd: 100,
        capSpendIsLowerBound: false,
        unpricedTurns: 0,
        paused: true,
        pauseReason: 'cap_reached',
        overrideId: overridden ? 'o1' : null,
        overrideExpiresAt: overridden ? Date.UTC(2026, 10, 15, 13) : null,
      },
    ],
    alerts: [],
    pauses: [
      {
        scope: 'overall',
        cellId: null,
        cellName: null,
        label: 'Overall',
        reason: 'cap_reached',
        periodStart,
        periodEnd,
        budgetUsd: 100,
        spendUsd: 100,
        spendIsLowerBound: false,
        unpricedTurns: 0,
        percentUsed: 100,
      },
    ],
    overrides: overridden
      ? [
          {
            id: 'o1',
            scope: 'overall',
            cellId: null,
            cellName: null,
            periodStart,
            createdAt: Date.UTC(2026, 10, 15, 12),
            updatedAt: Date.UTC(2026, 10, 15, 12),
            expiresAt: Date.UTC(2026, 10, 15, 13),
            note: null,
            revokedAt: null,
          },
        ]
      : [],
  };
}

function makeCellPausedBudgetView(cell: CellDetail, paused = true) {
  const periodStart = Date.UTC(2026, 10, 1);
  const periodEnd = Date.UTC(2026, 11, 1);
  const budgetUsd = cell.monthlyBudgetUsd ?? 100;
  return {
    periodStart,
    periodEnd,
    alertAtPercent: 80,
    statuses: paused
      ? [
          {
            scope: 'cell',
            cellId: cell.id,
            cellName: cell.name,
            label: cell.name,
            periodStart,
            periodEnd,
            budgetUsd,
            spendUsd: budgetUsd,
            remainingUsd: 0,
            percentUsed: 100,
            pricedTurns: 3,
            unknownCostTurns: 0,
            spendIsLowerBound: false,
            state: 'exceeded',
            pauseOnExceeded: true,
            pauseOnUnknownCost: false,
            capSpendUsd: budgetUsd,
            capSpendIsLowerBound: false,
            unpricedTurns: 0,
            paused: true,
            pauseReason: 'cap_reached',
            overrideId: null,
            overrideExpiresAt: null,
          },
        ]
      : [],
    alerts: [],
    pauses: paused
      ? [
          {
            scope: 'cell',
            cellId: cell.id,
            cellName: cell.name,
            label: cell.name,
            reason: 'cap_reached',
            periodStart,
            periodEnd,
            budgetUsd,
            spendUsd: budgetUsd,
            spendIsLowerBound: false,
            unpricedTurns: 0,
            percentUsed: 100,
          },
        ]
      : [],
    overrides: [],
  };
}

function installFetch(
  request: Request,
  transcript: unknown[] = [],
  cells: CellDetail[] = [],
  budgetAlerts: BudgetAlert[] = [],
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/cells') return jsonResponse(cells);
    if (url.startsWith('/api/cells/')) {
      const id = decodeURIComponent(url.slice('/api/cells/'.length).split('?')[0] ?? '');
      const cell = cells.find((item) => item.id === id);
      return cell ? jsonResponse(cell) : jsonResponse({ error: 'not_found' }, 404);
    }
    if (url === '/api/commands') return jsonResponse([]);
    if (url === '/api/docs') return jsonResponse({ pages: DOC_PAGES });
    if (url.startsWith('/api/docs/')) {
      const slug = decodeURIComponent(url.slice('/api/docs/'.length).split('?')[0] ?? '');
      const doc = DOCS[slug];
      return doc ? jsonResponse(doc) : jsonResponse({ error: 'not_found' }, 404);
    }
    if (url.startsWith('/api/models')) {
      const cellId = new URL(url, 'http://localhost').searchParams.get('cellId');
      const cell = cells.find((item) => item.id === cellId);
      const harness = cell?.harness ?? 'opencode';
      return jsonResponse({
        models: [],
        source: 'fallback',
        effortLevels: EFFORTS,
        harness,
        supportsEffort: harness === 'claude',
      });
    }
    if (url === '/api/config') {
      return jsonResponse({
        master: {
          enabled: true,
          intervalMinutes: 5,
          idleMinutes: 10,
          autoReview: true,
          prompt: 'prod',
        },
        summary: {
          enabled: true,
          intervalMinutes: 360,
          windowMinutes: 360,
          prompt: 'summary prompt',
        },
        usage: { retentionDays: 90 },
        retention: { masterEventsDays: 90, cellSummariesDays: 90, requestArtifactsDays: 30, budgetAlertsDays: 400, notificationEventsDays: 400, spendCapOverridesDays: 400 },
        budget: { monthlyUsd: null, alertAtPercent: 80 },
        path: '/tmp/config.json',
        warnings: [],
      });
    }
    if (url.startsWith('/api/budgets/alerts/') && init?.method === 'POST') {
      const id = decodeURIComponent(
        url.slice('/api/budgets/alerts/'.length).split('/')[0] ?? '',
      );
      const index = budgetAlerts.findIndex((item) => item.id === id);
      const found = index >= 0 ? budgetAlerts.splice(index, 1)[0] : undefined;
      return jsonResponse({ ...found, acknowledgedAt: 99 });
    }
    if (url === '/api/budgets') {
      return jsonResponse({
        periodStart: Date.UTC(2026, 10, 1),
        periodEnd: Date.UTC(2026, 11, 1),
        alertAtPercent: 80,
        statuses: [],
        alerts: budgetAlerts,
        pauses: [],
      });
    }
    if (url === '/api/process') return jsonResponse(makeProcessResponse());
    if (url === '/api/requests/__master__/clarify') {
      return jsonResponse({
        started: true,
        active: false,
        transcript: [{ role: 'agent', kind: 'text', text: 'Master cycle: 1 prodded', ts: 1 }],
      });
    }
    if (url === '/api/requests/__master__/clarify/stream') {
      return jsonResponse({ active: false });
    }
    if (url.startsWith('/api/master/status')) {
      return jsonResponse({
        enabled: true,
        intervalMinutes: 5,
        running: false,
        nextRunAt: null,
        lastRunAt: null,
        lastResult: null,
      });
    }
    if (url.startsWith('/api/master/events')) return jsonResponse([]);
    if (url.startsWith('/api/summaries/status')) {
      return jsonResponse({
        enabled: true,
        intervalMinutes: 360,
        windowMinutes: 360,
        running: false,
        nextRunAt: null,
        lastRunAt: null,
        lastError: null,
      });
    }
    if (url.startsWith('/api/summaries/latest-per-cell')) return jsonResponse([]);
    if (url.startsWith('/api/summaries/latest')) return jsonResponse(null);
    if (url.startsWith('/api/summaries')) return jsonResponse([]);
    if (url.startsWith('/api/usage')) return jsonResponse(makeUsageResponse());
    if (url === `/api/requests/${request.id}`) return jsonResponse(request);
    if (url === `/api/requests/${request.id}/clarify`) {
      return jsonResponse({ started: request.clarifyStarted, transcript });
    }
    if (url === `/api/requests/${request.id}/clarify/stream`) {
      return jsonResponse({ active: false });
    }
    if (url === `/api/requests/${request.id}/seen`) return jsonResponse(request);
    if (url === '/api/requests?view=intake') {
      return jsonResponse(
        request.state === 'clarify' && !request.clarifyStarted ? [request] : [],
      );
    }
    if (url === '/api/requests?state=clarify') {
      return jsonResponse(request.state === 'clarify' ? [request] : []);
    }
    if (url === `/api/requests?state=${request.state}`) return jsonResponse([request]);
    if (url.startsWith('/api/requests?state=')) return jsonResponse([]);
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('restores the page from the URL', async () => {
    window.history.replaceState(null, '', '/?page=kb');
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);

    expect(await screen.findByPlaceholderText('Search entries...')).toBeInTheDocument();
    expect(window.location.search).toContain('page=kb');
  });

  it('restores an open request from the URL', async () => {
    const request = makeRequest({ id: 'a', title: 'Url card', clarifyStarted: true });
    window.history.replaceState(null, '', '/?request=a');
    installFetch(request, [{ role: 'you', kind: 'text', text: 'hello', ts: 1 }]);

    render(<App />);

    expect(await screen.findByText('Finalize digest')).toBeInTheDocument();
    expect(window.location.search).toContain('request=a');
  });

  it('writes the current page to the URL', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);
    fireEvent.click(screen.getByText('Skills'));

    await waitFor(() => expect(window.location.search).toContain('page=skills'));
  });

  it('shows the request cell harness in the drawer', async () => {
    const process = makeProcessResponse();
    const cell: CellDetail = {
      id: 'c1',
      name: 'Open cell',
      masterEnabled: true,
      masterIntervalMinutes: null,
      maxConcurrent: 3,
      harness: 'opencode',
      model: null,
      effort: null,
      monthlyBudgetUsd: null,
    pauseOnExceeded: false,
    pauseOnUnknownCost: false,
      autocompactPercent: 80,
      process: { version: process.version, segments: process.segments },
      createdAt: 1,
    };
    const request = makeRequest({ id: 'req-cell', title: 'Cell card', cellId: cell.id });
    const fetchMock = installFetch(request, [], [cell]);

    render(<App />);
    fireEvent.click(await screen.findByText('Cell card'));

    expect(await screen.findByText('harness: OpenCode (cell Open cell)')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === '/api/models?cellId=c1'),
      ).toBe(true),
    );
  });

  it('keeps one chat thread across workflow segments', async () => {
    const request = makeRequest({
      id: 'a',
      title: 'Dispatch card',
      state: 'dispatch',
      clarifyStarted: true,
    });
    installFetch(request);

    render(<App />);
    fireEvent.click(await screen.findByText('Dispatch card', undefined, { timeout: ASYNC_TIMEOUT_MS }));

    expect(await screen.findByText('Finalize digest', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message this thread…')).toBeInTheDocument();
  }, APP_TEST_TIMEOUT_MS);

  it('shows the request usage card in the drawer', async () => {
    const request = makeRequest({ id: 'a', title: 'Metered card', clarifyStarted: true });
    installFetch(request);

    render(<App />);
    fireEvent.click(await screen.findByText('Metered card', undefined, { timeout: ASYNC_TIMEOUT_MS }));

    expect(await screen.findByText('Unpriced', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect((await screen.findAllByText('≈ $0.0160', undefined, { timeout: ASYNC_TIMEOUT_MS })).length).toBeGreaterThan(0);
  }, APP_TEST_TIMEOUT_MS);

  it('opens the cell master detail from the sidebar', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], [makeCell()]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }, { timeout: ASYNC_TIMEOUT_MS }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cell master' }, { timeout: ASYNC_TIMEOUT_MS }));

    expect(await screen.findByText('Alpha · process automation', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Cron loop')).toBeInTheDocument();
    expect(window.location.search).toContain('cell=c1');
    expect(window.location.search).toContain('master=1');
  }, APP_TEST_TIMEOUT_MS);

  it('does not open a master for all cells', async () => {
    window.history.replaceState(null, '', '/?master=1');
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);

    expect(await screen.findByText('All cells')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cell master' })).not.toBeInTheDocument();
    expect(screen.queryByText('Process automation')).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('master=1');
  });

  it('opens the cell policy from the cell master drawer', async () => {
    window.history.replaceState(null, '', '/?cell=c1&master=1');
    const process = makeProcessResponse();
    const cell: CellDetail = {
      id: 'c1',
      name: 'Alpha',
      masterEnabled: true,
      masterIntervalMinutes: 3,
      maxConcurrent: 3,
      harness: null,
      model: null,
      effort: null,
      monthlyBudgetUsd: null,
    pauseOnExceeded: false,
    pauseOnUnknownCost: false,
      autocompactPercent: 80,
      process: {
        version: process.version,
        segments: process.segments.map((segment) =>
          segment.id === 'plan' ? { ...segment, purpose: 'Drawer plan purpose' } : segment,
        ),
      },
      createdAt: 1,
    };
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], [cell]);

    render(<App />);
    expect(await screen.findByText('Alpha · process automation', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));

    expect(await screen.findByText('Edit cell', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect((await screen.findAllByText('Drawer plan purpose', undefined, { timeout: ASYNC_TIMEOUT_MS })).length).toBeGreaterThan(0);
    expect(screen.queryByText('GLOBAL PROCESS TEMPLATE')).not.toBeInTheDocument();
  }, APP_TEST_TIMEOUT_MS);

  it('opens the usage page and records it in the URL', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);
    fireEvent.click(screen.getByText('Usage'));

    expect(await screen.findByText('Cost over time')).toBeInTheDocument();
    expect(window.location.search).toContain('page=usage');
  });

  it('opens the scorecards page and records it in the URL', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);
    fireEvent.click(screen.getByText('Scorecards'));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Scorecards' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('No scorecards in the last 72 hours'),
    ).toBeInTheDocument();
    expect(window.location.search).toContain('page=scorecards');
  });

  it('shares budget alert acknowledgement between the banner and the usage page', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], [], [makeBudgetAlert()]);

    render(<App />);
    expect(
      await screen.findByRole('button', {
        name: 'Dismiss budget alert for overall spend',
      }, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Usage'));
    expect(await screen.findByText('Monthly budgets', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', {
          name: 'Dismiss budget alert for overall spend',
        }),
      ).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.click(
      within(screen.getByLabelText('Budget alerts')).getByRole('button', {
        name: 'Dismiss budget alert for overall spend',
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Dismiss budget alert for overall spend',
        }),
      ).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.queryByText(/Overall spend reached 80%/)).not.toBeInTheDocument();
  }, APP_TEST_TIMEOUT_MS);

  it('refreshes the banner after snoozing a pause from Config', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));
    const baseFetch = globalThis.fetch;
    let overridden = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/budgets/overrides' && init?.method === 'POST') {
          overridden = true;
          return jsonResponse({ override: { id: 'o1' }, created: true }, 201);
        }
        if (url === '/api/budgets') return jsonResponse(makePausedBudgetView(overridden));
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    expect(await screen.findByText(/Overall spend hard cap reached/, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Config'));
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'Snooze overall spend' }),
      ).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.click(
      within(screen.getByTestId('spend-budgets-card')).getByRole('button', {
        name: 'Snooze overall spend',
      }),
    );

    await waitFor(() =>
      expect(screen.getAllByText(/New work is allowed/).length).toBeGreaterThan(0), { timeout: ASYNC_TIMEOUT_MS },
    );
  }, APP_TEST_TIMEOUT_MS);

  it('refreshes the banner after saving a cell pause off', async () => {
    const cell: CellDetail = {
      ...makeCell(),
      monthlyBudgetUsd: 100,
      pauseOnExceeded: true,
    };
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], [cell]);
    const baseFetch = globalThis.fetch;
    let paused = true;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url === '/api/cells/c1' && method === 'PATCH') {
          paused = false;
          return jsonResponse({ ...cell, pauseOnExceeded: false });
        }
        if (url === '/api/budgets') return jsonResponse(makeCellPausedBudgetView(cell, paused));
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    expect(await screen.findByText(/Alpha hard cap reached/, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }, { timeout: ASYNC_TIMEOUT_MS }));
    const pauseToggle = await screen.findByRole('checkbox', {
      name: /pause this cell's new work when its budget is exceeded/i,
    }, { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(pauseToggle).toBeEnabled(), { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(pauseToggle);
    const saveButton = screen.getByRole('button', { name: 'Save cell' });
    await waitFor(() => expect(saveButton).toBeEnabled(), { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(screen.queryByText(/Alpha hard cap reached/)).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );
    const patchAt = calls.indexOf('PATCH /api/cells/c1');
    expect(patchAt).toBeGreaterThan(-1);
    expect(calls.lastIndexOf('GET /api/budgets')).toBeGreaterThan(patchAt);
  }, APP_TEST_TIMEOUT_MS);

  it('refreshes the banner after saving a cell pause on', async () => {
    const cell: CellDetail = {
      ...makeCell(),
      monthlyBudgetUsd: 100,
      pauseOnExceeded: false,
    };
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], [cell]);
    const baseFetch = globalThis.fetch;
    let paused = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url === '/api/cells/c1' && method === 'PATCH') {
          paused = true;
          return jsonResponse({ ...cell, pauseOnExceeded: true });
        }
        if (url === '/api/budgets') return jsonResponse(makeCellPausedBudgetView(cell, paused));
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.queryByText(/Alpha hard cap reached/)).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }, { timeout: ASYNC_TIMEOUT_MS }));
    const pauseToggle = await screen.findByRole('checkbox', {
      name: /pause this cell's new work when its budget is exceeded/i,
    }, { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(pauseToggle).toBeEnabled(), { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(pauseToggle);
    const saveButton = screen.getByRole('button', { name: 'Save cell' });
    await waitFor(() => expect(saveButton).toBeEnabled(), { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(saveButton);

    expect(await screen.findByText(/Alpha hard cap reached/, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    const patchAt = calls.indexOf('PATCH /api/cells/c1');
    expect(patchAt).toBeGreaterThan(-1);
    expect(calls.lastIndexOf('GET /api/budgets')).toBeGreaterThan(patchAt);
  }, APP_TEST_TIMEOUT_MS);

  it('refreshes the banner after deleting a cell', async () => {
    const cell: CellDetail = {
      ...makeCell(),
      monthlyBudgetUsd: 100,
      pauseOnExceeded: true,
    };
    const cells = [cell];
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], cells);
    const baseFetch = globalThis.fetch;
    let deleted = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url === '/api/cells/c1' && method === 'DELETE') {
          deleted = true;
          cells.splice(0, cells.length);
          return new Response(null, { status: 204 });
        }
        if (url === '/api/budgets') {
          if (deleted) return jsonResponse(makeCellPausedBudgetView(cell, false));
          return jsonResponse({
            ...makeCellPausedBudgetView(cell, true),
            alerts: [makeBudgetAlert({ scope: 'cell', cellId: 'c1', cellName: 'Alpha' })],
          });
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    expect(
      await screen.findByText(/Alpha hard cap reached/, undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Alpha reached 80%/, undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete Alpha' }, { timeout: ASYNC_TIMEOUT_MS }),
    );

    await waitFor(
      () => {
        expect(screen.queryByText(/Alpha hard cap reached/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Alpha reached 80%/)).not.toBeInTheDocument();
      },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () =>
        expect(
          screen.queryByRole('button', { name: 'Delete Alpha' }),
        ).not.toBeInTheDocument(),
      { timeout: ASYNC_TIMEOUT_MS },
    );

    const deleteAt = calls.indexOf('DELETE /api/cells/c1');
    expect(deleteAt).toBeGreaterThan(-1);
    expect(calls.lastIndexOf('GET /api/budgets')).toBeGreaterThan(deleteAt);
  }, APP_TEST_TIMEOUT_MS);

  it('removes a sidebar-deleted cell from the open Config page', async () => {
    const cell = makeCell();
    const cells = [cell];
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], cells);
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/cells/c1' && method === 'DELETE') {
          cells.splice(0, cells.length);
          return new Response(null, { status: 204 });
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByText('Config'));

    expect(
      await screen.findByRole(
        'checkbox',
        { name: 'Alpha master' },
        { timeout: ASYNC_TIMEOUT_MS },
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Delete Alpha' },
        { timeout: ASYNC_TIMEOUT_MS },
      ),
    );

    await waitFor(
      () =>
        expect(
          screen.queryByRole('checkbox', { name: 'Alpha master' }),
        ).not.toBeInTheDocument(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(
      screen.getByText('No cells yet. Create one in the left menu.'),
    ).toBeInTheDocument();
  }, APP_TEST_TIMEOUT_MS);

  it('updates the shared cell list after a Config master toggle', async () => {
    const cell = makeCell();
    const cells = [cell];
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], cells);
    const baseFetch = globalThis.fetch;
    let cellGets = 0;
    let patchBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/cells' && method === 'GET') {
          cellGets += 1;
        }
        if (url === '/api/cells/c1' && method === 'PATCH') {
          patchBody = JSON.parse(String(init?.body));
          cells[0] = { ...cells[0], ...(patchBody as Partial<CellDetail>) };
          return jsonResponse(cells[0]);
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByText('Config'));

    const toggle = await screen.findByRole(
      'checkbox',
      { name: 'Alpha master' },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(toggle).toBeChecked();
    await waitFor(() => expect(cellGets).toBe(1), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.click(toggle);

    await waitFor(
      () =>
        expect(
          screen.getByRole('checkbox', { name: 'Alpha master' }),
        ).not.toBeChecked(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(patchBody).toEqual({ masterEnabled: false });
    expect(cellGets).toBe(1);
  }, APP_TEST_TIMEOUT_MS);

  it('refreshes Config budget rows after snoozing a pause from the banner', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));
    const baseFetch = globalThis.fetch;
    let overridden = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/budgets/overrides' && init?.method === 'POST') {
        overridden = true;
        return jsonResponse({ override: { id: 'o1' }, created: true }, 201);
      }
      if (url === '/api/budgets') return jsonResponse(makePausedBudgetView(overridden));
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText(/Overall spend hard cap reached/, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    const budgetGets = fetchMock.mock.calls.filter(
      ([input]) => String(input) === '/api/budgets',
    ).length;
    fireEvent.click(screen.getByText('Config'));
    const banner = screen.getByLabelText('Budget alerts');
    const bannerSnooze = await within(banner).findByRole('button', {
      name: 'Snooze overall spend',
    }, { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'Snooze overall spend' }),
      ).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === '/api/budgets'),
    ).toHaveLength(budgetGets);

    fireEvent.click(bannerSnooze);

    await waitFor(() =>
      expect(screen.getByText('snoozed')).toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(
      screen.getByText(/an override is admitting new work until/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/New work is allowed/).length).toBeGreaterThan(0);
  }, APP_TEST_TIMEOUT_MS);

  it('opens the config page and records it in the URL', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);
    fireEvent.click(screen.getByText('Config'));

    expect(await screen.findByText('Cell master', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(window.location.search).toContain('page=config');
  }, APP_TEST_TIMEOUT_MS);

  it('opens and closes the mobile menu', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Nav card' }));
    render(<App />);

    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByText('Knowledge base'));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'false');
  });

  it('mounts the shell, nav, cells, and board', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Mounted card' }));

    render(<App />);

    expect(screen.getAllByText('Agent Process Segments').length).toBeGreaterThan(0);
    expect(screen.getByText('headless agent orchestration')).toBeInTheDocument();
    expect(screen.getByText('Knowledge base')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('All cells')).toBeInTheDocument();
    expect(await screen.findByText('Mounted card')).toBeInTheDocument();
    expect(screen.getByTestId('column-intake')).toHaveTextContent('Mounted card');
  });

  it('links to the GitHub repository beside Help', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Repo card' }));

    render(<App />);

    const link = screen.getByRole('link', { name: 'GitHub repository' });
    expect(link).toHaveAttribute('href', 'https://github.com/jlucero805/AgentProcessSegments');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GitHub repository' })).not.toBeInTheDocument();
  });

  it('opens the repo link without opening Help', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Repo card' }));

    render(<App />);

    const link = screen.getByRole('link', { name: 'GitHub repository' });
    // jsdom cannot open a new tab; block the default navigation we are not testing.
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);

    expect(screen.queryByRole('dialog', { name: 'Documentation' })).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('help=');
  });

  it('closes the mobile menu from the repo link', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Nav card' }));
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'true');

    const link = screen.getByRole('link', { name: 'GitHub repository' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'false');
  });

  it('opens the docs from the sidebar and restores focus on close', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Docs card' }));

    render(<App />);
    const help = await screen.findByRole('button', { name: 'Help' });
    fireEvent.click(help);

    expect(await screen.findByRole('dialog', { name: 'Documentation' })).toBeInTheDocument();
    expect(await screen.findByText('Help article body.')).toBeInTheDocument();
    expect(window.location.search).toContain('help=getting-started');

    fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(help).toHaveFocus());
    expect(window.location.search).not.toContain('help=');
  });

  it('opens a docs deep link and follows popstate', async () => {
    window.history.replaceState(null, '', '/?help=07-process-segments');
    installFetch(makeRequest({ id: 'a', title: 'Docs card' }));

    render(<App />);
    expect(await screen.findByRole('dialog', { name: 'Documentation' })).toBeInTheDocument();
    expect(await screen.findByText('Process segments article.')).toBeInTheDocument();
    expect(window.location.search).toContain('help=07-process-segments');

    window.history.replaceState(null, '', '/?help=getting-started');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(await screen.findByText('Help article body.')).toBeInTheDocument();
    expect(window.location.search).toContain('help=getting-started');
  });

  it('deep-links from Alert delivery to the webhook signature section', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Docs card' }));

    render(<App />);
    fireEvent.click(screen.getByText('Config'));

    const link = await screen.findByRole('link', { name: 'Verify webhook signatures' }, { timeout: ASYNC_TIMEOUT_MS });
    expect(link).toHaveAttribute('href', '?help=08-user-workflows#verify-webhook-signatures');
    fireEvent.click(link);

    expect(await screen.findByRole('dialog', { name: 'Documentation' }, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Verify webhook signatures' }, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain('page=config');
    expect(window.location.search).toContain('help=08-user-workflows');
    expect(window.location.hash).toBe('#verify-webhook-signatures');

    window.history.replaceState(null, '', '/?page=config');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Documentation' })).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(await screen.findByText('Cell master', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, APP_TEST_TIMEOUT_MS);

  it('opens a Help section from the URL hash', async () => {
    window.history.replaceState(null, '', '/?help=08-user-workflows#verify-webhook-signatures');
    installFetch(makeRequest({ id: 'a', title: 'Docs card' }));

    render(<App />);

    expect(await screen.findByRole('dialog', { name: 'Documentation' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Verify webhook signatures' }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain('help=08-user-workflows');
    expect(window.location.hash).toBe('#verify-webhook-signatures');
  });

  it('moves between docs pages with browser back and forward', async () => {
    window.history.replaceState(null, '', '/?help=getting-started');
    installFetch(makeRequest({ id: 'a', title: 'Docs card' }));

    render(<App />);
    expect(await screen.findByRole('dialog', { name: 'Documentation' }, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(await screen.findByText('Help article body.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Process segments' }));
    expect(await screen.findByText('Process segments article.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(window.location.search).toContain('help=07-process-segments');

    window.history.back();
    await waitFor(() => expect(window.location.search).toContain('help=getting-started'), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('Help article body.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    window.history.forward();
    await waitFor(() => expect(window.location.search).toContain('help=07-process-segments'), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('Process segments article.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, APP_TEST_TIMEOUT_MS);
});
