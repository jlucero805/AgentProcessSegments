import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestDetail } from './RequestDetail';
import { jsonResponse, makeRequest } from './test/fixtures';
import type { Cell } from './types';

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
) {
  const patched: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/requests/req-1' && (init?.method ?? 'GET') === 'GET') {
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
      if (url === '/api/models?harness=opencode') return jsonResponse(models('opencode'));
      if (url === '/api/models?harness=claude') return jsonResponse(models('claude'));
      return jsonResponse([]);
    }),
  );
  return { patched };
}

describe('RequestDetail harness override', () => {
  it('saves an override and resets the model when the effective harness changes', async () => {
    const { patched } = installFetch();

    render(<RequestDetail id="req-1" onClose={() => {}} onError={() => {}} />);

    const harness = await screen.findByRole('combobox', { name: /harness/i });
    expect(await screen.findByText('Opus 5.5')).toBeInTheDocument();
    expect(screen.getByText('harness: Claude Code (cell Alpha)')).toBeInTheDocument();
    expect(harness).toHaveValue('');

    fireEvent.change(harness, { target: { value: 'opencode' } });

    expect(await screen.findByText('OpenCode Model A')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^model/i })).toHaveValue(''),
    );
    expect(screen.getByText('harness: OpenCode (request override)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('—')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({ harness: 'opencode', model: null });
  });

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
    expect(screen.getByDisplayValue('—')).toBeInTheDocument();
  });
});
