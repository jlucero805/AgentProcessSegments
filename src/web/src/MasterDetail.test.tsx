import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MasterDetail } from './MasterDetail';
import { jsonResponse, makeProcessResponse } from './test/fixtures';
import type { CellDetail, MasterEvent } from './types';

// The drawer polls and loads several resources. Give its queries and whole-case
// budgets room under full-suite load while keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;
const MASTER_DETAIL_TEST_TIMEOUT_MS = 30_000;

function makeCell(): CellDetail {
  const process = makeProcessResponse();
  return {
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
    process: { version: process.version, segments: process.segments },
    createdAt: 1,
  };
}

function makeReport(id: string, content: string, createdAt: number) {
  return {
    id,
    cellId: 'c1',
    windowStart: createdAt - 360 * 60_000,
    windowEnd: createdAt,
    windowMinutes: 360,
    content,
    stats: {},
    createdAt,
  };
}

function summaryRequests(urls: string[]): URLSearchParams[] {
  return urls
    .filter((url) => url.startsWith('/api/summaries?'))
    .map((url) => new URL(url, 'http://localhost').searchParams);
}

function stubMasterDetail(
  summaries: (params: URLSearchParams) => unknown,
  extra: { scorecardRun?: unknown; urls?: string[] } = {},
) {
  const cell = makeCell();
  const urls = extra.urls ?? [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === '/api/process') return jsonResponse(makeProcessResponse());
      if (url === '/api/master/status?cellId=c1') {
        return jsonResponse({
          enabled: true,
          intervalMinutes: 3,
          running: false,
          nextRunAt: null,
          lastRunAt: null,
          lastResult: null,
        });
      }
      if (url === '/api/cells') return jsonResponse([cell]);
      if (url.startsWith('/api/master/events')) return jsonResponse([]);
      if (url.startsWith('/api/summaries?')) {
        const params = new URL(url, 'http://localhost').searchParams;
        return jsonResponse(summaries(params));
      }
      if (url === '/api/summaries/status?cellId=c1') {
        return jsonResponse({
          enabled: false,
          intervalMinutes: 360,
          windowMinutes: 360,
          running: false,
          nextRunAt: null,
          lastRunAt: null,
          lastError: null,
        });
      }
      if (url === '/api/summaries/run?cellId=c1') {
        return jsonResponse(extra.scorecardRun ?? null);
      }
      if (url === '/api/requests/__master__%3Ac1/clarify') {
        return jsonResponse({ started: true, active: false, transcript: [] });
      }
      return jsonResponse([]);
    }),
  );
  return urls;
}

describe('MasterDetail', () => {
  it('shows the cell policy, activity, chat, and run control', async () => {
    const captured: { ran?: boolean; result?: Record<string, unknown> } = {};
    const process = makeProcessResponse();
    const cell = makeCell();
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/api/process') return jsonResponse(process);
        if (url === '/api/master/status?cellId=c1') {
          return jsonResponse({
            enabled: true,
            intervalMinutes: 3,
            running: false,
            nextRunAt: Date.now() + 300_000,
            lastRunAt: Date.now() - 60_000,
            lastResult: captured.result ?? null,
          });
        }
        if (url === '/api/cells') return jsonResponse([cell]);
        if (url.startsWith('/api/master/events')) {
          return jsonResponse([
            {
              id: 'e1',
              cellId: 'c1',
              requestId: 'r1',
              action: 'prod',
              detail: 'Build it',
              createdAt: Date.now() - 30_000,
            },
          ]);
        }
        if (url.startsWith('/api/summaries?')) return jsonResponse([]);
        if (url === '/api/summaries/status?cellId=c1') {
          return jsonResponse({
            enabled: false,
            intervalMinutes: 360,
            windowMinutes: 360,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastError: null,
          });
        }
        if (url === '/api/requests/__master__%3Ac1/clarify') {
          return jsonResponse({
            started: true,
            active: false,
            transcript: [{ role: 'agent', kind: 'text', text: 'cell note', ts: 1 }],
          });
        }
        if (url === '/api/master/run?cellId=c1') {
          captured.ran = true;
          captured.result = {
            ranAt: Date.now(),
            cells: 1,
            dispatch: 0,
            started: 0,
            prodded: 0,
            reviewed: 0,
            advanced: 0,
            followUps: 0,
            skipped: 0,
          };
          return jsonResponse(captured.result);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <MasterDetail
        cellId="c1"
        cells={[makeCell()]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText('Alpha · process automation', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Cron loop')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText(/Master chat/)).toBeInTheDocument();
    expect(await screen.findByText('cell note', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Build it')).toBeInTheDocument();
    expect(urls).toContain('/api/master/status?cellId=c1');
    expect(urls).toContain('/api/requests/__master__%3Ac1/clarify');
    expect(urls.some((url) => url === '/api/config')).toBe(false);

    const [initialSummary] = summaryRequests(urls);
    expect(initialSummary?.get('cellId')).toBe('c1');
    expect(initialSummary?.get('limit')).toBe('5');
    const since = Number(initialSummary?.get('since'));
    expect(Number.isFinite(since)).toBe(true);
    expect(Math.abs(since - (Date.now() - 72 * 60 * 60_000))).toBeLessThan(60_000);
    expect(urls.some((url) => url.startsWith('/api/summaries/latest'))).toBe(false);
    const period = screen.getByRole('group', { name: 'Scorecard period' });
    expect(within(period).getByRole('button', { name: '72h' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(captured.ran).toBe(true), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText(/Last cycle: 0 started/, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, MASTER_DETAIL_TEST_TIMEOUT_MS);

  it('caps recent activity and keeps every event scrollable', async () => {
    const events: MasterEvent[] = Array.from({ length: 30 }, (_, index) => ({
      id: `e${index}`,
      cellId: 'c1',
      requestId: null,
      action: 'cycle',
      detail: `Cycle ${index}`,
      createdAt: Date.now() - index * 1_000,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/process') return jsonResponse(makeProcessResponse());
        if (url === '/api/master/status?cellId=c1') {
          return jsonResponse({
            enabled: true,
            intervalMinutes: 3,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          });
        }
        if (url === '/api/cells') return jsonResponse([makeCell()]);
        if (url.startsWith('/api/master/events')) return jsonResponse(events);
        if (url.startsWith('/api/summaries?')) return jsonResponse([]);
        if (url === '/api/summaries/status?cellId=c1') {
          return jsonResponse({
            enabled: false,
            intervalMinutes: 360,
            windowMinutes: 360,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastError: null,
          });
        }
        if (url === '/api/requests/__master__%3Ac1/clarify') {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        return jsonResponse([]);
      }),
    );

    render(
      <MasterDetail
        cellId="c1"
        cells={[makeCell()]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    const list = await screen.findByRole('list', { name: 'Recent activity' }, { timeout: ASYNC_TIMEOUT_MS });
    expect(list).toHaveClass('max-h-80', 'overflow-y-auto');
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
  }, MASTER_DETAIL_TEST_TIMEOUT_MS);

  it('runs a scorecard and passes the selected cell to configure', async () => {
    const process = makeProcessResponse();
    const cell = makeCell();
    const urls: string[] = [];
    const onConfigure = vi.fn();
    const scorecard = {
      id: 's1',
      cellId: 'c1',
      windowStart: Date.now() - 360 * 60_000,
      windowEnd: Date.now(),
      windowMinutes: 360,
      content: '# Quiet window\n\nNo activity.',
      stats: {
        windowStart: Date.now() - 360 * 60_000,
        windowEnd: Date.now(),
        windowMinutes: 360,
        cell: { id: 'c1', name: 'Alpha' },
        requests: {
          total: 0,
          byState: {},
          created: 0,
          updated: 0,
          completed: 0,
          dropped: 0,
          stalled: [],
          unchecked: 0,
          agentStatus: {},
        },
        activity: {},
        previous: { created: 0, completed: 0, dropped: 0, activity: {} },
      },
      createdAt: Date.now(),
    };
    const capturedScorecard: { ran?: boolean } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/api/process') return jsonResponse(process);
        if (url === '/api/master/status?cellId=c1') {
          return jsonResponse({
            enabled: true,
            intervalMinutes: 3,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          });
        }
        if (url === '/api/cells') return jsonResponse([cell]);
        if (url.startsWith('/api/master/events')) return jsonResponse([]);
        if (url.startsWith('/api/summaries?')) return jsonResponse([scorecard]);
        if (url === '/api/summaries/status?cellId=c1') {
          return jsonResponse({
            enabled: true,
            intervalMinutes: 360,
            windowMinutes: 360,
            running: false,
            nextRunAt: Date.now() + 300_000,
            lastRunAt: Date.now() - 60_000,
            lastError: null,
          });
        }
        if (url === '/api/summaries/run?cellId=c1') {
          capturedScorecard.ran = true;
          return jsonResponse(scorecard);
        }
        if (url === '/api/requests/__master__%3Ac1/clarify') {
          return jsonResponse({
            started: true,
            active: false,
            transcript: [{ role: 'agent', kind: 'text', text: 'cell note', ts: 1 }],
          });
        }
        return jsonResponse([]);
      }),
    );

    render(
      <MasterDetail
        cellId="c1"
        cells={[makeCell()]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={onConfigure}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText('Alpha · process automation', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(await screen.findByText('cell note', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(await screen.findByText('No activity.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(urls).toContain('/api/master/status?cellId=c1');
    expect(urls).toContain('/api/requests/__master__%3Ac1/clarify');
    expect(urls).toContain('/api/summaries/status?cellId=c1');

    fireEvent.click(screen.getByRole('button', { name: 'Run scorecard now' }));
    await waitFor(() => expect(capturedScorecard.ran).toBe(true), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  }, MASTER_DETAIL_TEST_TIMEOUT_MS);

  it('reloads the scorecard history for the selected period and all time', async () => {
    const now = Date.now();
    const reports = [
      makeReport('s2', 'Newest scorecard', now),
      makeReport('s1', 'Older scorecard', now - 60 * 60_000),
    ];
    const urls = stubMasterDetail((params) => {
      const since = params.get('since');
      return since ? reports.filter((report) => report.createdAt >= Number(since)) : reports;
    });

    render(
      <MasterDetail
        cellId="c1"
        cells={[makeCell()]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText('Newest scorecard', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('Earlier scorecards (1)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();

    const initial = summaryRequests(urls)[0];
    expect(initial?.get('limit')).toBe('5');
    expect(Math.abs(Number(initial?.get('since')) - (Date.now() - 72 * 60 * 60_000))).toBeLessThan(60_000);

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(
      () =>
        expect(
          summaryRequests(urls).some((params) => {
            const since = Number(params.get('since'));
            return (
              Number.isFinite(since) &&
              Math.abs(since - (Date.now() - 7 * 24 * 60 * 60_000)) < 60_000
            );
          }),
        ).toBe(true),
      { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(
      () => expect(summaryRequests(urls).some((params) => !params.has('since'))).toBe(true),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(summaryRequests(urls).find((params) => !params.has('since'))?.get('limit')).toBe('5');
  }, MASTER_DETAIL_TEST_TIMEOUT_MS);

  it('keeps a report generated outside the period out of the card', async () => {
    const old = makeReport('old', 'Old scorecard', Date.now() - 10 * 24 * 60 * 60_000);
    stubMasterDetail((params) => (params.has('since') ? [] : [old]));

    render(
      <MasterDetail
        cellId="c1"
        cells={[makeCell()]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText(/No scorecards in the last 72 hours/)).toBeInTheDocument();
    expect(screen.queryByText('Old scorecard')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Scorecard period' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByText('Old scorecard', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, MASTER_DETAIL_TEST_TIMEOUT_MS);

  it('shows the all-time empty state when no scorecard exists', async () => {
    stubMasterDetail(() => []);

    render(
      <MasterDetail
        cellId="c1"
        cells={[makeCell()]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText(/No scorecards in the last 72 hours/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByText(/No scorecard yet/)).toBeInTheDocument();
  }, MASTER_DETAIL_TEST_TIMEOUT_MS);

  it('disables every action when the cell is deleted', async () => {
    const urls = stubMasterDetail(() => []);

    const { rerender } = render(
      <MasterDetail
        cellId="c1"
        cells={[makeCell()]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    expect(
      await screen.findByText('Alpha · process automation', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    const masterCalls = urls.filter((url) => url.startsWith('/api/master/')).length;

    rerender(
      <MasterDetail
        cellId="c1"
        cells={[]}
        cellsLoaded
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    await act(async () => {});
    expect(screen.getByTestId('master-deleted')).toHaveTextContent(
      'This cell no longer exists.',
    );
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Master chat/)).not.toBeInTheDocument();
    expect(urls.filter((url) => url.startsWith('/api/master/'))).toHaveLength(masterCalls);
    expect(urls).not.toContain('/api/cells');
  }, MASTER_DETAIL_TEST_TIMEOUT_MS);
});
