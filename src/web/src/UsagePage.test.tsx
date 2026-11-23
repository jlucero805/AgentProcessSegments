import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from './UsagePage';
import { jsonResponse, makeUsageResponse } from './test/fixtures';
import type { BudgetsResponse } from './types';

const CELLS = [
  {
    id: 'cell-1',
    name: 'Alpha',
    masterEnabled: true,
    masterIntervalMinutes: null,
    maxConcurrent: 3,
    model: null,
    effort: null,
    monthlyBudgetUsd: null,
    pauseOnExceeded: false,
    createdAt: 1,
  },
];

const BUDGETS: BudgetsResponse = {
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
      pauseOnExceeded: true,
      capSpendUsd: 85,
      capSpendIsLowerBound: true,
      unpricedTurns: 0,
      paused: false,
    },
  ],
  alerts: [],
  pauses: [],
};

function installFetch(
  response = makeUsageResponse(),
  budgets = BUDGETS,
  config: unknown | null = { usage: { retentionDays: 90 } },
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/cells') return jsonResponse(CELLS);
    if (url === '/api/budgets') return jsonResponse(budgets);
    if (url === '/api/config') {
      return config === null
        ? new Response(JSON.stringify({ error: 'unavailable' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : jsonResponse(config);
    }
    if (url.startsWith('/api/usage')) return jsonResponse(response);
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UsagePage', () => {
  it('renders effective totals, the reported/estimated split, and all breakdown tables', async () => {
    installFetch();
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText('Effective cost')).toBeInTheDocument();
    expect(screen.getAllByText('≈ $0.0160').length).toBeGreaterThan(0);
    expect(screen.getByText('reported $0.0120 · estimated $0.0040')).toBeInTheDocument();
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('By model')).toBeInTheDocument();
    expect(screen.getByText('Model A')).toBeInTheDocument();
    expect(screen.getByText('Model B')).toBeInTheDocument();
    expect(screen.getByText('By cell')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getByText('Top requests')).toBeInTheDocument();
    expect(screen.getByText('A request')).toBeInTheDocument();
    expect(screen.getAllByTitle(/estimated/).length).toBeGreaterThan(0);
  });

  it('shows unknown instead of zero when no turn is priced', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      totals: {
        ...base.totals,
        costUsd: null,
        estimatedCostUsd: null,
        totalCostUsd: null,
        reportedCostTurns: 0,
        estimatedCostTurns: 0,
        unpricedTurns: 2,
        unknownCostTurns: 2,
      },
      byModel: [],
    });
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findAllByText('unknown')).not.toHaveLength(0);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('shows current-month budget progress and lower-bound copy', async () => {
    installFetch();
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText('Monthly budgets')).toBeInTheDocument();
    expect(screen.getByText(/warning at 80%/)).toBeInTheDocument();
    expect(screen.getByText(/At least \$85\.00 of \$100\.00/)).toBeInTheDocument();
  });

  it('marks a paused scope and explains the cap spend', async () => {
    installFetch(makeUsageResponse(), {
      ...BUDGETS,
      statuses: [{ ...BUDGETS.statuses[0]!, paused: true, capSpendUsd: 100 }],
      pauses: [
        {
          scope: 'overall',
          cellId: null,
          cellName: null,
          label: 'Overall',
          periodStart: Date.UTC(2026, 10, 1),
          periodEnd: Date.UTC(2026, 11, 1),
          budgetUsd: 100,
          spendUsd: 100,
          spendIsLowerBound: false,
          unpricedTurns: 0,
          percentUsed: 100,
        },
      ],
    });
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText('paused')).toBeInTheDocument();
    expect(screen.getByText(/Paused at \$100\.00 cap spend/)).toBeInTheDocument();
    expect(screen.queryByText(/budgets never stop work/i)).not.toBeInTheDocument();
  });

  it('does not show an all-unpriced budget as zero', async () => {
    installFetch(makeUsageResponse(), {
      ...BUDGETS,
      statuses: [
        {
          ...BUDGETS.statuses[0]!,
          spendUsd: 0,
          remainingUsd: 100,
          percentUsed: 0,
          pricedTurns: 0,
          unknownCostTurns: 2,
          state: 'unknown',
        },
      ],
    });
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText(/Spend unknown · 2 unpriced turns/)).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.queryByText(/\(0%\)/)).not.toBeInTheDocument();
  });

  it('renders a lower bound when some turns remain unpriced', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      totals: {
        ...base.totals,
        costUsd: 0.012,
        estimatedCostUsd: null,
        totalCostUsd: 0.012,
        reportedCostTurns: 1,
        estimatedCostTurns: 0,
        unpricedTurns: 1,
        unknownCostTurns: 1,
      },
    });
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findAllByText('≥ $0.0120 · 1 unpriced')).not.toHaveLength(0);
    expect(screen.getByText('Unpriced turns')).toBeInTheDocument();
  });

  it('shows the retained raw window from config', async () => {
    installFetch();
    render(<UsagePage onError={vi.fn()} />);

    expect(
      await screen.findByText(
        'Raw usage is kept for 90 days; older turns are pruned. All-time totals cover the retained window.',
      ),
    ).toBeInTheDocument();
  });

  it('shows daily rollup coverage and indefinite retention', async () => {
    const base = makeUsageResponse();
    installFetch(
      { ...base, coverage: { rolledThrough: Date.UTC(2026, 0, 1) } },
      BUDGETS,
      { usage: { retentionDays: 0 } },
    );
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText(/Daily totals preserve history before/)).toBeInTheDocument();
    expect(screen.getByText(/kept indefinitely/)).toBeInTheDocument();
  });

  it('still renders usage when the config request fails', async () => {
    const base = makeUsageResponse();
    installFetch(
      { ...base, coverage: { rolledThrough: Date.UTC(2026, 0, 1) } },
      BUDGETS,
      null,
    );
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText('Effective cost')).toBeInTheDocument();
    expect(screen.getByText(/Daily totals preserve history before/)).toBeInTheDocument();
  });

  it('says history is kept indefinitely when retention is disabled', async () => {
    installFetch(makeUsageResponse(), BUDGETS, { usage: { retentionDays: 0 } });
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText('Usage history is kept indefinitely.')).toBeInTheDocument();
  });

  it('refetches with hour buckets when the range changes', async () => {
    const fetchMock = installFetch();
    render(<UsagePage onError={vi.fn()} />);
    await screen.findByText('Effective cost');

    fireEvent.click(screen.getByText('24h'));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('/api/usage?') && url.includes('bucket=hour'))).toBe(
        true,
      );
      const hourly = urls.find(
        (url) => url.includes('/api/usage?') && url.includes('bucket=hour'),
      ) ?? '';
      expect(hourly).toContain('from=');
      expect(hourly).toContain('to=');
    });
  });

  it('refetches with the selected cell', async () => {
    const fetchMock = installFetch();
    render(<UsagePage onError={vi.fn()} />);
    await screen.findByText('Effective cost');

    fireEvent.change(screen.getByLabelText('Filter usage by cell'), {
      target: { value: 'cell-1' },
    });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('cellId=cell-1'))).toBe(true);
    });
  });
});
