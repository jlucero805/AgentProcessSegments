import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from './test/fixtures';
import type { BudgetAlert, BudgetsResponse } from './types';
import { useBudgets } from './useBudgets';

// The hook polls budgets and resolves asynchronously. Give its waits room under
// full-suite load while keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;

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
    statuses: [],
    alerts: [],
    pauses: [],
    overrides: [],
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
      statuses: [],
    }));
    const onError = vi.fn();
    const { result } = renderHook(() => useBudgets(onError));

    await waitFor(() => expect(result.current.budgets).not.toBeNull(), { timeout: ASYNC_TIMEOUT_MS });
    expect(result.current.budgets?.alerts).toEqual([]);
    expect(result.current.budgets?.pauses).toEqual([]);
    expect(result.current.budgets?.overrides).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a malformed payload as an error instead of an empty configuration', async () => {
    stubBudgets(() => ({}));
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: ASYNC_TIMEOUT_MS });
    expect(result.current.error).toMatch(/malformed/i);
    expect(result.current.budgets).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps the last good payload when a refresh fails', async () => {
    const fetchMock = stubBudgets(() => payload({ alerts: [alert()] }));
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
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
    await waitFor(() => expect(result.current.budgets).not.toBeNull(), { timeout: ASYNC_TIMEOUT_MS });

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

  it('forces a reload past an in-flight refresh and ignores the stale response', async () => {
    let releaseStale!: (response: Response) => void;
    let releaseFresh!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(payload()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseStale = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseFresh = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBudgets(vi.fn()));
    await waitFor(() => expect(result.current.budgets).not.toBeNull(), { timeout: ASYNC_TIMEOUT_MS });

    let stale!: Promise<void>;
    let reloaded!: Promise<BudgetsResponse | null>;
    act(() => {
      stale = result.current.refresh();
      reloaded = result.current.reload();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      releaseStale(jsonResponse(payload({ alerts: [alert({ id: 'stale' })] })));
      await stale;
    });
    expect(result.current.budgets?.alerts).toHaveLength(0);

    await act(async () => {
      releaseFresh(jsonResponse(payload({ alerts: [alert({ id: 'fresh' })] })));
      await reloaded;
    });

    const snapshot = await reloaded;
    expect(snapshot?.alerts.map((item) => item.id)).toEqual(['fresh']);
    expect(result.current.budgets?.alerts.map((item) => item.id)).toEqual(['fresh']);
  });

  it('returns the applied snapshot from reload and null on failure', async () => {
    const fetchMock = stubBudgets(() => payload({ alerts: [alert({ id: 'good' })] }));
    const { result } = renderHook(() => useBudgets(vi.fn()));
    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });

    let reloaded!: Promise<BudgetsResponse | null>;
    await act(async () => {
      reloaded = result.current.reload();
      await reloaded;
    });
    expect((await reloaded)?.alerts.map((item) => item.id)).toEqual(['good']);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    let failedReload!: Promise<BudgetsResponse | null>;
    await act(async () => {
      failedReload = result.current.reload();
      await failedReload;
    });

    expect(await failedReload).toBeNull();
    expect(result.current.error).toBe('offline');
    expect(result.current.budgets?.alerts.map((item) => item.id)).toEqual(['good']);
  });

  it('picks up a new alert on the next poll', async () => {
    let alerts: BudgetAlert[] = [];
    stubBudgets(() => payload({ alerts }));
    const { result } = renderHook(() => useBudgets(vi.fn(), 20));

    await waitFor(() => expect(result.current.budgets).not.toBeNull(), { timeout: ASYNC_TIMEOUT_MS });
    expect(result.current.budgets?.alerts).toHaveLength(0);

    alerts = [alert()];
    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
  });

  it('removes an acknowledged alert and ignores a stale poll that still has it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/ack')) return jsonResponse({ ...alert(), acknowledgedAt: 99 });
      return jsonResponse(payload({ alerts: [alert()] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
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

    await waitFor(() => expect(result.current.budgets?.alerts).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    await act(async () => {
      await result.current.acknowledge(alert());
    });

    expect(onError).toHaveBeenCalledWith('ack failed');
    expect(result.current.budgets?.alerts).toHaveLength(1);
  });

  it('posts an override and reloads the snapshot', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/budgets/overrides' && init?.method === 'POST') {
        return jsonResponse({ override: { id: 'o1' }, created: true }, 201);
      }
      return jsonResponse(payload());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.budgets).not.toBeNull(), { timeout: ASYNC_TIMEOUT_MS });
    await act(async () => {
      await result.current.snooze({ scope: 'overall', minutes: 60 });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/budgets/overrides',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === '/api/budgets'),
    ).toHaveLength(2);
  });

  it('revokes an override and reloads the snapshot', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/budgets/overrides/o1' && init?.method === 'DELETE') {
        return jsonResponse({ override: { id: 'o1', revokedAt: 5 } });
      }
      return jsonResponse(payload());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBudgets(vi.fn()));

    await waitFor(() => expect(result.current.budgets).not.toBeNull(), { timeout: ASYNC_TIMEOUT_MS });
    await act(async () => {
      await result.current.revokeOverride('o1');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/budgets/overrides/o1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === '/api/budgets'),
    ).toHaveLength(2);
  });

  it('clears its polling interval on unmount', () => {
    stubBudgets(() => payload());
    const clear = vi.spyOn(window, 'clearInterval');
    const { unmount } = renderHook(() => useBudgets(vi.fn()));
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
