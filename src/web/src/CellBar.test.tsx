import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    createdAt: 1,
  },
];

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
        reload={() => {}}
        onError={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New cell' }));
    expect(onCreate).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }));
    expect(onEdit).toHaveBeenCalledWith(cells[0]);
  });
});
