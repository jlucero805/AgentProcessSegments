import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetBanner } from './BudgetBanner';
import type { BudgetAlert, BudgetsResponse, SpendPause } from './types';

const periodStart = Date.UTC(2026, 10, 1);
const periodEnd = Date.UTC(2026, 11, 1);

function alert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    id: 'a1',
    scope: 'overall',
    cellId: null,
    cellName: null,
    threshold: 'warning',
    alertAtPercent: 80,
    budgetUsd: 100,
    spendUsd: 85,
    unknownCostTurns: 1,
    periodStart,
    createdAt: 10,
    acknowledgedAt: null,
    ...overrides,
  };
}

function response(alerts: BudgetAlert[], pauses: SpendPause[] = []): BudgetsResponse {
  return {
    periodStart,
    periodEnd,
    alertAtPercent: 80,
    statuses: [],
    alerts,
    pauses,
  };
}

function renderBanner(budgets: BudgetsResponse | null) {
  const onAck = vi.fn();
  const view = render(<BudgetBanner budgets={budgets} onAck={onAck} />);
  return { ...view, onAck };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BudgetBanner', () => {
  it('renders nothing before the budget feed or without alerts and pauses', () => {
    const { container } = renderBanner(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is nothing to report', () => {
    const { container } = renderBanner(response([]));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows exceeded before warning and explains lower-bound spend', () => {
    renderBanner(
      response([
        alert({ id: 'w1', threshold: 'warning', spendUsd: 85, unknownCostTurns: 1 }),
        alert({
          id: 'e1',
          threshold: 'exceeded',
          spendUsd: 120,
          budgetUsd: 100,
          unknownCostTurns: 0,
        }),
      ]),
    );

    const exceeded = screen.getByRole('alert');
    expect(exceeded).toHaveTextContent(
      'Overall spend is over its $100.00 monthly budget ($120.00).',
    );
    const warning = screen.getByRole('status');
    expect(warning).toHaveTextContent('at least $85.00');
    expect(warning).toHaveTextContent('1 unpriced turn');
    expect(exceeded.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a non-dismissible pause even when no alert is unacknowledged', () => {
    renderBanner(
      response(
        [],
        [
          {
            scope: 'overall',
            cellId: null,
            cellName: null,
            label: 'Overall',
            periodStart,
            periodEnd,
            budgetUsd: 100,
            spendUsd: 100,
            spendIsLowerBound: false,
            unpricedTurns: 0,
            percentUsed: 100,
          },
        ],
      ),
    );

    const pause = screen.getByRole('alert');
    expect(pause).toHaveTextContent('hard cap reached');
    expect(pause).toHaveTextContent('New work is paused');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('dismisses through the shared feed without fetching', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { onAck } = renderBanner(response([alert()]));

    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss budget alert for overall spend' }),
    );

    expect(onAck).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
