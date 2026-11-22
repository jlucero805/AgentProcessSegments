import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { jsonResponse, makeProcessResponse } from './test/fixtures';
import type {
  Cell,
  MasterConfig,
  MasterEvent,
  SegmentConfig,
  SummaryConfig,
  UsageSettings,
} from './types';

const master: MasterConfig = {
  enabled: true,
  intervalMinutes: 5,
  idleMinutes: 10,
  autoReview: true,
  prompt: 'prod prompt',
};

const scorecard: SummaryConfig = {
  enabled: true,
  intervalMinutes: 360,
  windowMinutes: 360,
  prompt: 'summary prompt',
};

const usage: UsageSettings = { retentionDays: 90 };

const cell: Cell = {
  id: 'c1',
  name: 'Alpha',
  masterEnabled: true,
  masterIntervalMinutes: null,
  maxConcurrent: 3,
  harness: 'opencode',
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
  config?: {
    master?: Partial<MasterConfig>;
    summary?: Partial<SummaryConfig>;
    usage?: Partial<UsageSettings>;
  };
  process?: { segments?: SegmentConfig[] };
  cell?: { masterEnabled?: boolean };
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
        summary: { ...scorecard, ...captured.config?.summary },
        usage: { ...usage, ...captured.config?.usage },
        path: '/tmp/sandbox-harness/config.json',
      });
    }
    if (url === '/api/config') {
      return jsonResponse({
        master,
        summary: scorecard,
        usage,
        path: '/tmp/sandbox-harness/config.json',
      });
    }
    if (url === '/api/process' && init?.method === 'PATCH') {
      captured.process = JSON.parse(String(init.body)) as Captured['process'];
      return jsonResponse({ ...processResponse, segments: captured.process?.segments });
    }
    if (url === '/api/process') return jsonResponse(processResponse);
    if (url.startsWith('/api/master/events')) return jsonResponse([event]);
    if (url === '/api/cells/c1' && init?.method === 'PATCH') {
      captured.cell = JSON.parse(String(init.body)) as Captured['cell'];
      return jsonResponse({ ...cell, ...captured.cell });
    }
    if (url === '/api/cells') return jsonResponse([cell]);
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

describe('ConfigPage', () => {
  it('loads settings, saves a patch, and shows the path', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);

    const interval = await screen.findByRole('spinbutton', { name: /interval/i });
    expect(interval).toHaveValue(5);
    expect(screen.getByRole('spinbutton', { name: /every/i })).toHaveValue(360);
    expect(screen.getByText('/tmp/sandbox-harness/config.json')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /without a cell/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Global master chat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run master now/i })).not.toBeInTheDocument();

    fireEvent.change(interval, { target: { value: '8' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: /window/i }), {
      target: { value: '180' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(captured.config).toBeDefined());
    expect(captured.config?.master).toMatchObject({ intervalMinutes: 8, idleMinutes: 10 });
    expect(captured.config?.summary).toMatchObject({ intervalMinutes: 360, windowMinutes: 180 });
    expect(captured.config?.master).not.toHaveProperty('includeUnassigned');
  });

  it('loads and saves usage retention', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const retention = await screen.findByRole('spinbutton', { name: /retention/i });
    expect(retention).toHaveValue(90);
    expect(screen.getByText('0 keeps history forever')).toBeInTheDocument();

    fireEvent.change(retention, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save usage retention' }));

    await waitFor(() =>
      expect(captured.config?.usage).toEqual({ retentionDays: 30 }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(retention).toHaveValue(30);
  });

  it('toggles the master switch', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Master enabled' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(captured.config).toBeDefined());
    expect(captured.config?.master).toMatchObject({ enabled: false });
  });

  it('toggles a cell master', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);

    const cellToggle = await screen.findByRole('checkbox', { name: 'Alpha master' });
    expect(cellToggle).toBeChecked();
    fireEvent.click(cellToggle);
    await waitFor(() => expect(captured.cell).toEqual({ masterEnabled: false }));
  });

  it('shows recent activity', async () => {
    installFetch();
    render(<ConfigPage onError={() => {}} />);
    expect(await screen.findByText('Build it')).toBeInTheDocument();
    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
  });

  it('saves a per-segment process change', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

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
