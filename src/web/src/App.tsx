import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Board } from './Board';
import { CellBar } from './CellBar';
import { CellModal } from './CellModal';
import { ConfigPage } from './ConfigPage';
import { CreateModal } from './CreateModal';
import { KbEntries } from './KbEntries';
import { MasterDetail } from './MasterDetail';
import { RequestDetail } from './RequestDetail';
import { SkillsPage } from './SkillsPage';
import { api, describeError } from './api';
import type { CellDetail, CommandInfo } from './types';
import { Button, cn } from './ui';

type Page = 'board' | 'kb' | 'skills' | 'config';

const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);

function readInitialRoute(): {
  page: Page;
  cellId: string | null;
  detailId: string | null;
  masterOpen: boolean;
} {
  if (typeof window === 'undefined') {
    return { page: 'board', cellId: null, detailId: null, masterOpen: false };
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('page');
  const page: Page =
    raw === 'kb' || raw === 'skills' || raw === 'config' ? raw : 'board';
  const masterOpen = params.get('master') === '1';
  return {
    page,
    cellId: params.get('cell'),
    detailId: masterOpen ? null : params.get('request'),
    masterOpen,
  };
}

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
  const [initialRoute] = useState(readInitialRoute);
  const [page, setPage] = useState<Page>(initialRoute.page);
  const [cells, setCells] = useState<CellDetail[]>([]);
  const [cellId, setCellId] = useState<string | null>(initialRoute.cellId);
  const [detailId, setDetailId] = useState<string | null>(initialRoute.detailId);
  const [masterOpen, setMasterOpen] = useState(initialRoute.masterOpen);
  const [cellModalOpen, setCellModalOpen] = useState(false);
  const [editingCell, setEditingCell] = useState<CellDetail | null>(null);
  const [terminalAvailable, setTerminalAvailable] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const [navOpen, setNavOpen] = useState(false);

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

  useEffect(() => {
    api
      .getTerminalStatus()
      .then((status) => setTerminalAvailable(status.available))
      .catch(() => setTerminalAvailable(false));
  }, []);

  const refreshBoard = useCallback(() => setBoardKey((key) => key + 1), []);

  // Keep the current page, floor, and open request in the URL so a reload (or a
  // phone switching apps) comes back to the same place.
  useEffect(() => {
    const params = new URLSearchParams();
    if (page !== 'board') params.set('page', page);
    if (cellId) params.set('cell', cellId);
    if (detailId) params.set('request', detailId);
    if (masterOpen) params.set('master', '1');
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, [page, cellId, detailId, masterOpen]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const go = (next: Page) => {
    setPage(next);
    setDetailId(null);
    setMasterOpen(false);
    setNavOpen(false);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-200">
      {navOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <aside
        id="app-sidebar"
        data-testid="sidebar"
        data-open={navOpen}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col gap-4 border-r border-zinc-900 bg-zinc-950 p-3 transition-transform duration-200 md:static md:z-auto md:w-56 md:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-start justify-between px-2 pt-1">
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-zinc-100">
              Sandbox Harness
            </h1>
            <p className="text-[11px] text-zinc-600">process segments for agents</p>
          </div>
          <button
            type="button"
            aria-label="Close menu"
            className="rounded-md p-1 text-lg leading-none text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 md:hidden"
            onClick={() => setNavOpen(false)}
          >
            ×
          </button>
        </div>

        <nav className="space-y-0.5">
          <NavButton active={page === 'board'} onClick={() => go('board')}>
            Floor
          </NavButton>
          <NavButton active={page === 'kb'} onClick={() => go('kb')}>
            Knowledge base
          </NavButton>
          <NavButton active={page === 'skills'} onClick={() => go('skills')}>
            Skills
          </NavButton>
          <NavButton active={page === 'config'} onClick={() => go('config')}>
            Config
          </NavButton>
        </nav>

        <div className="border-t border-zinc-900 pt-3">
          <CellBar
            cells={cells}
            value={cellId}
            onChange={(id) => {
              setCellId(id);
              setNavOpen(false);
            }}
            onCreate={() => {
              setEditingCell(null);
              setCellModalOpen(true);
              setNavOpen(false);
            }}
            onEdit={(cell) => {
              setEditingCell(cells.find((item) => item.id === cell.id) ?? null);
              setCellModalOpen(true);
              setNavOpen(false);
            }}
            reload={() => void loadCells()}
            onError={setError}
          />
        </div>

        <div className="mt-auto space-y-2">
          {terminalAvailable ? (
            <Button
              variant="secondary"
              className="hidden w-full md:inline-flex"
              onClick={() => {
                setTerminalOpen(true);
                setTerminalMaximized(false);
                setNavOpen(false);
              }}
            >
              Terminal
            </Button>
          ) : null}
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              setDetailId(null);
              setMasterOpen(true);
              setNavOpen(false);
            }}
          >
            Cell master
          </Button>
          <Button
            variant="primary"
            className="w-full"
            onClick={() => {
              setMasterOpen(false);
              setCreateOpen(true);
              setNavOpen(false);
            }}
          >
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

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-zinc-900 px-3 py-2 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => setNavOpen(true)}
            className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800"
          >
            ☰
          </button>
          <span className="text-sm font-semibold text-zinc-100">Sandbox Harness</span>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {page === 'board' ? (
            <Board
              key={boardKey}
              cellId={cellId}
              onOpen={(id) => {
                setMasterOpen(false);
                setDetailId(id);
                setNavOpen(false);
              }}
              onError={setError}
            />
          ) : null}
          {page === 'kb' ? <KbEntries commands={commands} onError={setError} /> : null}
          {page === 'skills' ? <SkillsPage onError={setError} /> : null}
          {page === 'config' ? (
            <ConfigPage
              commands={commands}
              onError={setError}
              onEditCell={(cell) => {
                setEditingCell(cell);
                setCellModalOpen(true);
              }}
            />
          ) : null}
        </div>
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

      {masterOpen ? (
        <MasterDetail
          cellId={cellId}
          commands={commands}
          onClose={() => setMasterOpen(false)}
          onConfigure={() => go('config')}
          onError={setError}
        />
      ) : null}

      <CellModal
        open={cellModalOpen}
        cell={editingCell}
        onClose={() => setCellModalOpen(false)}
        onSaved={(cell) => {
          setCellModalOpen(false);
          setCellId(cell.id);
          void loadCells();
        }}
        onError={setError}
      />

      {terminalOpen && terminalAvailable ? (
        <Suspense fallback={null}>
          <TerminalPanel
            maximized={terminalMaximized}
            onToggleMaximize={() => setTerminalMaximized((value) => !value)}
            onClose={() => {
              setTerminalOpen(false);
              setTerminalMaximized(false);
            }}
          />
        </Suspense>
      ) : null}

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        cellId={cellId}
        onError={setError}
        onCreated={(id) => {
          setCreateOpen(false);
          setPage('board');
          setMasterOpen(false);
          setDetailId(id);
          refreshBoard();
        }}
      />
    </div>
  );
}

export default App;
