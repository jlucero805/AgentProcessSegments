import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Board } from './Board';
import { fakeDataTransfer, jsonResponse, makeRequest, ndjsonResponse } from './test/fixtures';
import type { Request } from './types';

function installFetch(store: Request[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    if (url.endsWith('/transition')) return jsonResponse(store[0]);
    if (url.endsWith('/dispatch')) return ndjsonResponse(['{"t":"done","request":null,"transcript":[]}\n']);
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
    fireEvent.click(await screen.findByText('Groom this'));

    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('transitions a card when it is dropped on another column', async () => {
    const fetchMock = installFetch([makeRequest({ id: 'b', title: 'Build that', clarifyStarted: true })]);

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
});
