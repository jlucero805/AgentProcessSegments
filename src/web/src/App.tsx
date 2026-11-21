import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Board } from './Board';
import { CellBar } from './CellBar';
import { CreateModal } from './CreateModal';
import { KbEntries } from './KbEntries';
import { RequestDetail } from './RequestDetail';
import { SkillsPage } from './SkillsPage';
import { api, describeError } from './api';
import type { Cell, CommandInfo } from './types';
import { Button, cn } from './ui';

type Page = 'board' | 'kb' | 'skills';

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
      )}
    >
      {children}
    </button>
  );
}

export function App() {
  const [page, setPage] = useState<Page>('board');
  const [cells, setCells] = useState<Cell[]>([]);
  const [cellId, setCellId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(0);

  const loadCells = useCallback(async () => {
    try {
      setCells(await api.getCells());
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void loadCells();
  }, [loadCells]);

  useEffect(() => {
    api.getCommands().then(setCommands).catch(() => {});
  }, []);

  const refreshBoard = useCallback(() => setBoardKey((key) => key + 1), []);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-200">
      <aside className="flex w-56 shrink-0 flex-col gap-4 border-r border-zinc-900 p-3">
        <div className="px-2 pt-1">
          <h1 className="text-sm font-semibold tracking-tight text-zinc-100">Sandbox Harness</h1>
          <p className="text-[11px] text-zinc-600">process segments for agents</p>
        </div>

        <nav className="space-y-0.5">
          <NavButton active={page === 'board'} onClick={() => setPage('board')}>
            Floor
          </NavButton>
          <NavButton active={page === 'kb'} onClick={() => setPage('kb')}>
            Knowledge base
          </NavButton>
          <NavButton active={page === 'skills'} onClick={() => setPage('skills')}>
            Skills
          </NavButton>
        </nav>

        <div className="border-t border-zinc-900 pt-3">
          <CellBar
            cells={cells}
            value={cellId}
            onChange={setCellId}
            reload={() => void loadCells()}
            onError={setError}
          />
        </div>

        <div className="mt-auto space-y-2">
          <Button variant="primary" className="w-full" onClick={() => setCreateOpen(true)}>
            + New request
          </Button>
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-red-900 bg-red-950/50 p-2 text-[11px] leading-snug text-red-300"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words">{error}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  className="shrink-0 text-red-400 hover:text-red-200"
                  onClick={() => setError(null)}
                >
                  ×
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        {page === 'board' ? (
          <Board key={boardKey} cellId={cellId} onOpen={setDetailId} onError={setError} />
        ) : null}
        {page === 'kb' ? <KbEntries commands={commands} onError={setError} /> : null}
        {page === 'skills' ? <SkillsPage onError={setError} /> : null}
      </main>

      {detailId ? (
        <RequestDetail
          id={detailId}
          onClose={() => {
            setDetailId(null);
            refreshBoard();
          }}
          onError={setError}
          onChanged={refreshBoard}
        />
      ) : null}

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        cellId={cellId}
        onError={setError}
        onCreated={(id) => {
          setCreateOpen(false);
          setPage('board');
          setDetailId(id);
          refreshBoard();
        }}
      />
    </div>
  );
}

export default App;
