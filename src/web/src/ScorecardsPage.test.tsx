import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScorecardsPage } from './ScorecardsPage';
import { jsonResponse } from './test/fixtures';

// The page loads cells and report pages before rendering. Give the slow paging cases
// room under full-suite load while keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;
const SCORECARDS_TEST_TIMEOUT_MS = 30_000;

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

type Cell = ReturnType<typeof makeCell>;
type Report = ReturnType<typeof makeReport>;

const STATUS = {
  enabled: true,
  intervalMinutes: 360,
  windowMinutes: 360,
  running: false,
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
};

function feedPage(reportsByCell: Record<string, Report[]>, params: URLSearchParams) {
  const limit = Number(params.get('limit') ?? '25');
  const before = params.get('before');
  const beforeId = params.get('beforeId');
  let rows = Object.values(reportsByCell).flat();
  if (before !== null && beforeId !== null) {
    const at = Number(before);
    rows = rows.filter(
      (row) => row.createdAt < at || (row.createdAt === at && row.id < beforeId),
    );
  }
  rows = [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
  );
  const reports = rows.slice(0, limit);
  const last = reports[reports.length - 1];
  const hasMore = rows.length > limit;
  return {
    reports,
    hasMore,
    nextCursor: hasMore && last ? { before: last.createdAt, beforeId: last.id } : null,
  };
}

function stubFetch(cells: Cell[], reportsByCell: Record<string, Report[]>) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/cells') return jsonResponse(cells);
    if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
    if (url === '/api/summaries/feed' || url.startsWith('/api/summaries/feed?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      return jsonResponse(feedPage(reportsByCell, params));
    }
    if (url.startsWith('/api/summaries?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const cellId = params.get('cellId') ?? '';
      const before = params.get('before');
      const beforeId = params.get('beforeId');
      const rows = reportsByCell[cellId] ?? [];
      const next =
        before !== null && beforeId !== null
          ? rows.filter((row) => {
              const at = Number(before);
              return row.createdAt < at || (row.createdAt === at && row.id < beforeId);
            })
          : rows;
      return jsonResponse(next);
    }
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return urls;
}

function summaryRequests(urls: string[]): URLSearchParams[] {
  return urls
    .filter((url) => url.startsWith('/api/summaries?'))
    .map((url) => new URL(url, 'http://localhost').searchParams);
}

function feedRequests(urls: string[]): URLSearchParams[] {
  return urls
    .filter((url) => url.startsWith('/api/summaries/feed'))
    .map((url) => new URL(url, 'http://localhost').searchParams);
}

describe('ScorecardsPage', () => {
  it('groups reports by cell, newest first, with earlier history', async () => {
    const urls = stubFetch(
      [makeCell('c1', 'Alpha'), makeCell('c2', 'Beta'), makeCell('c3', 'Gamma')],
      {
        c1: [
          makeReport('s1', 'c1', 'Alpha newest report', 2_000_000),
          makeReport('s0', 'c1', 'Alpha previous report', 1_000_000),
        ],
        c2: [makeReport('s2', 'c2', 'Beta newest report', 1_500_000)],
      },
    );

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha newest report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Beta newest report')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Earlier scorecards (1)')).toBeInTheDocument();
    expect(screen.getByText('Alpha previous report')).toBeInTheDocument();
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    expect(screen.queryByText('No scorecards yet')).not.toBeInTheDocument();

    const requests = summaryRequests(urls);
    expect(requests).toHaveLength(3);
    expect(requests.map((params) => params.get('cellId')).sort()).toEqual(['c1', 'c2', 'c3']);
    for (const params of requests) {
      expect(params.get('limit')).toBe('26');
      expect(params.get('since')).not.toBeNull();
    }
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('defaults to the last 72 hours', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha report')).toBeInTheDocument();
    const [params] = summaryRequests(urls);
    const since = Number(params?.get('since'));
    const expected = Date.now() - 72 * 60 * 60_000;
    expect(Number.isFinite(since)).toBe(true);
    expect(Math.abs(since - expected)).toBeLessThan(60_000);
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

    const requests = summaryRequests(urls);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get('cellId')).toBe('c1');
    expect(requests[0]?.get('limit')).toBe('26');
    expect(urls).toContain('/api/summaries/status?cellId=c1');
    expect(urls.some((url) => url.includes('cellId=c2'))).toBe(false);
  });

  it('reloads with a matching period and omits since for all time', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    const sevenDaySince = Number(summaryRequests(urls)[1]?.get('since'));
    const expected = Date.now() - 7 * 24 * 60 * 60_000;
    expect(Math.abs(sevenDaySince - expected)).toBeLessThan(60_000);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    expect(summaryRequests(urls)[2]?.has('since')).toBe(false);
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('loads older reports within the period and stops at the end', async () => {
    const reports = Array.from({ length: 27 }, (_, index) =>
      makeReport(`s${index}`, 'c1', `Report ${index}`, 100_000 - index),
    );
    const urls = stubFetch([makeCell('c1', 'Alpha')], { c1: reports });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Report 0', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Earlier scorecards (24)')).toBeInTheDocument();
    expect(screen.queryByText('Report 25')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(await screen.findByText('Report 25', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Report 26')).toBeInTheDocument();
    expect(screen.getByText('Earlier scorecards (26)')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );

    const older = summaryRequests(urls)[1];
    expect(older?.get('before')).toBe('99976');
    expect(older?.get('beforeId')).toBe('s24');
    expect(older?.get('since')).not.toBeNull();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('keeps each card loading independently while older pages are in flight', async () => {
    const alpha = Array.from({ length: 26 }, (_, index) =>
      makeReport(`a${index}`, 'c1', `Alpha report ${index}`, 1_000 - index),
    );
    const beta = Array.from({ length: 26 }, (_, index) =>
      makeReport(`b${index}`, 'c2', `Beta report ${index}`, 900 - index),
    );
    const pending: Array<{ cellId: string; resolve: (rows: Report[]) => void }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/cells')
          return jsonResponse([makeCell('c1', 'Alpha'), makeCell('c2', 'Beta')]);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url.startsWith('/api/summaries?')) {
          const params = new URL(url, 'http://localhost').searchParams;
          const cellId = params.get('cellId') ?? '';
          const rows = cellId === 'c1' ? alpha : beta;
          if (params.has('before')) {
            return new Promise<Response>((resolve) => {
              pending.push({
                cellId,
                resolve: (older) => resolve(jsonResponse(older)),
              });
            });
          }
          return jsonResponse(rows);
        }
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    const buttons = await screen.findAllByRole('button', { name: 'Load older' }, { timeout: ASYNC_TIMEOUT_MS });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);

    expect(await screen.findAllByRole('button', { name: 'Loading…' }, { timeout: ASYNC_TIMEOUT_MS })).toHaveLength(2);
    pending[0]!.resolve([alpha[25]!]);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Loading…' })).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS },
    );
    pending[1]!.resolve([beta[25]!]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Loading…' })).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );

    expect(screen.getByText('Alpha report 25')).toBeInTheDocument();
    expect(screen.getByText('Beta report 25')).toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('shows a range-aware empty state', async () => {
    stubFetch([makeCell('c1', 'Alpha')], {});

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('No scorecards in the last 72 hours')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(await screen.findByText('No scorecards yet')).toBeInTheDocument();
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

  it('offers Grouped and Flat for all cells and keeps grouped the default', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(
      await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grouped' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Flat' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(feedRequests(urls)).toHaveLength(0);
    expect(summaryRequests(urls)).toHaveLength(1);
  });

  it('hides the layout control when a cell is focused', async () => {
    stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId="c1" onError={() => {}} />);

    expect(
      await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Flat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Grouped' })).not.toBeInTheDocument();
  });

  it('loads one flat feed request across cells and renders newest first', async () => {
    const urls = stubFetch(
      [makeCell('c1', 'Alpha'), makeCell('c2', 'Beta')],
      {
        c1: [
          makeReport('s1', 'c1', 'Alpha newest report', 3_000),
          makeReport('s0', 'c1', 'Alpha older report', 1_000),
        ],
        c2: [makeReport('s2', 'c2', 'Beta newest report', 2_000)],
      },
    );

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(
      await screen.findByText('Alpha newest report', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));

    await waitFor(() => expect(feedRequests(urls)).toHaveLength(1), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    const [params] = feedRequests(urls);
    expect(params?.get('limit')).toBe('25');
    expect(params?.get('since')).not.toBeNull();
    expect(params?.has('cellId')).toBe(false);
    expect(summaryRequests(urls)).toHaveLength(2);

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3),
    );
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent),
    ).toEqual(['Alpha', 'Beta', 'Alpha']);
    expect(screen.getByText('Alpha older report')).toBeInTheDocument();
    expect(screen.queryByText(/Earlier scorecards/)).not.toBeInTheDocument();
  });

  it('appends the next flat page from the server cursor and reuses the period bound', async () => {
    const reports = Array.from({ length: 27 }, (_, index) =>
      makeReport(
        `s${index}`,
        index % 2 === 0 ? 'c1' : 'c2',
        `Feed report ${index}`,
        1_000 - index,
      ),
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const urls = stubFetch(
      [makeCell('c1', 'Alpha'), makeCell('c2', 'Beta')],
      {
        c1: reports.filter((report) => report.cellId === 'c1'),
        c2: reports.filter((report) => report.cellId === 'c2'),
      },
    );

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(
      await screen.findByText('Feed report 0', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));
    await waitFor(() => expect(feedRequests(urls)).toHaveLength(1), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    await waitFor(
      () => expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(25),
      { timeout: ASYNC_TIMEOUT_MS },
    );

    const firstSince = feedRequests(urls)[0]?.get('since');
    clock.mockReturnValue(2_060_000);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(feedRequests(urls)).toHaveLength(2), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    const older = feedRequests(urls)[1];
    expect(older?.get('since')).toBe(firstSince);
    expect(older?.get('before')).toBe('976');
    expect(older?.get('beforeId')).toBe('s24');
    await waitFor(
      () => expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(27),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.getByText('Feed report 26')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('keeps the flat page when loading more fails', async () => {
    const onError = vi.fn();
    const reports = Array.from({ length: 30 }, (_, index) =>
      makeReport(`f${index}`, 'c1', `Flat report ${index}`, 1_000 - index),
    );
    let feedCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/cells') return jsonResponse([makeCell('c1', 'Alpha')]);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url === '/api/summaries/feed' || url.startsWith('/api/summaries/feed?')) {
          feedCalls += 1;
          if (feedCalls > 1) return jsonResponse({ error: 'boom' }, 500);
          return jsonResponse(
            feedPage({ c1: reports }, new URL(url, 'http://localhost').searchParams),
          );
        }
        if (url.startsWith('/api/summaries?')) return jsonResponse(reports);
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={onError} />);
    expect(
      await screen.findByText('Flat report 0', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));
    await waitFor(
      () => expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(25),
      { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(onError).toHaveBeenCalled(), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(screen.getByText('Flat report 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('shows the retry state when the flat feed fails and recovers on refresh', async () => {
    const onError = vi.fn();
    const reports = [makeReport('r1', 'c1', 'Recovered report', 2_000_000)];
    let failFeed = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/cells') return jsonResponse([makeCell('c1', 'Alpha')]);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url === '/api/summaries/feed' || url.startsWith('/api/summaries/feed?')) {
          if (failFeed) {
            failFeed = false;
            return jsonResponse({ error: 'boom' }, 500);
          }
          return jsonResponse(
            feedPage({ c1: reports }, new URL(url, 'http://localhost').searchParams),
          );
        }
        if (url.startsWith('/api/summaries?')) return jsonResponse(reports);
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={onError} />);
    expect(
      await screen.findByText('Recovered report', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));

    expect(
      await screen.findByText("Couldn't load scorecards", undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(onError).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(
      await screen.findByText('Recovered report', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load scorecards")).not.toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('renders a flat report whose cell is missing under its raw id', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('r1', 'c1', 'Known cell report', 2_000_000)],
      gone: [makeReport('r2', 'gone', 'Detached cell report', 1_500_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(
      await screen.findByText('Known cell report', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));

    await waitFor(() => expect(feedRequests(urls)).toHaveLength(1), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(await screen.findByText('Detached cell report')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'gone' })).toBeInTheDocument();
  });

  it('re-requests the flat feed for a new period and omits since for all time', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('r1', 'c1', 'Period report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(
      await screen.findByText('Period report', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));
    await waitFor(() => expect(feedRequests(urls)).toHaveLength(1), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(feedRequests(urls)).toHaveLength(2), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    const sevenDaySince = Number(feedRequests(urls)[1]?.get('since'));
    expect(Number.isFinite(sevenDaySince)).toBe(true);
    expect(Math.abs(sevenDaySince - (Date.now() - 7 * 24 * 60 * 60_000))).toBeLessThan(
      60_000,
    );

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(feedRequests(urls)).toHaveLength(3), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(feedRequests(urls)[2]?.has('since')).toBe(false);
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('discards a flat response that arrives after switching back to grouped', async () => {
    let resolveFeed: ((response: Response) => void) | undefined;
    const grouped = [makeReport('r1', 'c1', 'Grouped report', 2_000_000)];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/cells') return jsonResponse([makeCell('c1', 'Alpha')]);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url === '/api/summaries/feed' || url.startsWith('/api/summaries/feed?')) {
          return new Promise<Response>((resolve) => {
            resolveFeed = resolve;
          });
        }
        if (url.startsWith('/api/summaries?')) return jsonResponse(grouped);
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(
      await screen.findByText('Grouped report', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));
    await waitFor(() => expect(resolveFeed).toBeDefined(), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Grouped' }));
    await waitFor(
      () =>
        expect(screen.getByRole('button', { name: 'Grouped' })).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      { timeout: ASYNC_TIMEOUT_MS },
    );

    resolveFeed!(
      jsonResponse({
        reports: [makeReport('r2', 'c1', 'Stale flat report', 3_000_000)],
        hasMore: false,
        nextCursor: null,
      }),
    );
    await waitFor(() => expect(resolveFeed).toBeDefined());
    expect(screen.queryByText('Stale flat report')).not.toBeInTheDocument();
    expect(screen.getByText('Grouped report')).toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);
});
