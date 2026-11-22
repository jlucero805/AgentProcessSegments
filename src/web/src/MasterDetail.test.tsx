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
    model: null,
    effort: null,
    process: { version: process.version, segments: process.segments },
    createdAt: 1,
  };
}

function installFetch() {
  const captured: { ran?: boolean; result?: Record<string, unknown> } = {};
  const process = makeProcessResponse();
  const cell = makeCell();
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
  });
  vi.stubGlobal('fetch', fetchMock);
  return { captured, urls };
}

describe('MasterDetail', () => {
  it('shows the cell policy, activity, chat, and run control', async () => {
    const { captured, urls } = installFetch();

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

  it('passes the selected cell to configure', async () => {
    installFetch();
    const onConfigure = vi.fn();

    render(
      <MasterDetail
        cellId="c1"
        commands={[]}
        onClose={() => {}}
        onConfigure={onConfigure}
        onError={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });
});
