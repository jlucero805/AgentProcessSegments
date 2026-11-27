import { api, describeError } from './api';
import type { Cell } from './types';
import { IconButton, cn } from './ui';

interface CellBarProps {
  cells: Cell[];
  value: string | null;
  onChange: (id: string | null) => void;
  onCreate: () => void;
  onEdit: (cell: Cell) => void;
  /** Drop a deleted cell from the shared list before its refresh lands. */
  onDeleted: (id: string) => void;
  reload: () => void;
  onError: (message: string) => void;
}

/** Floor filter: "all cells" plus one row per cell, with create/edit/delete. */
export function CellBar({
  cells,
  value,
  onChange,
  onCreate,
  onEdit,
  onDeleted,
  reload,
  onError,
}: CellBarProps) {
  async function remove(id: string) {
    try {
      await api.deleteCell(id);
      if (value === id) onChange(null);
      onDeleted(id);
      reload();
    } catch (error) {
      onError(describeError(error));
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
          Cells
        </span>
        <IconButton
          label="New cell"
          data-testid="new-cell"
          className="h-5 w-5 text-zinc-500"
          onClick={onCreate}
        >
          +
        </IconButton>
      </div>

      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          'w-full rounded-md px-2 py-1 text-left text-sm transition-colors',
          value === null ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
        )}
      >
        All cells
      </button>

      {cells.map((cell) => (
        <div key={cell.id} className="group flex items-center gap-1">
          <button
            type="button"
            data-testid="cell-option"
            data-cell-id={cell.id}
            onClick={() => onChange(cell.id)}
            className={cn(
              'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm transition-colors',
              value === cell.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
            )}
          >
            {cell.name}
          </button>
          <IconButton
            label={`Edit ${cell.name}`}
            className="h-6 w-6 text-zinc-600 opacity-100 md:opacity-0 md:group-hover:opacity-100"
            onClick={() => onEdit(cell)}
          >
            ✎
          </IconButton>
          <IconButton
            label={`Delete ${cell.name}`}
            className="h-6 w-6 text-zinc-600 opacity-100 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
            onClick={() => void remove(cell.id)}
          >
            ×
          </IconButton>
        </div>
      ))}
    </div>
  );
}
