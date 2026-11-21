import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { jsonResponse, makeProcessResponse } from './test/fixtures';
import type { Cell, MasterConfig, MasterEvent, MasterStatus, SegmentConfig } from './types';

const master: MasterConfig = {
  enabled: true,
  intervalMinutes: 5,
  idleMinutes: 10,
  autoReview: true,
  includeUnassigned: true,
  prompt: 'prod prompt',
};

const status: MasterStatus = {
  enabled: true,
  intervalMinutes: 5,
  running: false,
  nextRunAt: Date.now() + 300_000,
  lastRunAt: Date.now() - 60_000,
  lastResult: null,
};

const cell: Cell = {
  id: 'c1',
  name: 'Alpha',
  masterEnabled: true,
  masterIntervalMinutes: null,
  maxConcurrent: 3,
  model: null,
  effort: null,
  createdAt: 1,
};

const event: MasterEvent = {
  id: 'e1',
  cellId: 'c1',
  requestId: 'r1',
  action: 'prod',
  detail: 'Build it',
  createdAt: Date.now() - 30_000,
};

interface Captured {
  config?: { master?: Partial<MasterConfig> };
  process?: { segments?: SegmentConfig[] };
  cell?: { masterEnabled?: boolean };
  ran?: boolean;
}

function installFetch(): Captured {
  const captured: Captured = {};
  const processResponse = makeProcessResponse();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/config' && init?.method === 'PATCH') {
      captured.config = JSON.parse(String(init.body)) as Captured['config'];
      return jsonResponse({
        master: { ...master, ...captured.config?.master },
        path: '/tmp/sandbox-harness/config.json',
      });
    }
    if (url === '/api/config') {
      return jsonResponse({ master, path: '/tmp/sandbox-harness/config.json' });
    }
    if (url === '/api/process' && init?.method === 'PATCH') {
      captured.process = JSON.parse(String(init.body)) as Captured['process'];
      return jsonResponse({ ...processResponse, segments: captured.process?.segments });
    }
    if (url === '/api/process') return jsonResponse(processResponse);
    if (url === '/api/requests/__master__/clarify') {
      return jsonResponse({
        started: true,
        active: false,
        transcript: [{ role: 'agent', kind: 'text', text: 'Master cycle: 1 prodded', ts: 1 }],
      });
    }
    if (url === '/api/master/status') return jsonResponse(status);
    if (url.startsWith('/api/master/events')) return jsonResponse([event]);
    if (url === '/api/cells/c1' && init?.method === 'PATCH') {
      captured.cell = JSON.parse(String(init.body)) as Captured['cell'];
      return jsonResponse({ ...cell, ...captured.cell });
    }
    if (url === '/api/cells') return jsonResponse([cell]);
    if (url === '/api/master/run') {
      captured.ran = true;
      return jsonResponse({
        ranAt: Date.now(),
        cells: 1,
        dispatch: 0,
        started: 0,
        prodded: 0,
        reviewed: 0,
        advanced: 0,
        followUps: 0,
        skipped: 0,
      });
    }
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

describe('ConfigPage', () => {
  it('loads settings, saves a patch, and shows the path', async () => {
    const captured = installFetch();

    render(<ConfigPage commands={[]} onError={() => {}} />);

    const interval = await screen.findByRole('spinbutton', { name: /interval/i });
    expect(interval).toHaveValue(5);
    expect(screen.getByText('/tmp/sandbox-harness/config.json')).toBeInTheDocument();

    fireEvent.change(interval, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(captured.config).toBeDefined());
    expect(captured.config?.master).toMatchObject({ intervalMinutes: 8, idleMinutes: 10 });
  });

  it('toggles the master switch', async () => {
    const captured = installFetch();

    render(<ConfigPage commands={[]} onError={() => {}} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Master enabled' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(captured.config).toBeDefined());
    expect(captured.config?.master).toMatchObject({ enabled: false });
  });

  it('runs the master and toggles a cell', async () => {
    const captured = installFetch();

    render(<ConfigPage commands={[]} onError={() => {}} />);

    const cellToggle = await screen.findByRole('checkbox', { name: 'Alpha master' });
    expect(cellToggle).toBeChecked();
    fireEvent.click(cellToggle);
    await waitFor(() => expect(captured.cell).toEqual({ masterEnabled: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Run master now' }));
    expect(await screen.findByText(/Last cycle: 0 started/)).toBeInTheDocument();
    expect(captured.ran).toBe(true);
  });

  it('shows recent activity and the master chat notes', async () => {
    installFetch();
    render(<ConfigPage commands={[]} onError={() => {}} />);
    expect(await screen.findByText('Build it')).toBeInTheDocument();
    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(await screen.findByText('Master cycle: 1 prodded')).toBeInTheDocument();
  });

  it('saves a per-segment process change', async () => {
    const captured = installFetch();
    render(<ConfigPage commands={[]} onError={() => {}} />);

    const intake = await screen.findByRole('checkbox', { name: 'Automate Requests' });
    expect(intake).not.toBeChecked();
    fireEvent.click(intake);
    fireEvent.click(screen.getByRole('button', { name: 'Save process' }));

    await waitFor(() => expect(captured.process).toBeDefined());
    expect(
      captured.process?.segments?.find((segment) => segment.id === 'intake')?.enabled,
    ).toBe(true);
  });
});
