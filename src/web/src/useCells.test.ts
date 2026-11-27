import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from './test/fixtures';
import type { CellDetail } from './types';
import { useCells } from './useCells';

// The hook loads asynchronously; give its waits room under full-suite load while
// keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;

function makeCell(id: string, name: string): CellDetail {
  return {
    id,
    name,
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
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCells', () => {
  it('loads the shared list once on mount', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([makeCell('c1', 'Alpha')]));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const { result } = renderHook(() => useCells(onError));

    await waitFor(() => expect(result.current.loaded).toBe(true), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(result.current.cells).toHaveLength(1);
    expect(result.current.cells[0]?.name).toBe('Alpha');
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the last good list when a reload fails', async () => {
    let fail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fail
          ? jsonResponse({ error: 'boom', message: 'offline' }, 500)
          : jsonResponse([makeCell('c1', 'Alpha')]),
      ),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useCells(onError));
    await waitFor(() => expect(result.current.loaded).toBe(true), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    fail = true;
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.cells).toHaveLength(1);
    expect(result.current.loaded).toBe(true);
    expect(result.current.error).toBeTruthy();
    expect(onError).toHaveBeenCalled();
  });

  it('discards a response that started before a newer reload', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstGate;
        return jsonResponse([makeCell('c1', 'Old')]);
      })
      .mockImplementationOnce(async () => jsonResponse([makeCell('c2', 'New')]));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCells(vi.fn()));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let reloading!: Promise<void>;
    act(() => {
      reloading = result.current.reload();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    await act(async () => {
      await reloading;
    });
    expect(result.current.cells.map((cell) => cell.name)).toEqual(['New']);

    releaseFirst();
    await act(async () => {});
    expect(result.current.cells.map((cell) => cell.name)).toEqual(['New']);
  });

  it('replaces or appends on upsert and drops on remove', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse([makeCell('c1', 'Alpha')])),
    );
    const { result } = renderHook(() => useCells(vi.fn()));
    await waitFor(() => expect(result.current.loaded).toBe(true), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    act(() => result.current.upsert(makeCell('c1', 'Renamed')));
    expect(result.current.cells).toHaveLength(1);
    expect(result.current.cells[0]?.name).toBe('Renamed');

    act(() => result.current.upsert(makeCell('c2', 'Beta')));
    expect(result.current.cells.map((cell) => cell.id)).toEqual(['c1', 'c2']);

    act(() => result.current.remove('c1'));
    expect(result.current.cells.map((cell) => cell.id)).toEqual(['c2']);
  });

  it('does not report a late failure after unmount', async () => {
    let rejectRequest!: (reason: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectRequest = reject;
          }),
      ),
    );
    const onError = vi.fn();
    const { unmount } = renderHook(() => useCells(onError));
    unmount();

    await act(async () => {
      rejectRequest(new Error('late failure'));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
