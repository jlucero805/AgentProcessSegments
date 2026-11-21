import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CellBar } from './CellBar';
import { jsonResponse } from './test/fixtures';
import type { Cell } from './types';

const cells: Cell[] = [{ id: 'c1', name: 'Alpha', createdAt: 1 }];

describe('CellBar', () => {
  it('switches between all cells and a specific cell', () => {
    const onChange = vi.fn();
    render(
      <CellBar cells={cells} value={null} onChange={onChange} reload={() => {}} onError={() => {}} />,
    );

    fireEvent.click(screen.getByText('Alpha'));
    expect(onChange).toHaveBeenCalledWith('c1');

    fireEvent.click(screen.getByText('All cells'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('creates a cell and selects it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'c2', name: 'Beta', createdAt: 2 }, 201)));
    const onChange = vi.fn();
    const reload = vi.fn();

    render(
      <CellBar cells={cells} value={null} onChange={onChange} reload={reload} onError={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New cell' }));
    fireEvent.change(screen.getByPlaceholderText('Cell name'), { target: { value: 'Beta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('c2'));
    expect(reload).toHaveBeenCalled();
  });
});
