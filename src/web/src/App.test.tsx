import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { jsonResponse, makeRequest } from './test/fixtures';
import type { Request } from './types';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function installFetch(request: Request, transcript: unknown[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/cells') return jsonResponse([]);
    if (url === '/api/commands') return jsonResponse([]);
    if (url === '/api/models') {
      return jsonResponse({
        models: [],
        source: 'fallback',
        effortLevels: EFFORTS,
        harness: 'opencode',
        supportsEffort: false,
      });
    }
    if (url === `/api/requests/${request.id}`) return jsonResponse(request);
    if (url === `/api/requests/${request.id}/clarify`) {
      return jsonResponse({ started: request.clarifyStarted, transcript });
    }
    if (url === `/api/requests/${request.id}/clarify/stream`) {
      return jsonResponse({ active: false });
    }
    if (url === `/api/requests/${request.id}/seen`) return jsonResponse(request);
    if (url === '/api/requests?view=intake') {
      return jsonResponse(
        request.state === 'clarify' && !request.clarifyStarted ? [request] : [],
      );
    }
    if (url === '/api/requests?state=clarify') {
      return jsonResponse(request.state === 'clarify' ? [request] : []);
    }
    if (url.startsWith('/api/requests?state=')) return jsonResponse([]);
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App', () => {
  it('mounts the shell, nav, cells, and board', async () => {
    installFetch(makeRequest({ id: 'a', title: 'Mounted card' }));

    render(<App />);

    expect(screen.getByText('Sandbox Harness')).toBeInTheDocument();
    expect(screen.getByText('Knowledge base')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('All cells')).toBeInTheDocument();
    expect(await screen.findByText('Mounted card')).toBeInTheDocument();
    expect(screen.getByTestId('column-intake')).toHaveTextContent('Mounted card');
  });

  it('opens the detail drawer and mounts the chat for a started request', async () => {
    const request = makeRequest({ id: 'a', title: 'Mounted card', clarifyStarted: true });
    installFetch(request, [
      { role: 'you', kind: 'text', text: 'hello', ts: 1 },
      { role: 'agent', kind: 'text', text: 'hi there', ts: 2 },
    ]);

    render(<App />);
    fireEvent.click(await screen.findByText('Mounted card'));

    expect(await screen.findByText('Finalize digest')).toBeInTheDocument();
    expect(await screen.findByText('hi there')).toBeInTheDocument();
    expect(screen.getByText('Send')).toBeInTheDocument();
    expect(screen.getByText('harness: opencode')).toBeInTheDocument();
    expect(screen.getByText('not used by this harness')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close drawer' })).toBeInTheDocument();
  });
});
