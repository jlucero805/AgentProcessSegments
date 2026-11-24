import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetBanner } from './BudgetBanner';
import type {
  BudgetAlert,
  BudgetStatus,
  BudgetsResponse,
  SpendCapOverride,
  SpendPause,
} from './types';

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

function pause(overrides: Partial<SpendPause> = {}): SpendPause {
  return {
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
    ...overrides,
  };
}

function status(overrides: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    scope: 'overall',
    cellId: null,
    cellName: null,
    label: 'Overall',
    periodStart,
    periodEnd,
    budgetUsd: 100,
    spendUsd: 100,
    remainingUsd: 0,
    percentUsed: 100,
    pricedTurns: 3,
    unknownCostTurns: 0,
    spendIsLowerBound: false,
    state: 'exceeded',
    pauseOnExceeded: true,
    capSpendUsd: 100,
    capSpendIsLowerBound: false,
    unpricedTurns: 0,
    paused: true,
    overrideId: null,
    overrideExpiresAt: null,
    ...overrides,
  };
}

function override(overrides: Partial<SpendCapOverride> = {}): SpendCapOverride {
  return {
    id: 'o1',
    scope: 'overall',
    cellId: null,
    cellName: null,
    periodStart,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: periodEnd - 1,
    note: null,
    revokedAt: null,
    ...overrides,
  };
}

function response(
  alerts: BudgetAlert[],
  pauses: SpendPause[] = [],
  statuses: BudgetStatus[] = [],
  overrides: SpendCapOverride[] = [],
): BudgetsResponse {
  return {
    periodStart,
    periodEnd,
    alertAtPercent: 80,
    statuses,
    alerts,
    pauses,
    overrides,
  };
}

function renderBanner(budgets: BudgetsResponse | null) {
  const onAck = vi.fn();
  const onSnooze = vi.fn();
  const onRevoke = vi.fn();
  const view = render(
    <BudgetBanner
      budgets={budgets}
      onAck={onAck}
      onSnooze={onSnooze}
      onRevoke={onRevoke}
    />,
  );
  return { ...view, onAck, onSnooze, onRevoke };
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
    renderBanner(response([], [pause()], [status()]));

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('hard cap reached');
    expect(notice).toHaveTextContent('New work is paused');
    expect(
      screen.queryByRole('button', { name: /Dismiss budget alert/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Snooze overall spend' }),
    ).toBeInTheDocument();
  });

  it('snoozes a pause through the shared control', () => {
    const { onSnooze } = renderBanner(response([], [pause()], [status()]));

    fireEvent.click(screen.getByRole('button', { name: 'Snooze overall spend' }));

    expect(onSnooze).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'overall' }),
      60,
    );
  });

  it('shows an active override and ends it early', () => {
    const { onRevoke } = renderBanner(
      response(
        [],
        [pause()],
        [status({ overrideId: 'o1', overrideExpiresAt: periodEnd - 1 })],
        [override()],
      ),
    );

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('New work is allowed');
    expect(notice).toHaveTextContent('Override active until');

    fireEvent.click(screen.getByRole('button', { name: 'End override for overall spend' }));
    expect(onRevoke).toHaveBeenCalledWith('o1');
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
