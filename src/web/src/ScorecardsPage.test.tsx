import { render, screen, waitFor } from '@testing-library/react';
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
    if (url.startsWith('/api/summaries?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const cellId = params.get('cellId') ?? '';
      return jsonResponse(reportsByCell[cellId] ?? []);
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
    expect(urls).toContain('/api/summaries?cellId=c1&limit=10');
    expect(urls).toContain('/api/summaries?cellId=c2&limit=10');
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
    expect(urls).toContain('/api/summaries?cellId=c1&limit=25');
    expect(urls).toContain('/api/summaries/status?cellId=c1');
    expect(urls.some((url) => url.includes('cellId=c2'))).toBe(false);
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
