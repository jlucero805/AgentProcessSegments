import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { CellBar } from './CellBar';
import type { Cell } from './types';

const cells: Cell[] = [
  {
    id: 'c1',
    name: 'Alpha',
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
    createdAt: 1,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CellBar', () => {
  it('switches between all cells and a specific cell', () => {
    const onChange = vi.fn();
    render(
      <CellBar
        cells={cells}
        value={null}
        onChange={onChange}
        onCreate={() => {}}
        onEdit={() => {}}
        onDeleted={() => {}}
        reload={() => {}}
        onError={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('Alpha'));
    expect(onChange).toHaveBeenCalledWith('c1');

    fireEvent.click(screen.getByText('All cells'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('opens the cell creation flow and the editor', () => {
    const onCreate = vi.fn();
    const onEdit = vi.fn();

    render(
      <CellBar
        cells={cells}
        value={null}
        onChange={() => {}}
        onCreate={onCreate}
        onEdit={onEdit}
        onDeleted={() => {}}
        reload={() => {}}
        onError={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New cell' }));
    expect(onCreate).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }));
    expect(onEdit).toHaveBeenCalledWith(cells[0]);
  });

  it('does not reload when the delete fails', async () => {
    vi.spyOn(api, 'deleteCell').mockRejectedValue(new Error('delete failed'));
    const reload = vi.fn();
    const onDeleted = vi.fn();
    const onError = vi.fn();

    render(
      <CellBar
        cells={cells}
        value={null}
        onChange={() => {}}
        onCreate={() => {}}
        onEdit={() => {}}
        onDeleted={onDeleted}
        reload={reload}
        onError={onError}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('delete failed'));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('drops the cell and reloads after a successful delete', async () => {
    vi.spyOn(api, 'deleteCell').mockResolvedValue(undefined);
    const onChange = vi.fn();
    const onDeleted = vi.fn();
    const reload = vi.fn();

    render(
      <CellBar
        cells={cells}
        value="c1"
        onChange={onChange}
        onCreate={() => {}}
        onEdit={() => {}}
        onDeleted={onDeleted}
        reload={reload}
        onError={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('c1'));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(reload).toHaveBeenCalled();
  });
});
