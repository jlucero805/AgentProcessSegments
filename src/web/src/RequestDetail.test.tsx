import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestDetail } from './RequestDetail';
import { jsonResponse, makeRequest } from './test/fixtures';
import type { Cell } from './types';

// The harness override reloads models and the request. Give its queries and
// whole-case budget room under full-suite load while keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;
const REQUEST_DETAIL_TEST_TIMEOUT_MS = 30_000;

const cell: Cell = {
  id: 'c1',
  name: 'Alpha',
  masterEnabled: true,
  masterIntervalMinutes: null,
  maxConcurrent: 3,
  harness: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  monthlyBudgetUsd: null,
  pauseOnExceeded: false,
  pauseOnUnknownCost: false,
  autocompactPercent: 80,
  createdAt: 1,
};

const opencodeCell: Cell = {
  ...cell,
  id: 'c2',
  name: 'OpenCode cell',
  harness: 'opencode',
  model: 'opencode-go/model-a',
};

function models(harness: 'claude' | 'opencode') {
  return {
    models:
      harness === 'claude'
        ? [
            { id: 'claude-opus-5-5', label: 'Opus 5.5' },
            { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
          ]
        : [{ id: 'opencode-go/model-a', label: 'OpenCode Model A' }],
    source: 'fallback',
    effortLevels: ['low', 'medium', 'high'],
    harness,
    supportsEffort: harness === 'claude',
    defaultModel: harness === 'opencode' ? 'opencode-go/model-a' : null,
  };
}

function installFetch(
  request = makeRequest({
    id: 'req-1',
    cellId: cell.id,
    model: 'claude-opus-5-5',
  }),
  activeCell = cell,
  requestGate?: Promise<void>,
) {
  const patched: Record<string, unknown>[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url === '/api/requests/req-1' && (init?.method ?? 'GET') === 'GET') {
        if (requestGate) await requestGate;
        return jsonResponse(request);
      }
      if (url === '/api/requests/req-1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patched.push(body);
        return jsonResponse({ ...request, ...body });
      }
      if (url === '/api/requests/req-1/clarify') {
        return jsonResponse({ started: false, transcript: [] });
      }
      if (url === '/api/requests/req-1/seen') return jsonResponse(request);
      if (url.startsWith('/api/usage')) {
        return jsonResponse({ error: 'not_found', message: 'no usage' }, 404);
      }
      if (url === '/api/commands') return jsonResponse([]);
      if (url.startsWith('/api/skills')) return jsonResponse([]);
      if (url === '/api/cells') return jsonResponse([activeCell]);
      if (url === `/api/models?cellId=${activeCell.id}`) {
        return jsonResponse(models(activeCell.harness ?? 'claude'));
      }
      if (url === '/api/models') return jsonResponse(models('claude'));
      if (url === '/api/models?harness=opencode') return jsonResponse(models('opencode'));
      if (url === '/api/models?harness=claude') return jsonResponse(models('claude'));
      return jsonResponse([]);
    }),
  );
  return { patched, urls };
}

describe('RequestDetail harness override', () => {
  it('saves an override and resets the model when the effective harness changes', async () => {
    const { patched } = installFetch();

    render(<RequestDetail id="req-1" onClose={() => {}} onError={() => {}} />);

    const harness = await screen.findByRole('combobox', { name: /harness/i }, { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('Opus 5.5', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('harness: Claude Code (cell Alpha)')).toBeInTheDocument();
    expect(harness).toHaveValue('');

    fireEvent.change(harness, { target: { value: 'opencode' } });

    expect(await screen.findByText('OpenCode Model A', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^model/i })).toHaveValue(''), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.getByText('harness: OpenCode (request override)')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('—', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patched).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(patched[0]).toMatchObject({ harness: 'opencode', model: null });
  }, REQUEST_DETAIL_TEST_TIMEOUT_MS);

  it('shows an inherited OpenCode cell harness and disables effort', async () => {
    installFetch(
      makeRequest({
        id: 'req-1',
        cellId: opencodeCell.id,
        model: null,
      }),
      opencodeCell,
    );

    render(<RequestDetail id="req-1" onClose={() => {}} onError={() => {}} />);

    expect(await screen.findByText('harness: OpenCode (cell OpenCode cell)')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /harness/i })).toHaveValue('');
    expect(await screen.findByDisplayValue('—', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  });

  it('discovers the brain-default harness after an unassigned request loads', async () => {
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const { urls } = installFetch(
      makeRequest({
        id: 'req-1',
        cellId: null,
        harness: null,
        model: null,
      }),
      cell,
      requestGate,
    );

    render(<RequestDetail id="req-1" onClose={() => {}} onError={() => {}} />);

    expect(
      await screen.findByText('Loading request...', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(urls).not.toContain('/api/models');

    await act(async () => {
      releaseRequest();
    });

    expect(
      await screen.findByText('harness: Claude Code (brain default)', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Opus 5.5', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(urls.filter((url) => url === '/api/models')).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed title' } });
    await waitFor(
      () => expect(screen.getByLabelText('Title')).toHaveValue('Changed title'),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(urls.filter((url) => url === '/api/models')).toHaveLength(1);
  }, REQUEST_DETAIL_TEST_TIMEOUT_MS);
});
