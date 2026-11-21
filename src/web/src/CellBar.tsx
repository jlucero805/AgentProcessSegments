import { useState } from 'react';
import { api, describeError } from './api';
import type { Cell } from './types';
import { Button, IconButton, Input, cn } from './ui';

interface CellBarProps {
  cells: Cell[];
  value: string | null;
  onChange: (id: string | null) => void;
  reload: () => void;
  onError: (message: string) => void;
}

/** Floor filter: "all cells" plus one pill per cell, with inline create/rename/delete. */
export function CellBar({ cells, value, onChange, reload, onError }: CellBarProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  async function create() {
    const name = draft.trim();
    if (!name) return;
    try {
      const cell = await api.createCell(name);
      setDraft('');
      setAdding(false);
      reload();
      onChange(cell.id);
    } catch (error) {
      onError(describeError(error));
    }
  }

  async function rename(id: string) {
    const name = editDraft.trim();
    if (!name) return;
    try {
      await api.renameCell(id, name);
      setEditing(null);
      reload();
    } catch (error) {
      onError(describeError(error));
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteCell(id);
      if (value === id) onChange(null);
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
        <IconButton label="New cell" className="h-5 w-5 text-zinc-500" onClick={() => setAdding((v) => !v)}>
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

      {cells.map((cell) =>
        editing === cell.id ? (
          <div key={cell.id} className="flex items-center gap-1">
            <Input
              autoFocus
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename(cell.id);
                if (event.key === 'Escape') setEditing(null);
              }}
              className="h-7 py-0.5 text-xs"
            />
            <IconButton label="Save name" className="h-6 w-6" onClick={() => void rename(cell.id)}>
              ✓
            </IconButton>
          </div>
        ) : (
          <div key={cell.id} className="group flex items-center gap-1">
            <button
              type="button"
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
              label={`Rename ${cell.name}`}
              className="h-6 w-6 text-zinc-600 opacity-0 group-hover:opacity-100"
              onClick={() => {
                setEditing(cell.id);
                setEditDraft(cell.name);
              }}
            >
              ✎
            </IconButton>
            <IconButton
              label={`Delete ${cell.name}`}
              className="h-6 w-6 text-zinc-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
              onClick={() => void remove(cell.id)}
            >
              ×
            </IconButton>
          </div>
        ),
      )}

      {adding ? (
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create();
              if (event.key === 'Escape') setAdding(false);
            }}
            placeholder="Cell name"
            className="h-7 py-0.5 text-xs"
          />
          <Button size="sm" variant="secondary" onClick={() => void create()}>
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
