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
      | { name?: string; process?: { segments?: unknown[] }; masterIntervalMinutes?: number | null }
      | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/process') return jsonResponse(makeProcessResponse());
        if (url === '/api/cells' && init?.method === 'POST') {
          created = JSON.parse(String(init.body)) as typeof created;
          const cell: CellDetail = {
            id: 'c2',
            name: created?.name ?? 'Cell',
            masterEnabled: true,
            masterIntervalMinutes: null,
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
      <CellModal open cell={null} onClose={() => {}} onSaved={onSaved} onError={() => {}} />,
    );

    expect(await screen.findByText('Cell process segments')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. Work repo'), {
      target: { value: 'Work repo' },
    });
    fireEvent.change(screen.getByPlaceholderText('global default'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cell' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(created?.name).toBe('Work repo');
    expect(created?.masterIntervalMinutes).toBe(3);
    expect(created?.process?.segments).toHaveLength(5);
  });

  it('edits an existing cell without requiring a fetch', async () => {
    const cell: CellDetail = {
      id: 'c1',
      name: 'Alpha',
      masterEnabled: true,
      masterIntervalMinutes: 7,
      process: baseProcess(),
      createdAt: 1,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return jsonResponse({ ...cell, name: 'Renamed' });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(
      <CellModal open cell={cell} onClose={() => {}} onSaved={onSaved} onError={() => {}} />,
    );

    const name = await screen.findByDisplayValue('Alpha');
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save cell' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/cells/c1')).toBe(true);
  });
});
