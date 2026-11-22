import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MasterDetail } from './MasterDetail';
import { jsonResponse, makeProcessResponse } from './test/fixtures';
import type { CellDetail } from './types';

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
    process: { version: process.version, segments: process.segments },
    createdAt: 1,
  };
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
        if (url === '/api/summaries/latest?cellId=c1') return jsonResponse(null);
        if (url === '/api/summaries?cellId=c1&limit=5') return jsonResponse([]);
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
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText('Alpha · process automation')).toBeInTheDocument();
    expect(screen.getByText('Cron loop')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText(/Master chat/)).toBeInTheDocument();
    expect(await screen.findByText('cell note')).toBeInTheDocument();
    expect(screen.getByText('Build it')).toBeInTheDocument();
    expect(urls).toContain('/api/master/status?cellId=c1');
    expect(urls).toContain('/api/requests/__master__%3Ac1/clarify');
    expect(urls.some((url) => url === '/api/config')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(captured.ran).toBe(true));
    expect(await screen.findByText(/Last cycle: 0 started/)).toBeInTheDocument();
  });

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
        if (url === '/api/summaries/latest?cellId=c1') return jsonResponse(scorecard);
        if (url === '/api/summaries?cellId=c1&limit=5') return jsonResponse([scorecard]);
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
        commands={[]}
        onClose={() => {}}
        onConfigure={onConfigure}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText('Alpha · process automation')).toBeInTheDocument();
    expect(await screen.findByText('cell note')).toBeInTheDocument();
    expect(await screen.findByText('No activity.')).toBeInTheDocument();
    expect(urls).toContain('/api/master/status?cellId=c1');
    expect(urls).toContain('/api/requests/__master__%3Ac1/clarify');
    expect(urls).toContain('/api/summaries/status?cellId=c1');

    fireEvent.click(screen.getByRole('button', { name: 'Run scorecard now' }));
    await waitFor(() => expect(capturedScorecard.ran).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });
});
