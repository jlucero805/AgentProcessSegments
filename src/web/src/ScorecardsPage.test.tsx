import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScorecardsPage } from './ScorecardsPage';
import { customWindow } from './ScorecardPeriod';
import { jsonResponse } from './test/fixtures';

// The page loads the latest-per-cell feed and report pages before rendering. Give the slow
// paging cases room under full-suite load while keeping them bounded.
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
    if (url.startsWith('/api/summaries/latest-per-cell')) {
      const groups = cells
        .flatMap((cell) => {
          const rows = reportsByCell[cell.id] ?? [];
          const latest = rows[0];
          if (!latest) return [];
          return [
            {
              cell: { id: cell.id, name: cell.name },
              summary: latest,
              hasOlder: rows.length > 1,
            },
          ];
        })
        .sort((a, b) => b.summary.createdAt - a.summary.createdAt);
      return jsonResponse(groups);
    }
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

function latestRequests(urls: string[]): URLSearchParams[] {
  return urls
    .filter((url) => url.startsWith('/api/summaries/latest-per-cell'))
    .map((url) => new URL(url, 'http://localhost').searchParams);
}

function feedRequests(urls: string[]): URLSearchParams[] {
  return urls
    .filter((url) => url.startsWith('/api/summaries/feed'))
    .map((url) => new URL(url, 'http://localhost').searchParams);
}

function appliedRangeLabel(since: number, until: number): string {
  const format = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  return `Applied: ${format(since)} – ${format(until)} (local; the end minute is included)`;
}

describe('customWindow', () => {
  it('defaults blank times to whole local days', () => {
    expect(customWindow('2026-11-01', '2026-11-15', '', '')).toEqual({
      since: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(),
      until: new Date(2026, 10, 15, 23, 59, 59, 999).getTime(),
    });
  });

  it('keeps the end minute inclusive and accepts equal minutes', () => {
    expect(customWindow('2026-11-01', '2026-11-01', '10:00', '10:00')).toEqual({
      since: new Date(2026, 10, 1, 10, 0, 0, 0).getTime(),
      until: new Date(2026, 10, 1, 10, 0, 59, 999).getTime(),
    });
  });

  it.each(['8:00', '24:00', '12:60', '12:00:30'])(
    'rejects malformed time %s',
    (value) => {
      expect(customWindow('2026-11-01', '2026-11-15', value, '23:59')).toBe(
        'Choose a valid start and end time.',
      );
    },
  );

  it('rejects an end minute before the start minute', () => {
    expect(customWindow('2026-11-01', '2026-11-01', '12:00', '08:00')).toBe(
      'Choose a start on or before the end.',
    );
  });
});

describe('ScorecardsPage', () => {
  it('loads one latest report per cell from one latest-per-cell feed', async () => {
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
    expect(screen.queryByText('Alpha previous report')).not.toBeInTheDocument();
    expect(screen.queryByText('Earlier scorecards (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    expect(screen.queryByText('No scorecards yet')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Load older' })).toHaveLength(1);

    const requests = latestRequests(urls);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.has('cellId')).toBe(false);
    expect(requests[0]?.get('since')).not.toBeNull();
    expect(summaryRequests(urls)).toHaveLength(0);
    expect(urls).not.toContain('/api/cells');
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('loads older reports for one card on demand and stops at the end', async () => {
    const reports = Array.from({ length: 27 }, (_, index) =>
      makeReport(`s${index}`, 'c1', `Report ${index}`, 100_000 - index),
    );
    const urls = stubFetch([makeCell('c1', 'Alpha')], { c1: reports });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Report 0', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByText('Earlier scorecards (1)')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(await screen.findByText('Report 1', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Report 25')).toBeInTheDocument();
    expect(screen.queryByText('Report 26')).not.toBeInTheDocument();
    expect(screen.getByText('Earlier scorecards (25)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(await screen.findByText('Report 26', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Earlier scorecards (26)')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );

    const older = summaryRequests(urls);
    expect(older).toHaveLength(2);
    expect(older[0]?.get('before')).toBe('100000');
    expect(older[0]?.get('beforeId')).toBe('s0');
    expect(older[1]?.get('before')).toBe('99975');
    expect(older[1]?.get('beforeId')).toBe('s25');
    for (const params of older) {
      expect(params.get('cellId')).toBe('c1');
      expect(params.get('limit')).toBe('26');
      expect(params.get('since')).not.toBeNull();
    }
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
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url.startsWith('/api/summaries/latest-per-cell')) {
          return jsonResponse([
            {
              cell: { id: 'c1', name: 'Alpha' },
              summary: alpha[0],
              hasOlder: true,
            },
            {
              cell: { id: 'c2', name: 'Beta' },
              summary: beta[0],
              hasOlder: true,
            },
          ]);
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
    pending[0]!.resolve([alpha[1]!]);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Loading…' })).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS },
    );
    pending[1]!.resolve([beta[1]!]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Loading…' })).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS },
    );

    expect(screen.getByText('Alpha report 1')).toBeInTheDocument();
    expect(screen.getByText('Beta report 1')).toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('keeps the latest report when an older page fails', async () => {
    const onError = vi.fn();
    const latest = makeReport('s0', 'c1', 'Latest report', 2_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url.startsWith('/api/summaries/latest-per-cell')) {
          return jsonResponse([
            { cell: { id: 'c1', name: 'Alpha' }, summary: latest, hasOlder: true },
          ]);
        }
        if (url.startsWith('/api/summaries?')) return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={onError} />);

    expect(await screen.findByText('Latest report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    await waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: ASYNC_TIMEOUT_MS });
    expect(screen.getByText('Latest report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older' })).toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('defaults to the last 72 hours', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('Alpha report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
    const [params] = latestRequests(urls);
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
    expect(latestRequests(urls)).toHaveLength(0);
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
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    const sevenDaySince = Number(latestRequests(urls)[1]?.get('since'));
    const expected = Date.now() - 7 * 24 * 60 * 60_000;
    expect(Math.abs(sevenDaySince - expected)).toBeLessThan(60_000);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    expect(latestRequests(urls)[2]?.has('since')).toBe(false);
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('applies a custom local whole-day range and clears it for presets', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    const prefilled = latestRequests(urls)[1];
    expect(prefilled?.get('since')).not.toBeNull();
    expect(prefilled?.get('until')).not.toBeNull();
    expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
    expect(screen.getByLabelText('End time')).toHaveValue('23:59');

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-11-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(latestRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    const applied = latestRequests(urls)[2];
    expect(applied?.has('limit')).toBe(false);
    expect(applied?.get('since')).toBe(String(new Date(2026, 10, 1).getTime()));
    expect(applied?.get('until')).toBe(
      String(new Date(2026, 10, 15, 23, 59, 59, 999).getTime()),
    );

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(4), { timeout: ASYNC_TIMEOUT_MS });
    expect(latestRequests(urls)[3]?.has('until')).toBe(false);
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('applies a custom time-of-day window', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '08:00' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(latestRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    const applied = latestRequests(urls)[2];
    expect(applied?.get('since')).toBe(
      String(new Date(2026, 10, 1, 8, 0, 0, 0).getTime()),
    );
    expect(applied?.get('until')).toBe(
      String(new Date(2026, 10, 1, 12, 0, 59, 999).getTime()),
    );
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('rejects an end time before the start time without a request', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2030-05-10' },
    });
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '12:00' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2030-05-10' },
    });
    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '08:00' },
    });

    expect(screen.getByText('Choose a start on or before the end.')).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(latestRequests(urls)).toHaveLength(2);
    expect(screen.getByText('Alpha report')).toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('prefills and resets Custom to whole local days', async () => {
    const now = new Date(2026, 10, 15, 10, 30, 0, 0).getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const urls = stubFetch([makeCell('c1', 'Alpha')], {
        c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
      });

      render(<ScorecardsPage cellId={null} onError={() => {}} />);
      expect(
        await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
      await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), {
        timeout: ASYNC_TIMEOUT_MS,
      });
      const prefilled = latestRequests(urls)[1];
      expect(prefilled?.get('since')).toBe(
        String(new Date(2026, 10, 12, 0, 0, 0, 0).getTime()),
      );
      expect(prefilled?.get('until')).toBe(
        String(new Date(2026, 10, 15, 23, 59, 59, 999).getTime()),
      );
      expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
      expect(screen.getByLabelText('End time')).toHaveValue('23:59');

      fireEvent.change(screen.getByLabelText('Start date'), {
        target: { value: '2026-11-01' },
      });
      fireEvent.change(screen.getByLabelText('Start time'), {
        target: { value: '08:00' },
      });
      fireEvent.change(screen.getByLabelText('End date'), {
        target: { value: '2026-11-02' },
      });
      fireEvent.change(screen.getByLabelText('End time'), {
        target: { value: '12:00' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(latestRequests(urls)).toHaveLength(3), {
        timeout: ASYNC_TIMEOUT_MS,
      });

      fireEvent.click(screen.getByRole('button', { name: '7d' }));
      await waitFor(() => expect(latestRequests(urls)).toHaveLength(4), {
        timeout: ASYNC_TIMEOUT_MS,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
      await waitFor(() => expect(latestRequests(urls)).toHaveLength(5), {
        timeout: ASYNC_TIMEOUT_MS,
      });

      const reapplied = latestRequests(urls)[4];
      expect(reapplied?.get('since')).toBe(
        String(new Date(2026, 10, 8, 0, 0, 0, 0).getTime()),
      );
      expect(reapplied?.get('until')).toBe(
        String(new Date(2026, 10, 15, 23, 59, 59, 999).getTime()),
      );
      expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
      expect(screen.getByLabelText('End time')).toHaveValue('23:59');
    } finally {
      nowSpy.mockRestore();
    }
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('shows the applied range until the draft is invalid', async () => {
    const now = new Date(2026, 10, 15, 10, 30, 0, 0).getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const urls = stubFetch([makeCell('c1', 'Alpha')], {
        c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
      });

      render(<ScorecardsPage cellId={null} onError={() => {}} />);
      expect(
        await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
      await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), {
        timeout: ASYNC_TIMEOUT_MS,
      });
      expect(
        screen.getByText(
          appliedRangeLabel(
            new Date(2026, 10, 12, 0, 0, 0, 0).getTime(),
            new Date(2026, 10, 15, 23, 59, 59, 999).getTime(),
          ),
        ),
      ).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Start date'), {
        target: { value: '2026-11-01' },
      });
      fireEvent.change(screen.getByLabelText('Start time'), {
        target: { value: '08:00' },
      });
      fireEvent.change(screen.getByLabelText('End date'), {
        target: { value: '2026-11-01' },
      });
      fireEvent.change(screen.getByLabelText('End time'), {
        target: { value: '12:00' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(latestRequests(urls)).toHaveLength(3), {
        timeout: ASYNC_TIMEOUT_MS,
      });

      const applied = appliedRangeLabel(
        new Date(2026, 10, 1, 8, 0, 0, 0).getTime(),
        new Date(2026, 10, 1, 12, 0, 59, 999).getTime(),
      );
      expect(screen.getByText(applied)).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('End time'), {
        target: { value: '07:00' },
      });
      expect(screen.getByText('Choose a start on or before the end.')).toBeInTheDocument();
      expect(screen.queryByText(applied)).not.toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('rejects an inverted custom range without a request', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('s1', 'c1', 'Alpha report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Alpha report', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2030-05-10' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2030-05-01' },
    });

    expect(
      screen.getByText('Choose a start on or before the end.'),
    ).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(latestRequests(urls)).toHaveLength(2);
  }, SCORECARDS_TEST_TIMEOUT_MS);

  it('reuses the custom bounds when loading older pages', async () => {
    const reports = Array.from({ length: 27 }, (_, index) =>
      makeReport(`s${index}`, 'c1', `Report ${index}`, 100_000 - index),
    );
    const urls = stubFetch([makeCell('c1', 'Alpha')], { c1: reports });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(await screen.findByText('Report 0', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '08:00' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-11-05' },
    });
    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(3), { timeout: ASYNC_TIMEOUT_MS });
    const custom = latestRequests(urls)[2];
    expect(custom?.get('since')).toBe(
      String(new Date(2026, 10, 1, 8, 0, 0, 0).getTime()),
    );
    expect(custom?.get('until')).toBe(
      String(new Date(2026, 10, 5, 12, 0, 59, 999).getTime()),
    );
    const since = custom?.get('since');
    const until = custom?.get('until');
    expect(
      await screen.findByRole('button', { name: 'Load older' }, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60_000);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
      await waitFor(() => expect(summaryRequests(urls)).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    } finally {
      nowSpy.mockRestore();
    }

    const older = summaryRequests(urls)[0];
    expect(older?.get('since')).toBe(since);
    expect(older?.get('until')).toBe(until);
    expect(older?.get('limit')).toBe('26');
    expect(older?.get('before')).toBe('100000');
    expect(older?.get('beforeId')).toBe('s0');
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

  it('shows a range-aware empty state', async () => {
    stubFetch([makeCell('c1', 'Alpha')], {});

    render(<ScorecardsPage cellId={null} onError={() => {}} />);

    expect(await screen.findByText('No scorecards in the last 72 hours')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(await screen.findByText('No scorecards yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(
      await screen.findByText('No scorecards in the selected range'),
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
        if (url.startsWith('/api/summaries/status')) return jsonResponse(STATUS);
        if (url.startsWith('/api/summaries/latest-per-cell')) {
          return jsonResponse({ error: 'boom' }, 500);
        }
        return jsonResponse([]);
      }),
    );

    render(<ScorecardsPage cellId={null} onError={onError} />);

    expect(await screen.findByText("Couldn't load scorecards")).toBeInTheDocument();
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(latestRequests(urls)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(latestRequests(urls)).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  });

  it('reports a focused-cell load failure', async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/cells') return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse(STATUS);
      }),
    );

    render(<ScorecardsPage cellId="c1" onError={onError} />);

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
    expect(latestRequests(urls)).toHaveLength(1);
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
    expect(latestRequests(urls)).toHaveLength(1);
    expect(feedRequests(urls)).toHaveLength(1);

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
        if (url.startsWith('/api/summaries/latest-per-cell')) {
          return jsonResponse([
            {
              cell: { id: 'c1', name: 'Alpha' },
              summary: reports[0]!,
              hasOlder: reports.length > 1,
            },
          ]);
        }
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
        if (url.startsWith('/api/summaries/latest-per-cell')) {
          return jsonResponse([
            {
              cell: { id: 'c1', name: 'Alpha' },
              summary: reports[0]!,
              hasOlder: reports.length > 1,
            },
          ]);
        }
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

  it('applies a custom date window to the flat feed', async () => {
    const urls = stubFetch([makeCell('c1', 'Alpha')], {
      c1: [makeReport('r1', 'c1', 'Custom flat report', 2_000_000)],
    });

    render(<ScorecardsPage cellId={null} onError={() => {}} />);
    expect(
      await screen.findByText('Custom flat report', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));
    await waitFor(() => expect(feedRequests(urls)).toHaveLength(1), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(feedRequests(urls)).toHaveLength(2), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '08:00' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-11-15' },
    });
    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(feedRequests(urls)).toHaveLength(3), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    const applied = feedRequests(urls)[2];
    expect(applied?.get('since')).toBe(
      String(new Date(2026, 10, 1, 8, 0, 0, 0).getTime()),
    );
    expect(applied?.get('until')).toBe(
      String(new Date(2026, 10, 15, 12, 0, 59, 999).getTime()),
    );

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(feedRequests(urls)).toHaveLength(4), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(feedRequests(urls)[3]?.has('until')).toBe(false);
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
        if (url.startsWith('/api/summaries/latest-per-cell')) {
          return jsonResponse([
            {
              cell: { id: 'c1', name: 'Alpha' },
              summary: grouped[0]!,
              hasOlder: false,
            },
          ]);
        }
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

    await act(async () => {
      resolveFeed!(
        jsonResponse({
          reports: [makeReport('r2', 'c1', 'Stale flat report', 3_000_000)],
          hasMore: false,
          nextCursor: null,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('Stale flat report')).not.toBeInTheDocument();
    expect(screen.getByText('Grouped report')).toBeInTheDocument();
  }, SCORECARDS_TEST_TIMEOUT_MS);
});
