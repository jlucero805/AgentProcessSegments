import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetBanner } from './BudgetBanner';
import { jsonResponse } from './test/fixtures';
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
    usageAvailable: true,
    statuses: [],
    alerts,
    pauses,
  };
}

function installFetch(alerts: BudgetAlert[], pauses: SpendPause[] = []): { acked: string[] } {
  const acked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/budgets') return jsonResponse(response(alerts, pauses));
      if (url.endsWith('/ack') && init?.method === 'POST') {
        const id = decodeURIComponent(url.split('/')[4] ?? '');
        acked.push(id);
        const found = alerts.find((item) => item.id === id);
        return jsonResponse({ ...found, acknowledgedAt: 99 });
      }
      return jsonResponse([]);
    }),
  );
  return { acked };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BudgetBanner', () => {
  it('renders nothing when there are no alerts', async () => {
    installFetch([]);
    const { container } = render(<BudgetBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows exceeded before warning and explains lower-bound spend', async () => {
    installFetch([
      alert({ id: 'w1', threshold: 'warning', spendUsd: 85, unknownCostTurns: 1 }),
      alert({
        id: 'e1',
        threshold: 'exceeded',
        spendUsd: 120,
        budgetUsd: 100,
        unknownCostTurns: 0,
      }),
    ]);
    render(<BudgetBanner />);

    const exceeded = await screen.findByRole('alert');
    expect(exceeded).toHaveTextContent(
      'Overall spend is over its $100.00 monthly budget ($120.00).',
    );
    const warning = screen.getByRole('status');
    expect(warning).toHaveTextContent('at least $85.00');
    expect(warning).toHaveTextContent('1 unpriced turn');
    expect(exceeded.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a non-dismissible pause even when no alert is unacknowledged', async () => {
    installFetch([], [
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
    ]);
    render(<BudgetBanner />);

    const pause = await screen.findByRole('alert');
    expect(pause).toHaveTextContent('hard cap reached');
    expect(pause).toHaveTextContent('New work is paused');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('acknowledges and removes an alert', async () => {
    const { acked } = installFetch([alert()]);
    render(<BudgetBanner />);

    const dismiss = await screen.findByRole('button', {
      name: 'Dismiss budget alert for overall spend',
    });
    fireEvent.click(dismiss);

    await waitFor(() => expect(acked).toEqual(['a1']));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('clears its polling interval on unmount', async () => {
    installFetch([]);
    const clear = vi.spyOn(window, 'clearInterval');
    const { unmount } = render(<BudgetBanner />);
    unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
