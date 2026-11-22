import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { jsonResponse, makePrice, makeProcessResponse } from './test/fixtures';
import type {
  BudgetsResponse,
  Cell,
  MasterConfig,
  MasterEvent,
  ModelPrice,
  ModelPriceInput,
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
  monthlyBudgetUsd: null,
  autocompactPercent: 80,
  createdAt: 1,
};

const budget = { monthlyUsd: 100, alertAtPercent: 80 };

const budgetView: BudgetsResponse = {
  periodStart: Date.UTC(2026, 10, 1),
  periodEnd: Date.UTC(2026, 11, 1),
  alertAtPercent: 80,
  usageAvailable: true,
  statuses: [
    {
      scope: 'overall',
      cellId: null,
      cellName: null,
      label: 'Overall',
      periodStart: Date.UTC(2026, 10, 1),
      periodEnd: Date.UTC(2026, 11, 1),
      budgetUsd: 100,
      spendUsd: 85,
      remainingUsd: 15,
      percentUsed: 85,
      pricedTurns: 3,
      unknownCostTurns: 1,
      spendIsLowerBound: true,
      state: 'warning',
    },
  ],
  alerts: [],
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
    budget?: { monthlyUsd?: number | null; alertAtPercent?: number };
  };
  process?: { segments?: SegmentConfig[] };
  cell?: { masterEnabled?: boolean };
  price?: ModelPriceInput;
  deletedPriceId?: string;
}

function installFetch(
  view: BudgetsResponse = budgetView,
  events: MasterEvent[] = [event],
  prices: ModelPrice[] = [],
  postError?: { status: number; message: string },
): Captured {
  const captured: Captured = {};
  const processResponse = makeProcessResponse();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/pricing' && init?.method === 'POST') {
      if (postError) return jsonResponse({ message: postError.message }, postError.status);
      captured.price = JSON.parse(String(init.body)) as ModelPriceInput;
      return jsonResponse(makePrice({ ...captured.price, id: 'price-new' }), 201);
    }
    if (url.startsWith('/api/pricing/') && init?.method === 'DELETE') {
      captured.deletedPriceId = decodeURIComponent(url.slice('/api/pricing/'.length));
      return jsonResponse(null, 204);
    }
    if (url === '/api/pricing') return jsonResponse({ prices });
    if (url === '/api/config' && init?.method === 'PATCH') {
      captured.config = JSON.parse(String(init.body)) as Captured['config'];
      return jsonResponse({
        master: { ...master, ...captured.config?.master },
        summary: { ...scorecard, ...captured.config?.summary },
        usage: { ...usage, ...captured.config?.usage },
        budget: { ...budget, ...captured.config?.budget },
        path: '/tmp/agent-process-segments/config.json',
      });
    }
    if (url === '/api/config') {
      return jsonResponse({
        master,
        summary: scorecard,
        usage,
        budget,
        path: '/tmp/agent-process-segments/config.json',
      });
    }
    if (url === '/api/budgets') return jsonResponse(view);
    if (url === '/api/process' && init?.method === 'PATCH') {
      captured.process = JSON.parse(String(init.body)) as Captured['process'];
      return jsonResponse({ ...processResponse, segments: captured.process?.segments });
    }
    if (url === '/api/process') return jsonResponse(processResponse);
    if (url.startsWith('/api/master/events')) return jsonResponse(events);
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
    expect(screen.getByText('/tmp/agent-process-segments/config.json')).toBeInTheDocument();
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

  it('edits the overall budget, shows status, and saves independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const monthly = await screen.findByRole('spinbutton', { name: /overall monthly budget/i });
    expect(monthly).toHaveValue(100);
    expect(screen.getByText('Overall')).toBeInTheDocument();
    expect(screen.getByText(/At least \$85\.00 of \$100\.00 \(85%\)/)).toBeInTheDocument();

    const threshold = screen.getByRole('spinbutton', { name: /alert threshold/i });
    expect(threshold).toHaveValue(80);

    fireEvent.change(monthly, { target: { value: '250.5' } });
    fireEvent.change(threshold, { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budgets' }));

    await waitFor(() =>
      expect(captured.config?.budget).toEqual({ monthlyUsd: 250.5, alertAtPercent: 90 }),
    );
    expect(captured.config?.master).toBeUndefined();
  });

  it('does not render an all-unpriced budget as measured zero', async () => {
    installFetch({
      ...budgetView,
      statuses: [
        {
          ...budgetView.statuses[0]!,
          spendUsd: 0,
          remainingUsd: 100,
          percentUsed: 0,
          pricedTurns: 0,
          unknownCostTurns: 2,
          spendIsLowerBound: true,
          state: 'unknown',
        },
      ],
    });
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText(/Spend unknown · 2 unpriced turns/)).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(0%\)/)).not.toBeInTheDocument();
  });

  it('caps recent activity so the config page stays short', async () => {
    const events: MasterEvent[] = Array.from({ length: 30 }, (_, index) => ({
      id: `e${index}`,
      cellId: null,
      requestId: null,
      action: 'prod',
      detail: `Prod ${index}`,
      createdAt: Date.now() - index * 1_000,
    }));
    installFetch(budgetView, events);
    render(<ConfigPage onError={() => {}} />);

    const list = await screen.findByRole('list', { name: 'Recent activity' });
    expect(list).toHaveClass('max-h-80', 'overflow-y-auto');
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
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

  it('lists configured model prices with their source', async () => {
    const price = makePrice();
    installFetch(budgetView, [event], [price]);
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('model-a')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/pricing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.com/pricing' })).toHaveAttribute(
      'href',
      'https://example.com/pricing',
    );
  });

  it('adds a price with a UTC effective date and every rate', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    fireEvent.change(await screen.findByLabelText(/Model id/), {
      target: { value: 'provider/model-a' },
    });
    fireEvent.change(screen.getByLabelText(/Effective date/), {
      target: { value: '2026-02-03' },
    });
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Cache read $/1M'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('Cache write $/1M'), { target: { value: '3.75' } });
    fireEvent.change(screen.getByLabelText('Reasoning $/1M'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText(/Source/), {
      target: { value: 'https://example.com/pricing' },
    });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'list price' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));

    await waitFor(() => expect(captured.price).toBeDefined());
    expect(captured.price).toEqual({
      model: 'provider/model-a',
      effectiveFrom: Date.UTC(2026, 1, 3),
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      cacheReadUsdPerMtok: 0.3,
      cacheWriteUsdPerMtok: 3.75,
      reasoningUsdPerMtok: 15,
      source: 'https://example.com/pricing',
      note: 'list price',
    });
  });

  it('blocks a price without a model, source, or complete rates', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    await screen.findByLabelText(/Model id/);
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));

    expect(
      await screen.findByText('Model, effective date, and source are required.'),
    ).toBeInTheDocument();
    expect(captured.price).toBeUndefined();
  });

  it('shows a duplicate price error from the server', async () => {
    installFetch(budgetView, [event], [], { status: 409, message: 'a price already exists for model-a' });
    render(<ConfigPage onError={() => {}} />);

    fireEvent.change(await screen.findByLabelText(/Model id/), {
      target: { value: 'model-a' },
    });
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Cache read $/1M'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Cache write $/1M'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Reasoning $/1M'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Source/), {
      target: { value: 'https://example.com/pricing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));

    expect(
      await screen.findByText('a price already exists for model-a'),
    ).toBeInTheDocument();
  });

  it('deletes a price after an inline confirmation', async () => {
    const price = makePrice();
    const captured = installFetch(budgetView, [event], [price]);
    render(<ConfigPage onError={() => {}} />);

    const remove = await screen.findByRole('button', { name: 'Delete price for model-a' });
    fireEvent.click(remove);
    expect(captured.deletedPriceId).toBeUndefined();
    expect(remove).toHaveTextContent('Confirm?');

    fireEvent.click(remove);
    await waitFor(() => expect(captured.deletedPriceId).toBe(price.id));
  });
});
