import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MasterDetail } from './MasterDetail';
import { jsonResponse, makeProcessResponse } from './test/fixtures';

function installFetch() {
  const captured: { ran?: boolean; result?: Record<string, unknown> } = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/config') {
      return jsonResponse({
        master: {
          enabled: true,
          intervalMinutes: 5,
          idleMinutes: 10,
          autoReview: true,
          includeUnassigned: true,
          prompt: 'prod prompt',
        },
        path: '/tmp/config.json',
      });
    }
    if (url === '/api/process') return jsonResponse(makeProcessResponse());
    if (url === '/api/master/status') {
      return jsonResponse({
        enabled: true,
        intervalMinutes: 5,
        running: false,
        nextRunAt: Date.now() + 300_000,
        lastRunAt: Date.now() - 60_000,
        lastResult: captured.result ?? null,
      });
    }
    if (url === '/api/cells') return jsonResponse([]);
    if (url.startsWith('/api/master/events')) return jsonResponse([]);
    if (url === '/api/requests/__master__/clarify') {
      return jsonResponse({ started: true, active: false, transcript: [] });
    }
    if (url === '/api/master/run') {
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
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

describe('MasterDetail', () => {
  it('shows the cron policy, activity, and chat without request fields', async () => {
    installFetch();
    render(
      <MasterDetail
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    expect(await screen.findByText('Process automation')).toBeInTheDocument();
    expect(screen.getByText('Cron loop')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText(/Master chat/)).toBeInTheDocument();
    expect(screen.getAllByText('Prompt used on cron').length).toBeGreaterThan(0);
    expect(screen.queryByText('Acceptance criteria')).not.toBeInTheDocument();
    expect(screen.queryByText('Target repo')).not.toBeInTheDocument();
  });

  it('runs a cycle from the detail', async () => {
    const captured = installFetch();
    render(
      <MasterDetail
        commands={[]}
        onClose={() => {}}
        onConfigure={() => {}}
        onError={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(captured.ran).toBe(true));
    expect(await screen.findByText(/Last cycle: 0 started/)).toBeInTheDocument();
  });

  it('uses the cell chat and cell status when a cell is selected', async () => {
    const process = makeProcessResponse();
    const cell = {
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
    const urls: string[] = [];
    const onConfigure = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/api/config') {
          return jsonResponse({
            master: {
              enabled: true,
              intervalMinutes: 5,
              idleMinutes: 10,
              autoReview: true,
              includeUnassigned: true,
              prompt: 'prod',
            },
            path: '/tmp/config.json',
          });
        }
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
    expect(urls).toContain('/api/master/status?cellId=c1');
    expect(urls).toContain('/api/requests/__master__%3Ac1/clarify');

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });
});
