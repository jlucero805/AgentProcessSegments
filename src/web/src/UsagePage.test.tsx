import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from './UsagePage';
import { jsonResponse, makeUsageResponse } from './test/fixtures';
import type { BudgetAlert, BudgetsResponse, CellDetail } from './types';
import type { BudgetFeed } from './useBudgets';

// The page loads usage and budgets before rendering. Give its slow async cases room
// under full-suite load while keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;
const USAGE_TEST_TIMEOUT_MS = 30_000;

const CELLS = [
  {
    id: 'cell-1',
    name: 'Alpha',
    masterEnabled: true,
    masterIntervalMinutes: null,
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
  },
] satisfies CellDetail[];

const BUDGETS: BudgetsResponse = {
  periodStart: Date.UTC(2026, 10, 1),
  periodEnd: Date.UTC(2026, 11, 1),
  alertAtPercent: 80,
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
      pauseOnUnknownCost: false,
      capSpendUsd: 85,
      capSpendIsLowerBound: true,
      unpricedTurns: 0,
      paused: false,
      pauseReason: null,
      overrideId: null,
      overrideExpiresAt: null,
    },
  ],
  alerts: [],
  pauses: [],
  overrides: [],
};

const ALERT: BudgetAlert = {
  id: 'a1',
  scope: 'overall',
  cellId: null,
  cellName: null,
  threshold: 'warning',
  alertAtPercent: 80,
  budgetUsd: 100,
  spendUsd: 85,
  unknownCostTurns: 1,
  periodStart: Date.UTC(2026, 10, 1),
  createdAt: 10,
  acknowledgedAt: null,
};

function makeFeed(overrides: Partial<BudgetFeed> = {}): BudgetFeed {
  return {
    budgets: BUDGETS,
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    reload: vi.fn(async () => null),
    acknowledge: vi.fn(async () => {}),
    snooze: vi.fn(async () => {}),
    revokeOverride: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderUsage(
  overrides: Partial<BudgetFeed> = {},
  onError = vi.fn(),
  cells: CellDetail[] = CELLS,
) {
  const budgetFeed = makeFeed(overrides);
  const view = render(<UsagePage cells={cells} onError={onError} budgetFeed={budgetFeed} />);
  return { ...view, budgetFeed, onError };
}

function installFetch(response = makeUsageResponse()) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
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
    renderUsage();

    expect(await screen.findByText('Effective cost', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
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
    expect(screen.getByText('By cell and process segment')).toBeInTheDocument();
    expect(screen.getByText('Implement')).toBeInTheDocument();
    expect(screen.getByText('1h 0m')).toBeInTheDocument();
    expect(screen.getByText('10m')).toBeInTheDocument();
    expect(screen.getAllByTitle(/estimated/).length).toBeGreaterThan(0);
  }, USAGE_TEST_TIMEOUT_MS);

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
    renderUsage();

    expect(await screen.findAllByText('unknown')).not.toHaveLength(0);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('shows current-month budget progress and lower-bound copy', async () => {
    installFetch();
    renderUsage();

    expect(await screen.findByText('Monthly budgets')).toBeInTheDocument();
    expect(screen.getByText(/warning at 80%/)).toBeInTheDocument();
    expect(screen.getByText(/At least \$85\.00 of \$100\.00/)).toBeInTheDocument();
  });

  it('marks a paused scope and explains the cap spend', async () => {
    installFetch();
    const { budgetFeed } = renderUsage({
      budgets: {
        ...BUDGETS,
        statuses: [
          {
            ...BUDGETS.statuses[0]!,
            paused: true,
            pauseReason: 'cap_reached',
            capSpendUsd: 100,
          },
        ],
        pauses: [
          {
            scope: 'overall',
            cellId: null,
            cellName: null,
            label: 'Overall',
            reason: 'cap_reached',
            periodStart: Date.UTC(2026, 10, 1),
            periodEnd: Date.UTC(2026, 11, 1),
            budgetUsd: 100,
            spendUsd: 100,
            spendIsLowerBound: false,
            unpricedTurns: 0,
            percentUsed: 100,
          },
        ],
      },
    });

    expect(await screen.findByText('paused', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText(/in-flight turns were stopped at \$100\.00 cap spend/)).toBeInTheDocument();
    expect(screen.queryByText(/budgets never stop work/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Snooze overall spend' }));
    expect(budgetFeed.snooze).toHaveBeenCalledWith({ scope: 'overall', minutes: 60 });
  }, USAGE_TEST_TIMEOUT_MS);

  it('shows an active override and can end it from the budget card', async () => {
    installFetch();
    const overrideExpiresAt = Date.UTC(2026, 10, 15, 13);
    const { budgetFeed } = renderUsage({
      budgets: {
        ...BUDGETS,
        statuses: [
          {
            ...BUDGETS.statuses[0]!,
            paused: true,
            capSpendUsd: 100,
            overrideId: 'o1',
            overrideExpiresAt,
          },
        ],
        overrides: [
          {
            id: 'o1',
            scope: 'overall',
            cellId: null,
            cellName: null,
            periodStart: Date.UTC(2026, 10, 1),
            createdAt: Date.UTC(2026, 10, 15, 12),
            updatedAt: Date.UTC(2026, 10, 15, 12),
            expiresAt: overrideExpiresAt,
            note: null,
            revokedAt: null,
          },
        ],
      },
    });

    expect(await screen.findByText('snoozed')).toBeInTheDocument();
    expect(await screen.findByText(/Override active until/)).toBeInTheDocument();
    expect(
      screen.getByText(/Cap reached; an override is admitting new work until/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/in-flight turns were stopped/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'End override for overall spend' }),
    );
    expect(budgetFeed.revokeOverride).toHaveBeenCalledWith('o1');
  });

  it('explains a strict unknown-cost pause that an override is admitting', async () => {
    installFetch();
    renderUsage({
      budgets: {
        ...BUDGETS,
        statuses: [
          {
            ...BUDGETS.statuses[0]!,
            state: 'unknown',
            pauseOnUnknownCost: true,
            paused: true,
            pauseReason: 'unknown_cost',
            unpricedTurns: 2,
            unknownCostTurns: 2,
            overrideId: 'o1',
            overrideExpiresAt: Date.UTC(2026, 10, 15, 13),
          },
        ],
        overrides: [
          {
            id: 'o1',
            scope: 'overall',
            cellId: null,
            cellName: null,
            periodStart: Date.UTC(2026, 10, 1),
            createdAt: Date.UTC(2026, 10, 15, 12),
            updatedAt: Date.UTC(2026, 10, 15, 12),
            expiresAt: Date.UTC(2026, 10, 15, 13),
            note: null,
            revokedAt: null,
          },
        ],
      },
    });

    expect(await screen.findByText('snoozed')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Cost is unknown: 2 unpriced turns, so cost cannot be verified; an override is admitting new work until/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/New work is refused and in-flight turns were stopped/)).not.toBeInTheDocument();
  });

  it('explains a strict unknown-cost pause in the unknown state', async () => {
    installFetch();
    renderUsage({
      budgets: {
        ...BUDGETS,
        statuses: [
          {
            ...BUDGETS.statuses[0]!,
            state: 'unknown',
            pauseOnUnknownCost: true,
            paused: true,
            pauseReason: 'unknown_cost',
            unpricedTurns: 2,
            unknownCostTurns: 2,
            capSpendIsLowerBound: true,
          },
        ],
        pauses: [
          {
            scope: 'overall',
            cellId: null,
            cellName: null,
            label: 'Overall',
            reason: 'unknown_cost',
            periodStart: Date.UTC(2026, 10, 1),
            periodEnd: Date.UTC(2026, 11, 1),
            budgetUsd: 100,
            spendUsd: 5,
            spendIsLowerBound: true,
            unpricedTurns: 2,
            percentUsed: 5,
          },
        ],
      },
    });

    expect(await screen.findByText(/Spend unknown/)).toBeInTheDocument();
    expect(
      screen.getByText(/Paused: 2 unpriced turns, so cost cannot be verified/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/strict caps pause while any turn is unpriced/i)).toBeInTheDocument();
  });

  it('does not show an all-unpriced budget as zero', async () => {
    installFetch();
    renderUsage({
      budgets: {
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
      },
    });

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
    renderUsage();

    expect(await screen.findAllByText('≥ $0.0120 · 1 unpriced')).not.toHaveLength(0);
    expect(screen.getByText('Unpriced turns')).toBeInTheDocument();
  });

  it('shows the retained raw window from the usage payload', async () => {
    const fetchMock = installFetch();
    renderUsage();

    expect(
      await screen.findByText(
        'Raw usage is kept for 90 days; older turns are pruned. All-time totals cover the retained window.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Retention last ran/)).not.toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url === '/api/config')).toBe(false);
  });

  it('shows when retention last ran and how many rows it pruned', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      coverage: {
        rolledThrough: null,
        retentionDays: 90,
        lastPrune: { ranAt: Date.UTC(2026, 0, 2, 3, 4), deletedRows: 1204 },
      },
    });
    renderUsage();

    expect(await screen.findByText(/Raw usage is kept for 90 days/)).toBeInTheDocument();
    expect(
      screen.getByText(/Retention last ran .+ UTC and pruned 1,204 rows\./),
    ).toBeInTheDocument();
  });

  it('uses the singular row label for one pruned row', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      coverage: {
        rolledThrough: null,
        retentionDays: 90,
        lastPrune: { ranAt: Date.UTC(2026, 0, 2, 3, 4), deletedRows: 1 },
      },
    });
    renderUsage();

    expect(await screen.findByText(/and pruned 1 row\./)).toBeInTheDocument();
    expect(screen.queryByText(/and pruned 1 rows\./)).not.toBeInTheDocument();
  });

  it('reports a pass that pruned nothing', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      coverage: {
        rolledThrough: null,
        retentionDays: 90,
        lastPrune: { ranAt: Date.UTC(2026, 0, 2, 3, 4), deletedRows: 0 },
      },
    });
    renderUsage();

    expect(await screen.findByText(/and pruned 0 rows\./)).toBeInTheDocument();
  });

  it('hides the run evidence when retention is disabled', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      coverage: {
        rolledThrough: null,
        retentionDays: 0,
        lastPrune: { ranAt: Date.UTC(2026, 0, 2, 3, 4), deletedRows: 12 },
      },
    });
    renderUsage();

    expect(await screen.findByText('Usage history is kept indefinitely.')).toBeInTheDocument();
    expect(screen.queryByText(/Retention last ran/)).not.toBeInTheDocument();
  });

  it('shows daily rollup coverage and finite retention', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      coverage: { rolledThrough: Date.UTC(2026, 0, 1), retentionDays: 90, lastPrune: null },
    });
    renderUsage();

    expect(await screen.findByText(/Daily totals preserve history before/)).toBeInTheDocument();
    expect(screen.getByText(/Raw retention is 90 days\./)).toBeInTheDocument();
  });

  it('shows daily rollup coverage and indefinite retention', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      coverage: { rolledThrough: Date.UTC(2026, 0, 1), retentionDays: 0, lastPrune: null },
    });
    renderUsage();

    expect(await screen.findByText(/Daily totals preserve history before/)).toBeInTheDocument();
    expect(screen.getByText(/kept indefinitely/)).toBeInTheDocument();
  });

  it('keeps usage and coverage readable without any config request', async () => {
    const base = makeUsageResponse();
    const fetchMock = installFetch({
      ...base,
      coverage: { rolledThrough: Date.UTC(2026, 0, 1), retentionDays: 0, lastPrune: null },
    });
    renderUsage();

    expect(await screen.findByText('Effective cost')).toBeInTheDocument();
    expect(screen.getByText(/Daily totals preserve history before/)).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url === '/api/config')).toBe(false);
  });

  it('says history is kept indefinitely when retention is disabled', async () => {
    installFetch({
      ...makeUsageResponse(),
      coverage: { rolledThrough: null, retentionDays: 0, lastPrune: null },
    });
    renderUsage();

    expect(await screen.findByText('Usage history is kept indefinitely.')).toBeInTheDocument();
  });

  it('refetches with hour buckets when the range changes', async () => {
    const fetchMock = installFetch();
    renderUsage();
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
    renderUsage();
    await screen.findByText('Effective cost');

    fireEvent.change(screen.getByLabelText('Filter usage by cell'), {
      target: { value: 'cell-1' },
    });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('cellId=cell-1'))).toBe(true);
    });
  });

  it('does not fetch budgets itself', async () => {
    const fetchMock = installFetch();
    renderUsage();
    await screen.findByText('Monthly budgets');

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url === '/api/budgets')).toBe(false);
  });

  it('shows a retryable failure instead of pretending there are no budgets', async () => {
    installFetch();
    const { budgetFeed } = renderUsage({
      budgets: null,
      error: '503 Service Unavailable',
    });

    expect(await screen.findByText('Monthly budgets')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load budgets.");
    expect(screen.getByRole('alert')).toHaveTextContent('503 Service Unavailable');
    expect(screen.queryByText(/No budgets configured/)).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getByText('Effective cost')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(budgetFeed.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good budget status while a refresh is failing', async () => {
    installFetch();
    renderUsage({ error: 'offline' });

    expect(await screen.findByText('Monthly budgets')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      "Couldn't refresh budgets; showing the last successful update.",
    );
    expect(screen.getByText(/At least \$85\.00 of \$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/warning at 80%/)).toBeInTheDocument();
  });

  it('acknowledges an active alert from the budget card', async () => {
    installFetch();
    const { budgetFeed } = renderUsage({
      budgets: { ...BUDGETS, alerts: [ALERT] },
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Dismiss budget alert for overall spend',
      }),
    );

    expect(budgetFeed.acknowledge).toHaveBeenCalledWith(ALERT);
  });

  it('uses the shared cell list instead of fetching its own', async () => {
    const fetchMock = installFetch();
    renderUsage();
    await screen.findByText('Effective cost');

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).not.toContain('/api/cells');
  });

  it('drops a deleted cell from the filter and returns to all cells', async () => {
    const fetchMock = installFetch();
    const { rerender, budgetFeed } = renderUsage();
    await screen.findByText('Effective cost');

    fireEvent.change(screen.getByLabelText('Filter usage by cell'), {
      target: { value: 'cell-1' },
    });
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('cellId=cell-1'))).toBe(true);
    });

    const callsBeforeDelete = fetchMock.mock.calls.length;
    rerender(
      <UsagePage cells={[]} onError={vi.fn()} budgetFeed={budgetFeed} />,
    );

    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Alpha' })).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Filter usage by cell')).toHaveValue('');
    await waitFor(() => {
      const urls = fetchMock.mock.calls
        .slice(callsBeforeDelete)
        .map(([input]) => String(input));
      expect(urls.some((url) => url.includes('/api/usage') && !url.includes('cellId'))).toBe(
        true,
      );
    });
  });

  it('shows a newly created cell without remounting the page', async () => {
    installFetch();
    const { rerender, budgetFeed } = renderUsage();
    await screen.findByText('Effective cost');
    expect(screen.queryByRole('option', { name: 'Beta' })).not.toBeInTheDocument();

    rerender(
      <UsagePage
        cells={[...CELLS, { ...CELLS[0], id: 'cell-2', name: 'Beta' }]}
        onError={vi.fn()}
        budgetFeed={budgetFeed}
      />,
    );

    expect(await screen.findByRole('option', { name: 'Beta' })).toBeInTheDocument();
  });
});
