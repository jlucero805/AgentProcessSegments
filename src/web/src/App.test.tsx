import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { jsonResponse, makeProcessResponse, makeRequest, makeUsageResponse } from './test/fixtures';
import type { CellDetail, Request } from './types';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DOC_PAGES = [
  { slug: 'getting-started', title: 'Getting started', group: 'Getting started' },
  { slug: '07-process-segments', title: 'Process segments', group: 'Guides' },
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
    autocompactPercent: 80,
    process: { version: process.version, segments: process.segments },
    createdAt: 1,
  };
}

function installFetch(request: Request, transcript: unknown[] = [], cells: CellDetail[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
        budget: { monthlyUsd: null, alertAtPercent: 80 },
        path: '/tmp/config.json',
      });
    }
    if (url === '/api/budgets') {
      return jsonResponse({
        periodStart: Date.UTC(2026, 10, 1),
        periodEnd: Date.UTC(2026, 11, 1),
        alertAtPercent: 80,
        usageAvailable: true,
        statuses: [],
        alerts: [],
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
    fireEvent.click(await screen.findByText('Dispatch card'));

    expect(await screen.findByText('Finalize digest')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message this thread…')).toBeInTheDocument();
  });

  it('shows the request usage card in the drawer', async () => {
    const request = makeRequest({ id: 'a', title: 'Metered card', clarifyStarted: true });
    installFetch(request);

    render(<App />);
    fireEvent.click(await screen.findByText('Metered card'));

    expect(await screen.findByText('Unpriced')).toBeInTheDocument();
    expect((await screen.findAllByText('≈ $0.0160')).length).toBeGreaterThan(0);
  });

  it('opens the cell master detail from the sidebar', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }), [], [makeCell()]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cell master' }));

    expect(await screen.findByText('Alpha · process automation')).toBeInTheDocument();
    expect(screen.getByText('Cron loop')).toBeInTheDocument();
    expect(window.location.search).toContain('cell=c1');
    expect(window.location.search).toContain('master=1');
  });

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
    expect(await screen.findByText('Alpha · process automation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));

    expect(await screen.findByText('Edit cell')).toBeInTheDocument();
    expect((await screen.findAllByText('Drawer plan purpose')).length).toBeGreaterThan(0);
    expect(screen.queryByText('GLOBAL PROCESS TEMPLATE')).not.toBeInTheDocument();
  });

  it('opens the usage page and records it in the URL', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);
    fireEvent.click(screen.getByText('Usage'));

    expect(await screen.findByText('Cost over time')).toBeInTheDocument();
    expect(window.location.search).toContain('page=usage');
  });

  it('opens the config page and records it in the URL', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Url card' }));

    render(<App />);
    fireEvent.click(screen.getByText('Config'));

    expect(await screen.findByText('Cell master')).toBeInTheDocument();
    expect(window.location.search).toContain('page=config');
  });

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

  it('moves between docs pages with browser back and forward', async () => {
    window.history.replaceState(null, '', '/?help=getting-started');
    installFetch(makeRequest({ id: 'a', title: 'Docs card' }));

    render(<App />);
    expect(await screen.findByRole('dialog', { name: 'Documentation' })).toBeInTheDocument();
    expect(await screen.findByText('Help article body.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Process segments' }));
    expect(await screen.findByText('Process segments article.')).toBeInTheDocument();
    expect(window.location.search).toContain('help=07-process-segments');

    window.history.back();
    await waitFor(() => expect(window.location.search).toContain('help=getting-started'));
    expect(await screen.findByText('Help article body.')).toBeInTheDocument();

    window.history.forward();
    await waitFor(() => expect(window.location.search).toContain('help=07-process-segments'));
    expect(await screen.findByText('Process segments article.')).toBeInTheDocument();
  });
});
