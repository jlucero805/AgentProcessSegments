import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from './UsagePage';
import { jsonResponse, makeUsageResponse } from './test/fixtures';

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
    createdAt: 1,
  },
];

const BUDGETS = {
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

function installFetch(response = makeUsageResponse(), budgets = BUDGETS) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/cells') return jsonResponse(CELLS);
    if (url === '/api/budgets') return jsonResponse(budgets);
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
  it('renders totals, a lower-bound cost, and all breakdown tables', async () => {
    installFetch();
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText('Known cost')).toBeInTheDocument();
    expect(screen.getAllByText('≥ $0.0120 · 1 unpriced').length).toBeGreaterThan(0);
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('By model')).toBeInTheDocument();
    expect(screen.getByText('Model A')).toBeInTheDocument();
    expect(screen.getByText('Model B')).toBeInTheDocument();
    expect(screen.getByText('By cell')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getByText('Top requests')).toBeInTheDocument();
    expect(screen.getByText('A request')).toBeInTheDocument();
  });

  it('shows unknown instead of zero when no turn is priced', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      totals: { ...base.totals, costUsd: null, unknownCostTurns: 2 },
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
    expect(screen.getByText(/1 unpriced turn/)).toBeInTheDocument();
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
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(0%\)/)).not.toBeInTheDocument();
  });

  it('refetches with hour buckets when the range changes', async () => {
    const fetchMock = installFetch();
    render(<UsagePage onError={vi.fn()} />);
    await screen.findByText('Known cost');

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
    await screen.findByText('Known cost');

    fireEvent.change(screen.getByLabelText('Filter usage by cell'), {
      target: { value: 'cell-1' },
    });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('cellId=cell-1'))).toBe(true);
    });
  });
});
