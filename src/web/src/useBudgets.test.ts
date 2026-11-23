import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from './test/fixtures';
import type { BudgetAlert, BudgetsResponse } from './types';
import { useBudgets } from './useBudgets';

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

function payload(overrides: Partial<BudgetsResponse> = {}): BudgetsResponse {
  return {
    periodStart,
    periodEnd,
    alertAtPercent: 80,
    usageAvailable: true,
    statuses: [],
    alerts: [],
    pauses: [],
    ...overrides,
  };
}

function stubBudgets(body: () => unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body()));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useBudgets', () => {
  it('loads once and normalizes missing alert and pause lists', async () => {
    const fetchMock = stubBudgets(() => ({
      periodStart,
      periodEnd,
      alertAtPercent: 80,
      usageAvailable: true,
      statuses: [],
    }));
    const onError = vi.fn();
    const { result } = renderHook(() => useBudgets(onError));

    await waitFor(() => expect(result.current.budgets).not.toBeNull());
    expect(result.current.budgets?.alerts).toEqual([]);
    expect(result.current.budgets?.pauses).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a malformed payload as an error instead of an empty configuration', async () => {
    stubBudgets(() => ({ usageAvailable: true }));
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatch(/malformed/i);
    expect(result.current.budgets).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps the last good payload when a refresh fails', async () => {
    const fetchMock = stubBudgets(() => payload({ alerts: [alert()] }));
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1));
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe('offline');
    expect(result.current.budgets?.alerts).toHaveLength(1);
  });

  it('shares one request between concurrent refreshes', async () => {
    const fetchMock = stubBudgets(() => payload());
    const { result } = renderHook(() => useBudgets(vi.fn()));
    await waitFor(() => expect(result.current.budgets).not.toBeNull());

    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.refresh();
      second = result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      release(jsonResponse(payload()));
      await Promise.all([first, second]);
    });
  });

  it('picks up a new alert on the next poll', async () => {
    let alerts: BudgetAlert[] = [];
    stubBudgets(() => payload({ alerts }));
    const { result } = renderHook(() => useBudgets(vi.fn(), 20));

    await waitFor(() => expect(result.current.budgets).not.toBeNull());
    expect(result.current.budgets?.alerts).toHaveLength(0);

    alerts = [alert()];
    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1));
  });

  it('removes an acknowledged alert and ignores a stale poll that still has it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/ack')) return jsonResponse({ ...alert(), acknowledgedAt: 99 });
      return jsonResponse(payload({ alerts: [alert()] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1));
    await act(async () => {
      await result.current.acknowledge(alert());
    });
    expect(result.current.budgets?.alerts).toHaveLength(0);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.budgets?.alerts).toHaveLength(0);
  });

  it('keeps an alert and reports the error when acknowledgement fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/ack')) return jsonResponse({ error: 'ack failed' }, 500);
      return jsonResponse(payload({ alerts: [alert()] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const { result } = renderHook(() => useBudgets(onError));

    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1));
    await act(async () => {
      await result.current.acknowledge(alert());
    });

    expect(onError).toHaveBeenCalledWith('ack failed');
    expect(result.current.budgets?.alerts).toHaveLength(1);
  });

  it('clears its polling interval on unmount', () => {
    stubBudgets(() => payload());
    const clear = vi.spyOn(window, 'clearInterval');
    const { unmount } = renderHook(() => useBudgets(vi.fn()));
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
