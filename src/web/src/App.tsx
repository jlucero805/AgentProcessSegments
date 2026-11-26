import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Board } from './Board';
import { BudgetBanner } from './BudgetBanner';
import { CellBar } from './CellBar';
import { CellModal } from './CellModal';
import { ConfigPage } from './ConfigPage';
import { CreateModal } from './CreateModal';
import { HelpPanel } from './HelpPanel';
import { KbEntries } from './KbEntries';
import { MasterDetail } from './MasterDetail';
import { RequestDetail } from './RequestDetail';
import { ScorecardsPage } from './ScorecardsPage';
import { SkillsPage } from './SkillsPage';
import { UsagePage } from './UsagePage';
import { api, describeError } from './api';
import { REPO_URL } from './links';
import { mergeSlashCommands } from './slash';
import type { CellDetail, CommandInfo } from './types';
import { Button, cn } from './ui';
import { useBudgets } from './useBudgets';

type Page = 'board' | 'kb' | 'skills' | 'usage' | 'scorecards' | 'config';

const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);

function readRoute(): {
  page: Page;
  cellId: string | null;
  detailId: string | null;
  masterOpen: boolean;
  helpSlug: string | null;
  helpAnchor: string | null;
} {
  if (typeof window === 'undefined') {
    return {
      page: 'board',
      cellId: null,
      detailId: null,
      masterOpen: false,
      helpSlug: null,
      helpAnchor: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('page');
  const page: Page =
    raw === 'kb' ||
    raw === 'skills' ||
    raw === 'usage' ||
    raw === 'scorecards' ||
    raw === 'config'
      ? raw
      : 'board';
  const cellId = params.get('cell');
  // Only a real cell owns a master; the "all cells" filter cannot open one.
  const masterOpen = params.get('master') === '1' && cellId !== null;
  const helpSlug = params.get('help') || null;
  const hash = window.location.hash.replace(/^#/, '');
  return {
    page,
    cellId,
    detailId: masterOpen ? null : params.get('request'),
    masterOpen,
    helpSlug,
    helpAnchor: helpSlug && hash ? hash : null,
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
  const [initialRoute] = useState(readRoute);
  const [page, setPage] = useState<Page>(initialRoute.page);
  const [cells, setCells] = useState<CellDetail[]>([]);
  const [cellId, setCellId] = useState<string | null>(initialRoute.cellId);
  const [detailId, setDetailId] = useState<string | null>(initialRoute.detailId);
  const [masterOpen, setMasterOpen] = useState(initialRoute.masterOpen);
  const [helpSlug, setHelpSlug] = useState<string | null>(initialRoute.helpSlug);
  const [helpAnchor, setHelpAnchor] = useState<string | null>(initialRoute.helpAnchor);
  const [cellModalOpen, setCellModalOpen] = useState(false);
  const [editingCell, setEditingCell] = useState<CellDetail | null>(null);
  const [terminalAvailable, setTerminalAvailable] = useState(false);
  const [terminalCount, setTerminalCount] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement | null>(null);
  const helpWasOpen = useRef(false);
  const budgetFeed = useBudgets(setError);

  const loadCells = useCallback(async () => {
    try {
      setCells(await api.getCells());
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadCells();
    })();
  }, [loadCells]);

  useEffect(() => {
    Promise.all([api.getCommands(), api.getSkills()])
      .then(([commandList, skillList]) => setCommands(mergeSlashCommands(commandList, skillList)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = () =>
      api
        .getTerminalStatus()
        .then((status) => {
          if (!mounted) return;
          setTerminalAvailable(status.available);
          setTerminalCount(status.sessions ?? 0);
        })
        .catch(() => {
          if (mounted) setTerminalAvailable(false);
        });
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  const refreshBoard = useCallback(() => setBoardKey((key) => key + 1), []);

  // Keep the current page, floor, request, docs page, and open overlay in the URL
  // so a reload (or a phone switching apps) comes back to the same place.
  useEffect(() => {
    const params = new URLSearchParams();
    if (page !== 'board') params.set('page', page);
    if (cellId) params.set('cell', cellId);
    if (detailId) params.set('request', detailId);
    if (masterOpen) params.set('master', '1');
    if (helpSlug) params.set('help', helpSlug);
    const search = params.toString();
    const hash = helpSlug && helpAnchor ? `#${helpAnchor}` : '';
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${hash}`,
    );
  }, [page, cellId, detailId, masterOpen, helpSlug, helpAnchor]);

  useEffect(() => {
    const onPopState = () => {
      const route = readRoute();
      setPage(route.page);
      setCellId(route.cellId);
      setDetailId(route.detailId);
      setMasterOpen(route.masterOpen);
      setHelpSlug(route.helpSlug);
      setHelpAnchor(route.helpAnchor);
      setNavOpen(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // "On this page" links update the hash directly; mirror them into route state
  // so later renders do not drop the anchor.
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#/, '');
      setHelpAnchor(hash || null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Closing the docs returns focus to the button that opened them.
  useEffect(() => {
    if (helpWasOpen.current && !helpSlug) helpButtonRef.current?.focus();
    helpWasOpen.current = helpSlug !== null;
  }, [helpSlug]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const pushHelpRoute = (next: string, anchor: string | null) => {
    const params = new URLSearchParams(window.location.search);
    params.set('help', next);
    const search = params.toString();
    const hash = anchor ? `#${anchor}` : '';
    window.history.pushState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${hash}`,
    );
  };

  const go = (next: Page) => {
    setPage(next);
    setDetailId(null);
    setMasterOpen(false);
    setHelpSlug(null);
    setHelpAnchor(null);
    setNavOpen(false);
  };

  const openHelp = () => {
    setHelpSlug((current) => current ?? 'getting-started');
    setHelpAnchor(null);
    setNavOpen(false);
  };

  const openHelpAt = (next: string, anchor?: string) => {
    setHelpSlug(next);
    setHelpAnchor(anchor ?? null);
    setNavOpen(false);
    pushHelpRoute(next, anchor ?? null);
  };

  const selectHelpPage = (next: string, anchor?: string) => {
    const nextAnchor = anchor ?? null;
    if (next === helpSlug && nextAnchor === helpAnchor) return;
    setHelpSlug(next);
    setHelpAnchor(nextAnchor);
    pushHelpRoute(next, nextAnchor);
  };

  const closeHelp = () => {
    setHelpSlug(null);
    setHelpAnchor(null);
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
              Agent Process Segments
            </h1>
            <p className="text-[11px] text-zinc-600">headless agent orchestration</p>
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
          <NavButton active={page === 'usage'} onClick={() => go('usage')}>
            Usage
          </NavButton>
          <NavButton active={page === 'scorecards'} onClick={() => go('scorecards')}>
            Scorecards
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
              if (!id) setMasterOpen(false);
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
              aria-label="Terminal"
              onClick={() => {
                setTerminalOpen(true);
                setTerminalMaximized(false);
                setNavOpen(false);
              }}
            >
              Terminal{terminalCount > 0 ? ` (${terminalCount})` : ''}
            </Button>
          ) : null}
          {cellId ? (
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
          ) : null}
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
          <hr className="my-2 border-zinc-900" />
          <div className="flex items-center gap-1">
            <button
              ref={helpButtonRef}
              type="button"
              aria-label="Help"
              aria-current={helpSlug ? 'page' : undefined}
              onClick={openHelp}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                helpSlug
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
              )}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
                <circle cx="8" cy="8" r="6.25" />
                <path d="M6.1 6.1a1.95 1.95 0 1 1 2.55 1.86c-.4.15-.65.5-.65.93v.38" />
                <path d="M8 12.05h.01" strokeLinecap="round" strokeWidth="1.8" />
              </svg>
              <span>Help</span>
            </button>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub repository"
              title="GitHub repository"
              onClick={() => setNavOpen(false)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4 shrink-0"
                fill="currentColor"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
            </a>
          </div>
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
          <span className="text-sm font-semibold text-zinc-100">Agent Process Segments</span>
        </header>

        <BudgetBanner
          budgets={budgetFeed.budgets}
          onAck={(alert) => void budgetFeed.acknowledge(alert)}
          onSnooze={(pause, minutes) =>
            void budgetFeed.snooze({
              scope: pause.scope,
              ...(pause.cellId === null ? {} : { cellId: pause.cellId }),
              minutes,
            })
          }
          onRevoke={(id) => void budgetFeed.revokeOverride(id)}
        />

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
          {page === 'usage' ? (
            <UsagePage onError={setError} budgetFeed={budgetFeed} />
          ) : null}
          {page === 'scorecards' ? (
            <ScorecardsPage key={cellId ?? 'all'} cellId={cellId} onError={setError} />
          ) : null}
          {page === 'config' ? (
            <ConfigPage
              onError={setError}
              onOpenHelp={openHelpAt}
              reloadBudgets={budgetFeed.reload}
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

      {masterOpen && cellId ? (
        <MasterDetail
          cellId={cellId}
          commands={commands}
          onClose={() => setMasterOpen(false)}
          onConfigure={(cell) => {
            if (!cell) {
              go('config');
              return;
            }
            // Configure from a cell master must open that cell's own policy,
            // not the global template on the Config page.
            setMasterOpen(false);
            setEditingCell(cell);
            setCellModalOpen(true);
          }}
          onError={setError}
        />
      ) : null}

      <CellModal
        open={cellModalOpen}
        cell={editingCell}
        commands={commands}
        onClose={() => setCellModalOpen(false)}
        onSaved={(cell) => {
          setCellModalOpen(false);
          setCellId(cell.id);
          void loadCells();
          // A cell save can change its budget or pause policy; refresh the one
          // shared budget feed instead of waiting for the next poll.
          void budgetFeed.reload();
        }}
        onError={setError}
      />

      {helpSlug ? (
        <HelpPanel
          slug={helpSlug}
          anchor={helpAnchor}
          onNavigate={selectHelpPage}
          onClose={closeHelp}
        />
      ) : null}

      {terminalOpen && terminalAvailable ? (
        <Suspense fallback={null}>
          <TerminalPanel
            maximized={terminalMaximized}
            onToggleMaximize={() => setTerminalMaximized((value) => !value)}
            onClose={() => {
              setTerminalOpen(false);
              setTerminalMaximized(false);
            }}
            onError={setError}
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
