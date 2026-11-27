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

function stubFetch(cells: Cell[], reportsByCell: Record<string, Report[]>) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/cells') return jsonResponse(cells);
    if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
    if (url.startsWith('/api/summaries/grouped')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const limit = Number(params.get('limit') ?? 10);
      const groups = Object.entries(reportsByCell)
        .map(([cellId, rows]) => ({
          cellId,
          reports: rows.slice(0, limit),
          hasMore: rows.length > limit,
        }))
        .filter((group) => group.reports.length > 0)
        .sort(
          (a, b) => (b.reports[0]?.createdAt ?? 0) - (a.reports[0]?.createdAt ?? 0),
        );
      return jsonResponse({ groups });
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

function groupedRequests(urls: string[]): URLSearchParams[] {
  return urls
    .filter((url) => url.startsWith('/api/summaries/grouped'))
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

    const requests = groupedRequests(urls);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get('limit')).toBe('25');
    expect(requests[0]?.has('cellId')).toBe(false);
    expect(requests[0]?.get('since')).not.toBeNull();
    expect(summaryRequests(urls)).toHaveLength(0);
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('loads all cells through one grouped request without per-cell fan-out', async () => {
    const urls = stubFetch(
      [makeCell('c1', 'Alpha'), makeCell('c2', 'Beta'), makeCell('c3', 'Gamma')],
      {
        c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
        c2: [makeReport('s2', 'c2', 'Beta report', 1_500_000)],
      },
    );

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Beta report')).toBeInTheDocument();
    const grouped = groupedRequests(urls);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.get('limit')).toBe('25');
    expect(grouped[0]?.has('cellId')).toBe(false);
    expect(urls.some((url) => url.startsWith('/api/summaries?'))).toBe(false);
    expect(urls.some((url) => url.includes('cellId=c3'))).toBe(false);
  });

  it('drops a grouped cell that is no longer in the cell list', async () => {
    stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
      gone: [makeReport('s9', 'gone', 'Orphan report', 3_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByText('Orphan report')).not.toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
  });

  it('defaults to the last 72 hours', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
    const [params] = groupedRequests(urls);
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
    await waitFor(() => expect(groupedRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    const sevenDaySince = Number(groupedRequests(urls)[1]?.get('since'));
    const expected = Date.now() - 7 * 24 * 60 * 60_000;
    expect(Math.abs(sevenDaySince - expected)).toBeLessThan(60_000);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(groupedRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    expect(groupedRequests(urls)[2]?.has('since')).toBe(false);
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('applies a custom local whole-day range and clears it for presets', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    const prefilled = summaryRequests(urls)[1];
    expect(prefilled?.get('since')).not.toBeNull();
    expect(prefilled?.get('until')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-11-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    const applied = summaryRequests(urls)[2];
    expect(applied?.get('limit')).toBe('26');
    expect(applied?.get('since')).toBe(String(new Date(2026, 10, 1).getTime()));
    expect(applied?.get('until')).toBe(
      String(new Date(2026, 10, 15, 23, 59, 59, 999).getTime()),
    );

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(4), { timeout: ASYNC_TIMEOUT_MS });
    expect(summaryRequests(urls)[3]?.has('until')).toBe(false);
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('rejects an inverted custom range without a request', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2030-05-10' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2030-05-01' },
    });

    expect(
      screen.getByText('Choose a start date on or before the end date.'),
    ).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(summaryRequests(urls)).toHaveLength(2);
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('reuses the custom bounds when loading older pages', async () => {
    const reports = Array.from({ length: 27 }, (_, index) =>
      makeReport(`s${index}`, 'c1', `Report ${index}`, 100_000 - index),
    );
    const urls = stubFetch([makeCell('c1', 'Alpha')], { c1: reports });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Report 0', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    const custom = summaryRequests(urls)[1];
    const since = custom?.get('since');
    const until = custom?.get('until');
    expect(since).not.toBeNull();
    expect(until).not.toBeNull();
    expect(
      await screen.findByRole('button', { name: 'Load older' }, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60_000);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
      await waitFor(() => expect(summaryRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    } finally {
      nowSpy.mockRestore();
    }

    const older = summaryRequests(urls)[2];
    expect(older?.get('since')).toBe(since);
    expect(older?.get('until')).toBe(until);
    expect(older?.get('before')).toBe('99976');
    expect(older?.get('beforeId')).toBe('s24');
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('keeps custom filtering scoped to the selected cell', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha'), makeCell('c2', 'Beta')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
      c2: [makeReport('s2', 'c2', 'Beta report', 2_000_000)],
    });

    render(<ScorecardsPage cellId="c1" onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(summaryRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    const custom = summaryRequests(urls)[1];
    expect(custom?.get('cellId')).toBe('c1');
    expect(custom?.get('until')).not.toBeNull();
    expect(screen.queryByText('Beta report')).not.toBeInTheDocument();
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

    const older = summaryRequests(urls)[0];
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
        if (url.startsWith('/api/summaries/grouped')) {
          return jsonResponse({
            groups: [
              { cellId: 'c1', reports: alpha.slice(0, 25), hasMore: true },
              { cellId: 'c2', reports: beta.slice(0, 25), hasMore: true },
            ],
          });
        }
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

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(
      await screen.findByText('No scorecards in the selected date range'),
    ).toBeInTheDocument();
  });

  it('reports a grouped load failure and lets Refresh retry', async () => {
    const onError = vi.fn();
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/api/cells') return jsonResponse([makeCell('c1', 'Alpha')]);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url.startsWith('/api/summaries/grouped')) {
          return jsonResponse({ error: 'boom' }, 500);
        }
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={onError} />);

    expect(await screen.findByText("Couldn't load scorecards")).toBeInTheDocument();
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(groupedRequests(urls)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(groupedRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
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
