import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Board } from './Board';
import { fakeDataTransfer, jsonResponse, makeRequest } from './test/fixtures';
import type { IndexAllResult, Request } from './types';

// The board transitions cards and runs the Index all confirm flow. Give the slow
// async cases room under full-suite load while keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;
const BOARD_TEST_TIMEOUT_MS = 30_000;

type IndexAllHandler = (body: Record<string, unknown>) => Response | Promise<Response>;

function parseBody(init?: RequestInit): Record<string, unknown> {
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

function installFetch(store: Request[], indexAllHandler?: IndexAllHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/requests?view=intake') {
      return jsonResponse(store.filter((r) => r.state === 'clarify' && !r.clarifyStarted));
    }
    if (url === '/api/requests?state=clarify') {
      return jsonResponse(store.filter((r) => r.state === 'clarify'));
    }
    if (url === '/api/requests?state=dispatch') {
      return jsonResponse(store.filter((r) => r.state === 'dispatch'));
    }
    if (url === '/api/requests?state=review') {
      return jsonResponse(store.filter((r) => r.state === 'review'));
    }
    if (url === '/api/requests?state=finalize') {
      return jsonResponse(store.filter((r) => r.state === 'finalize'));
    }
    if (url === '/api/requests/index-all') {
      const body = parseBody(init);
      if (indexAllHandler) return indexAllHandler(body);
      const affected = store.filter(
        (request) =>
          request.state === 'finalize' && (!body['cellId'] || request.cellId === body['cellId']),
      );
      for (const request of affected) request.state = 'done';
      const result: IndexAllResult = {
        indexed: affected.length,
        closed: affected.length,
        skipped: [],
        failed: [],
      };
      return jsonResponse(result);
    }
    if (url.endsWith('/transition')) return jsonResponse(store[0]);
    if (url.endsWith('/dispatch?detach=1')) return jsonResponse({ started: true });
    if (url.endsWith('/finalize?detach=1')) return jsonResponse({ started: true });
    if (url.endsWith('/clarify/start?detach=1')) return jsonResponse({ started: true });
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Board', () => {
  it('renders intake and started clarify requests in their own columns', async () => {
    installFetch([
      makeRequest({ id: 'a', title: 'Groom this' }),
      makeRequest({ id: 'b', title: 'Build that', clarifyStarted: true }),
    ]);

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);

    expect(await screen.findByText('Groom this')).toBeInTheDocument();
    expect(screen.getByText('Build that')).toBeInTheDocument();
    expect(screen.getByTestId('column-intake')).toHaveTextContent('Groom this');
    expect(screen.getByTestId('column-clarify')).toHaveTextContent('Build that');
    expect(screen.getByTestId('column-intake')).not.toHaveTextContent('Build that');
  });

  it('filters by cell', async () => {
    installFetch([
      makeRequest({ id: 'a', title: 'Cell A card', cellId: 'c1' }),
      makeRequest({ id: 'b', title: 'Cell B card', cellId: 'c2' }),
    ]);

    render(<Board cellId="c1" onOpen={() => {}} onError={() => {}} />);

    expect(await screen.findByText('Cell A card')).toBeInTheDocument();
    expect(screen.queryByText('Cell B card')).not.toBeInTheDocument();
  });

  it('opens the drawer when a card is clicked', async () => {
    installFetch([makeRequest({ id: 'a', title: 'Groom this' })]);
    const onOpen = vi.fn();

    render(<Board cellId={null} onOpen={onOpen} onError={() => {}} />);
    const card = await screen.findByText('Groom this');
    expect(screen.getByTestId('request-card')).toHaveAttribute('data-request-id', 'a');
    fireEvent.click(card);

    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('transitions a card when it is dropped on another column', async () => {
    const fetchMock = installFetch([
      makeRequest({ id: 'b', title: 'Build that', state: 'dispatch', clarifyStarted: true }),
    ]);

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    const card = (await screen.findByText('Build that')).closest('button');
    expect(card).not.toBeNull();

    const transfer = fakeDataTransfer();
    fireEvent.dragStart(card as HTMLElement, { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId('column-review'), { dataTransfer: transfer });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/transition'));
      expect(call).toBeTruthy();
    });

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/transition'));
    if (!call) throw new Error('expected a transition call');
    const init = call[1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ to: 'review' }));
  });

  it('starts a dispatch turn without waiting for the stream', async () => {
    const fetchMock = installFetch([
      makeRequest({ id: 'c', title: 'Kick off', clarifyStarted: true }),
    ]);

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    const card = (await screen.findByText('Kick off')).closest('button');
    expect(card).not.toBeNull();

    const transfer = fakeDataTransfer();
    fireEvent.dragStart(card as HTMLElement, { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId('column-dispatch'), { dataTransfer: transfer });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/dispatch?detach=1')),
      ).toBe(true);
    });
  });

  it('refuses an illegal workflow jump before calling the API', async () => {
    const fetchMock = installFetch([
      makeRequest({ id: 'd', title: 'No shortcuts', clarifyStarted: true }),
    ]);
    const onError = vi.fn();

    render(<Board cellId={null} onOpen={() => {}} onError={onError} />);
    const card = (await screen.findByText('No shortcuts')).closest('button');
    expect(card).not.toBeNull();

    const transfer = fakeDataTransfer();
    fireEvent.dragStart(card as HTMLElement, { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId('column-finalize'), { dataTransfer: transfer });

    expect(onError).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/finalize'))).toBe(false);
  });

  it('shows Index all only in Finalize and requires a second click', async () => {
    const fetchMock = installFetch([
      makeRequest({ id: 'f', title: 'Final card', state: 'finalize', digest: 'Keep this' }),
    ]);

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    await screen.findByText('Final card', undefined, { timeout: ASYNC_TIMEOUT_MS });
    const finalize = screen.getByTestId('column-finalize');
    const button = within(finalize).getByRole('button', {
      name: 'Index all finalize requests',
    });
    expect(button).toHaveTextContent('Index all');
    expect(
      within(screen.getByTestId('column-review')).queryByRole('button', { name: /index all/i }),
    ).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveTextContent('Confirm index all?');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/index-all'))).toBe(false);

    fireEvent.click(button);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/index-all'))).toBe(true);
    }, { timeout: ASYNC_TIMEOUT_MS });

    expect(await screen.findByRole('status', undefined, { timeout: ASYNC_TIMEOUT_MS })).toHaveTextContent('Indexed 1');
    expect(screen.getByRole('status')).toHaveTextContent('closed 1');
    await waitFor(() => expect(screen.queryByText('Final card')).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS });
  }, BOARD_TEST_TIMEOUT_MS);

  it('sends the selected cell with Index all', async () => {
    const fetchMock = installFetch([
      makeRequest({ id: 'f', title: 'Cell final', state: 'finalize', cellId: 'c1', digest: 'Keep' }),
    ]);

    render(<Board cellId="c1" onOpen={() => {}} onError={() => {}} />);
    await screen.findByText('Cell final', undefined, { timeout: ASYNC_TIMEOUT_MS });
    const button = within(screen.getByTestId('column-finalize')).getByRole('button', {
      name: 'Index all finalize requests',
    });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/index-all'));
      expect(call).toBeTruthy();
      expect(parseBody(call?.[1])).toEqual({ cellId: 'c1' });
    }, { timeout: ASYNC_TIMEOUT_MS });
  }, BOARD_TEST_TIMEOUT_MS);

  it('sends an empty body with Index all for all cells', async () => {
    const fetchMock = installFetch([
      makeRequest({ id: 'f', title: 'Cell final', state: 'finalize', cellId: 'c1', digest: 'Keep' }),
    ]);

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    await screen.findByText('Cell final');
    const button = within(screen.getByTestId('column-finalize')).getByRole('button', {
      name: 'Index all finalize requests',
    });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/index-all'));
      expect(call).toBeTruthy();
      expect(parseBody(call?.[1])).toEqual({});
    });
  });

  it('resets the Index all confirmation after four seconds', async () => {
    installFetch([
      makeRequest({ id: 'f', title: 'Final card', state: 'finalize', digest: 'Keep' }),
    ]);

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    await screen.findByText('Final card', undefined, { timeout: ASYNC_TIMEOUT_MS });
    const button = within(screen.getByTestId('column-finalize')).getByRole('button', {
      name: 'Index all finalize requests',
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(button);
      expect(button).toHaveTextContent('Confirm index all?');
      act(() => vi.advanceTimersByTime(4000));
      expect(button).toHaveTextContent('Index all');
    } finally {
      vi.useRealTimers();
    }
  }, BOARD_TEST_TIMEOUT_MS);

  it('disables Index all when Finalize is empty', async () => {
    installFetch([makeRequest({ id: 'a', title: 'Groom this' })]);

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    await screen.findByText('Groom this');
    const button = within(screen.getByTestId('column-finalize')).getByRole('button', {
      name: 'Index all finalize requests',
    });
    expect(button).toBeDisabled();
  });

  it('shows skipped requests in the Index all notice', async () => {
    installFetch(
      [makeRequest({ id: 'f', title: 'Final card', state: 'finalize', digest: 'Keep' })],
      () =>
        jsonResponse({
          indexed: 1,
          closed: 1,
          skipped: [{ id: 'other', title: 'Needs digest', reason: 'no_digest' }],
          failed: [],
        }),
    );

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    await screen.findByText('Final card');
    const button = within(screen.getByTestId('column-finalize')).getByRole('button', {
      name: 'Index all finalize requests',
    });
    fireEvent.click(button);
    fireEvent.click(button);

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('1 skipped (no digest)');
    expect(notice).toHaveAttribute('title', expect.stringContaining('Needs digest: no digest'));
  });

  it('shows a busy label while Index all runs', async () => {
    let resolveRequest!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    installFetch(
      [makeRequest({ id: 'f', title: 'Final card', state: 'finalize', digest: 'Keep' })],
      () => pending,
    );

    render(<Board cellId={null} onOpen={() => {}} onError={() => {}} />);
    await screen.findByText('Final card', undefined, { timeout: ASYNC_TIMEOUT_MS });
    const button = within(screen.getByTestId('column-finalize')).getByRole('button', {
      name: 'Index all finalize requests',
    });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByText('Indexing…', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(button).toBeDisabled();

    act(() =>
      resolveRequest(
        jsonResponse({ indexed: 0, closed: 0, skipped: [], failed: [] }),
      ),
    );
    await waitFor(() => expect(button).toHaveTextContent('Index all'), { timeout: ASYNC_TIMEOUT_MS });
  }, BOARD_TEST_TIMEOUT_MS);

  it('surfaces an Index all failure and clears busy', async () => {
    const onError = vi.fn();
    installFetch(
      [makeRequest({ id: 'f', title: 'Final card', state: 'finalize', digest: 'Keep' })],
      () => {
        throw new Error('bulk failed');
      },
    );

    render(<Board cellId={null} onOpen={() => {}} onError={onError} />);
    await screen.findByText('Final card', undefined, { timeout: ASYNC_TIMEOUT_MS });
    const button = within(screen.getByTestId('column-finalize')).getByRole('button', {
      name: 'Index all finalize requests',
    });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(onError).toHaveBeenCalledWith('bulk failed'), { timeout: ASYNC_TIMEOUT_MS });
    expect(button).toHaveTextContent('Index all');
    expect(button).toBeEnabled();
  }, BOARD_TEST_TIMEOUT_MS);
});
