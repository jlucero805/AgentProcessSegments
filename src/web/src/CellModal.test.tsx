import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CellModal } from './CellModal';
import { jsonResponse, makeProcessResponse } from './test/fixtures';
import type { CellDetail } from './types';

describe('CellModal', () => {
  const baseProcess = () => {
    const process = makeProcessResponse();
    return { version: process.version, segments: process.segments };
  };

  it('creates a cell with a full process policy', async () => {
    let created:
      | {
          name?: string;
          process?: { segments?: unknown[] };
          masterIntervalMinutes?: number | null;
          maxConcurrent?: number;
          harness?: string | null;
          model?: string | null;
          effort?: string | null;
          monthlyBudgetUsd?: number | null;
          autocompactPercent?: number;
        }
      | undefined;
    let draft: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/process') return jsonResponse(makeProcessResponse());
        if (url === '/api/models') {
          return jsonResponse({
            models: [
              {
                id: 'opencode-go/deepseek-v4.1-flash',
                label: 'DeepSeek V4.1 Flash',
              },
              { id: 'm1', label: 'Model One' },
            ],
            source: 'probe',
            effortLevels: ['low', 'medium', 'high'],
            supportsEffort: true,
            defaultModel: 'opencode-go/deepseek-v4.1-flash',
          });
        }
        if (url.startsWith('/api/cell-drafts/') && init?.method === 'PUT') {
          draft = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ id: 'draft-1', name: 'Draft' });
        }
        if (url === '/api/cells' && init?.method === 'POST') {
          created = JSON.parse(String(init.body)) as typeof created;
          const cell: CellDetail = {
            id: 'c2',
            name: created?.name ?? 'Cell',
            masterEnabled: true,
            masterIntervalMinutes: null,
            maxConcurrent: 3,
            harness: null,
            model: null,
            effort: null,
            monthlyBudgetUsd: null,
            autocompactPercent: 80,
            process: baseProcess(),
            createdAt: 2,
          };
          return jsonResponse(cell, 201);
        }
        return jsonResponse([]);
      }),
    );
    const onSaved = vi.fn();

    render(
      <CellModal open cell={null} commands={[]} onClose={() => {}} onSaved={onSaved} onError={() => {}} />,
    );

    expect(await screen.findByText('Cell process segments')).toBeInTheDocument();
    expect(screen.getByText('Setup assistant')).toBeInTheDocument();
    expect(await screen.findByText('Model One')).toBeInTheDocument();
    const modelSelect = screen.getByRole('combobox', { name: /default model/i });
    await waitFor(() =>
      expect(modelSelect).toHaveValue('opencode-go/deepseek-v4.1-flash'),
    );
    expect(screen.getByRole('spinbutton', { name: /auto-compact/i })).toHaveValue(80);
    fireEvent.change(screen.getByPlaceholderText('e.g. Work repo'), {
      target: { value: 'Work repo' },
    });
    fireEvent.change(screen.getByPlaceholderText('global default'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: /default model/i }), {
      target: { value: 'm1' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: /default difficulty/i }), {
      target: { value: 'high' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: /monthly spend budget/i }), {
      target: { value: '42.5' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: /auto-compact/i }), {
      target: { value: '70' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cell' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(created?.name).toBe('Work repo');
    expect(created?.masterIntervalMinutes).toBe(3);
    expect(created?.maxConcurrent).toBe(3);
    expect(created?.model).toBe('m1');
    expect(created?.effort).toBe('high');
    expect(created?.harness).toBeNull();
    expect(created?.monthlyBudgetUsd).toBe(42.5);
    expect(created?.autocompactPercent).toBe(70);
    expect(created?.process?.segments).toHaveLength(6);
    if (draft) expect(draft).not.toHaveProperty('monthlyBudgetUsd');
  });

  it('switches the model catalog and effort control with the harness', async () => {
    const modelUrls: string[] = [];
    let created: { harness?: string | null; model?: string | null } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/process') return jsonResponse(makeProcessResponse());
        if (url.startsWith('/api/models')) {
          modelUrls.push(url);
          if (url.includes('harness=opencode')) {
            return jsonResponse({
              models: [{ id: 'open-model', label: 'Open model' }],
              source: 'fallback',
              effortLevels: ['low', 'medium', 'high'],
              harness: 'opencode',
              supportsEffort: false,
              defaultModel: 'open-model',
            });
          }
          return jsonResponse({
            models: [{ id: 'claude-model', label: 'Claude model' }],
            source: 'fallback',
            effortLevels: ['low', 'medium', 'high'],
            harness: 'claude',
            supportsEffort: true,
            defaultModel: null,
          });
        }
        if (url === '/api/cells' && init?.method === 'POST') {
          created = JSON.parse(String(init.body)) as typeof created;
          return jsonResponse(
            {
              id: 'c3',
              name: 'Open cell',
              masterEnabled: true,
              masterIntervalMinutes: null,
              maxConcurrent: 3,
              harness: 'opencode',
              model: null,
              effort: null,
              process: baseProcess(),
              createdAt: 3,
            },
            201,
          );
        }
        return jsonResponse([]);
      }),
    );

    render(
      <CellModal open cell={null} commands={[]} onClose={() => {}} onSaved={() => {}} onError={() => {}} />,
    );
    expect(await screen.findByText('Claude model')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: /agent harness/i }), {
      target: { value: 'opencode' },
    });
    expect(await screen.findByText('Open model')).toBeInTheDocument();
    expect(modelUrls).toContain('/api/models?harness=opencode');
    expect(screen.queryByRole('combobox', { name: /default difficulty/i })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /default difficulty/i })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('e.g. Work repo'), {
      target: { value: 'Open cell' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cell' }));
    await waitFor(() => expect(created).toBeDefined());
    expect(created?.harness).toBe('opencode');
  });

  it('rejects an out-of-range auto-compaction percentage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/process') return jsonResponse(makeProcessResponse());
        if (url === '/api/models') {
          return jsonResponse({ models: [], source: 'fallback', effortLevels: ['low'] });
        }
        if (url.startsWith('/api/cell-drafts/') && init?.method === 'PUT') {
          return jsonResponse({ id: 'draft-1', name: 'Draft' });
        }
        return jsonResponse([]);
      }),
    );
    const onError = vi.fn();
    const onSaved = vi.fn();

    render(
      <CellModal
        open
        cell={null}
        commands={[]}
        onClose={() => {}}
        onSaved={onSaved}
        onError={onError}
      />,
    );

    await screen.findByText('Cell process segments');
    fireEvent.change(screen.getByPlaceholderText('e.g. Work repo'), {
      target: { value: 'Bad threshold' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: /auto-compact/i }), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cell' }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Auto-compact must be a whole number from 1 to 99.',
      ),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows an inline error and Retry when the setup draft cannot sync', async () => {
    let draftAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/process') return jsonResponse(makeProcessResponse());
        if (url === '/api/models') {
          return jsonResponse({
            models: [],
            source: 'fallback',
            effortLevels: ['low', 'medium', 'high'],
            supportsEffort: true,
          });
        }
        if (url.startsWith('/api/cell-drafts/') && init?.method === 'PUT') {
          draftAttempts += 1;
          if (draftAttempts === 1) {
            return jsonResponse({ error: 'invalid', message: 'draft rejected' }, 400);
          }
          return jsonResponse({ id: 'draft-1', name: 'Draft' });
        }
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        return jsonResponse([]);
      }),
    );
    const onError = vi.fn();

    render(
      <CellModal
        open
        cell={null}
        commands={[]}
        onClose={() => {}}
        onSaved={() => {}}
        onError={onError}
      />,
    );

    expect(await screen.findByText('Could not start the setup chat.')).toBeInTheDocument();
    expect(screen.queryByText('Starting setup chat…')).not.toBeInTheDocument();
    expect(screen.getByText(/draft rejected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByPlaceholderText('Ask how this cell should be configured…'),
    ).toBeInTheDocument();
    expect(draftAttempts).toBe(2);
  });

  it('loads the current policy when editing an existing cell', async () => {
    const stale = baseProcess();
    stale.segments = stale.segments.map((segment) =>
      segment.id === 'plan' ? { ...segment, purpose: 'Stale plan purpose' } : segment,
    );
    const fresh = baseProcess();
    fresh.segments = fresh.segments.map((segment) =>
      segment.id === 'plan' ? { ...segment, purpose: 'Fresh plan purpose' } : segment,
    );
    const cell: CellDetail = {
      id: 'c1',
      name: 'Alpha',
      masterEnabled: true,
      masterIntervalMinutes: 7,
      maxConcurrent: 3,
      harness: null,
      model: null,
      effort: null,
      monthlyBudgetUsd: null,
      autocompactPercent: 80,
      process: stale,
      createdAt: 1,
    };
    const serverCell: CellDetail = { ...cell, process: fresh };
    let patched: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        patched = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ ...serverCell, name: 'Renamed' });
      }
      if (url === '/api/cells/c1') return jsonResponse(serverCell);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(
      <CellModal open cell={cell} commands={[]} onClose={() => {}} onSaved={onSaved} onError={() => {}} />,
    );

    const name = await screen.findByDisplayValue('Alpha');
    expect((await screen.findAllByText('Fresh plan purpose')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Stale plan purpose')).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/cells/c1')).toBe(true);

    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save cell' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(patched).not.toBeNull();
    expect(patched).toMatchObject({ autocompactPercent: 80 });
  });
});
