import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScorecardsPage } from './ScorecardsPage';
import { jsonResponse } from './test/fixtures';

function makeCell(id: string, name: string) {
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
    process: null,
    createdAt: 1,
  };
}

function makeReport(id: string, cellId: string, content: string, createdAt: number) {
  return {
    id,
    cellId,
    windowStart: createdAt - 360 * 60_000,
    windowEnd: createdAt,
    windowMinutes: 360,
    content,
    stats: {},
    createdAt,
  };
}

const STATUS = {
  enabled: true,
  intervalMinutes: 360,
  windowMinutes: 360,
  running: false,
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
};

function stubFetch(cells: unknown[], reportsByCell: Record<string, unknown[]>) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/cells') return jsonResponse(cells);
    if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
    if (url.startsWith('/api/summaries/history')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const cellId = params.get('cellId') ?? '';
      const limit = Number(params.get('limit') ?? 10);
      const offset = Number(params.get('offset') ?? 0);
      const reports = reportsByCell[cellId] ?? [];
      return jsonResponse({
        reports: reports.slice(offset, offset + limit),
        total: reports.length,
        limit,
        offset,
      });
    }
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return urls;
}

describe('ScorecardsPage', () => {
  it('groups reports by cell, newest first, with earlier history', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha'), makeCell('c2', 'Beta')], {
      c1: [
        makeReport('s1', 'c1', 'Alpha newest report', 2_000_000),
        makeReport('s0', 'c1', 'Alpha previous report', 1_000_000),
      ],
      c2: [makeReport('s2', 'c2', 'Beta newest report', 1_500_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha newest report')).toBeInTheDocument();
    expect(screen.getByText('Beta newest report')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Earlier scorecards (1)')).toBeInTheDocument();
    expect(screen.getByText('Alpha previous report')).toBeInTheDocument();
    expect(screen.queryByText('No scorecards yet')).not.toBeInTheDocument();
    expect(urls).toContain('/api/summaries/history?cellId=c1&limit=10');
    expect(urls).toContain('/api/summaries/history?cellId=c2&limit=10');
  });

  it('scopes the list to the selected cell', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha'), makeCell('c2', 'Beta')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
      c2: [makeReport('s2', 'c2', 'Beta report', 2_000_000)],
    });

    render(<ScorecardsPage cellId="c1" onError={() => {}} />);

    expect(await screen.findByText('Alpha report')).toBeInTheDocument();
    expect(screen.queryByText('Beta report')).not.toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(urls).toContain('/api/summaries/history?cellId=c1&limit=25');
    expect(urls).toContain('/api/summaries/status?cellId=c1');
    expect(urls.some((url) => url.includes('cellId=c2'))).toBe(false);
  });

  it('pages a focused cell history and resets with refresh', async () => {
    const reports = Array.from({ length: 30 }, (_, index) =>
      makeReport(`s${30 - index}`, 'c1', `Report ${30 - index}`, 2_000_000 - index * 1_000),
    );
    const urls = stubFetch([makeCell('c1', 'Alpha')], { c1: reports });

    render(<ScorecardsPage cellId="c1" onError={() => {}} />);

    expect(await screen.findByText('Report 30')).toBeInTheDocument();
    expect(screen.queryByText('Report 1')).not.toBeInTheDocument();
    const loadOlder = screen.getByRole('button', {
      name: 'Load older scorecards (5 remaining)',
    });
    fireEvent.click(loadOlder);

    expect(await screen.findByText('Report 1')).toBeInTheDocument();
    expect(urls).toContain('/api/summaries/history?cellId=c1&limit=25&offset=25');
    expect(
      screen.queryByRole('button', { name: /Load older scorecards/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(
      await screen.findByRole('button', { name: 'Load older scorecards (5 remaining)' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Report 1')).not.toBeInTheDocument();
  });

  it('pages each all-cells card independently', async () => {
    const alpha = Array.from({ length: 12 }, (_, index) =>
      makeReport(`a${12 - index}`, 'c1', `Alpha report ${12 - index}`, 2_000_000 - index * 1_000),
    );
    const beta = Array.from({ length: 12 }, (_, index) =>
      makeReport(`b${12 - index}`, 'c2', `Beta report ${12 - index}`, 1_900_000 - index * 1_000),
    );
    const urls = stubFetch([makeCell('c1', 'Alpha'), makeCell('c2', 'Beta')], {
      c1: alpha,
      c2: beta,
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha report 3')).toBeInTheDocument();
    expect(screen.getByText('Beta report 3')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', {
      name: 'Load older scorecards (2 remaining)',
    });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);

    expect(await screen.findByText('Alpha report 1')).toBeInTheDocument();
    expect(screen.getByText('Beta report 1')).toBeInTheDocument();
    expect(urls).toContain('/api/summaries/history?cellId=c1&limit=10&offset=10');
    expect(urls).toContain('/api/summaries/history?cellId=c2&limit=10&offset=10');
  });

  it('renders a report once when a page repeats it and still advances the offset', async () => {
    const reports = Array.from({ length: 30 }, (_, index) =>
      makeReport(`s${30 - index}`, 'c1', `Report ${30 - index}`, 2_000_000 - index * 1_000),
    );
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/api/cells') return jsonResponse([makeCell('c1', 'Alpha')]);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url.startsWith('/api/summaries/history')) {
          const params = new URL(url, 'http://localhost').searchParams;
          const limit = Number(params.get('limit') ?? 10);
          const offset = Number(params.get('offset') ?? 0);
          const page =
            offset === 10
              ? reports.slice(9, 19)
              : reports.slice(offset, offset + limit);
          return jsonResponse({ reports: page, total: reports.length, limit, offset });
        }
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Report 21')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load older scorecards (20 remaining)' }),
    );

    expect(await screen.findByText('Report 12')).toBeInTheDocument();
    expect(screen.getAllByText('Report 21')).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'Load older scorecards (10 remaining)' }),
    );

    expect(await screen.findByText('Report 1')).toBeInTheDocument();
    expect(urls).toContain('/api/summaries/history?cellId=c1&limit=10&offset=10');
    expect(urls).toContain('/api/summaries/history?cellId=c1&limit=10&offset=20');
    expect(
      screen.queryByRole('button', { name: /Load older scorecards/ }),
    ).not.toBeInTheDocument();
  });

  it('keeps loaded reports when loading older reports fails', async () => {
    const onError = vi.fn();
    let historyCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/cells') return jsonResponse([makeCell('c1', 'Alpha')]);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url.startsWith('/api/summaries/history')) {
          historyCalls += 1;
          if (historyCalls === 1) {
            return jsonResponse({
              reports: Array.from({ length: 10 }, (_, index) =>
                makeReport(
                  `s${10 - index}`,
                  'c1',
                  `Report ${10 - index}`,
                  2_000_000 - index * 1_000,
                ),
              ),
              total: 12,
              limit: 10,
              offset: 0,
            });
          }
          return jsonResponse({ error: 'older reports unavailable' }, 500);
        }
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={onError} />);

    expect(await screen.findByText('Report 1')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load older scorecards (2 remaining)' }),
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByText('Report 1')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Load older scorecards (2 remaining)' }),
    ).toBeEnabled();
  });

  it('shows an empty state when there are no reports', async () => {
    stubFetch([makeCell('c1', 'Alpha')], {});

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('No scorecards yet')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('reports a load failure and offers a retry state', async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/cells') return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse(STATUS);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={onError} />);

    expect(await screen.findByText("Couldn't load scorecards")).toBeInTheDocument();
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });
});
