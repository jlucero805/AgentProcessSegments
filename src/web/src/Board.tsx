import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, describeError } from './api';
import {
  AGENT_BADGE,
  COLUMNS,
  COLUMN_LABELS,
  COLUMN_STATE,
  canTransition,
  columnOf,
  timeAgo,
  type Column,
  type IndexAllResult,
  type IndexAllSkipReason,
  type Request,
} from './types';
import { Spinner, cn } from './ui';

interface BoardProps {
  cellId: string | null;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
}

const QUERIES: Record<Column, Record<string, string>> = {
  intake: { view: 'intake' },
  clarify: { state: 'clarify' },
  dispatch: { state: 'dispatch' },
  review: { state: 'review' },
  merge: { state: 'merge' },
  finalize: { state: 'finalize' },
};

const INDEX_ALL_SKIP_LABELS: Record<IndexAllSkipReason, string> = {
  not_finalize: 'no longer in Finalize',
  working: 'still working',
  no_digest: 'no digest',
};

function describeIndexAll(result: IndexAllResult): { text: string; detail: string } {
  const parts = [`Indexed ${result.indexed}`, `closed ${result.closed}`];
  if (result.skipped.length > 0) {
    const reasons = [...new Set(result.skipped.map((item) => INDEX_ALL_SKIP_LABELS[item.reason]))];
    parts.push(`${result.skipped.length} skipped (${reasons.join(', ')})`);
  }
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);

  const detail = [
    ...result.skipped.map((item) => `${item.title}: ${INDEX_ALL_SKIP_LABELS[item.reason]}`),
    ...result.failed.map((item) => `${item.title}: ${item.message}`),
  ].join('\n');

  return { text: parts.join(' · '), detail };
}

/**
 * The request board. Columns map to workflow segments; cards move forward one
 * step at a time. Anything more involved belongs in the detail drawer.
 */
export function Board({ cellId, onOpen, onError }: BoardProps) {
  const [requests, setRequests] = useState<Map<string, Request>>(new Map());
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Column | null>(null);
  const [indexAllPending, setIndexAllPending] = useState(false);
  const [indexAllBusy, setIndexAllBusy] = useState(false);
  const [indexAllNotice, setIndexAllNotice] = useState<{
    text: string;
    detail: string;
  } | null>(null);
  const dragRef = useRef<{ id: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const lists = await Promise.all(COLUMNS.map((column) => api.getRequests(QUERIES[column])));
      const next = new Map<string, Request>();
      for (const list of lists) for (const request of list) next.set(request.id, request);
      setRequests(next);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // A different cell is a different batch. Do not carry a confirmation or a
  // result notice across the filter change.
  useEffect(() => {
    setIndexAllPending(false);
    setIndexAllNotice(null);
  }, [cellId]);

  useEffect(() => {
    if (!indexAllPending) return;
    const timer = window.setTimeout(() => setIndexAllPending(false), 4000);
    return () => window.clearTimeout(timer);
  }, [indexAllPending]);

  async function runIndexAll() {
    setIndexAllPending(false);
    setIndexAllBusy(true);
    setIndexAllNotice(null);
    try {
      const result = await api.indexAll(cellId ?? undefined);
      setIndexAllNotice(describeIndexAll(result));
      if (result.failed.length > 0) {
        onError(result.failed.map((item) => `${item.title}: ${item.message}`).join('; '));
      }
      await load();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setIndexAllBusy(false);
    }
  }

  // While an agent is working, refresh so its status and state stay current.
  const anyWorking = useMemo(
    () => [...requests.values()].some((request) => request.agentStatus === 'working'),
    [requests],
  );
  useEffect(() => {
    if (!anyWorking) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [anyWorking, load]);

  const visible = useMemo(() => {
    const all = [...requests.values()];
    const filtered = cellId ? all.filter((request) => request.cellId === cellId) : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [requests, cellId]);

  const byColumn = useCallback(
    (column: Column) => visible.filter((request) => columnOf(request) === column),
    [visible],
  );

  const move = useCallback(
    async (id: string, target: Column) => {
      const request = requests.get(id);
      if (!request) return;
      if (columnOf(request) === target) return;

      const targetState = COLUMN_STATE[target];
      const startsClarify = target === 'clarify' && request.state === 'clarify';
      if (targetState === null || (!startsClarify && !canTransition(request.state, targetState))) {
        onError('That move is not allowed. Use the detail drawer for other moves.');
        return;
      }

      try {
        if (target === 'clarify') {
          if (startsClarify) await api.startClarify(id);
          else await api.transition(id, 'clarify');
        } else if (target === 'dispatch') {
          await api.kickoffDispatch(id);
        } else if (target === 'review') {
          await api.transition(id, 'review');
        } else if (target === 'merge') {
          await api.transition(id, 'merge');
        } else if (target === 'finalize') {
          await api.kickoffFinalize(id);
        } else {
          onError('Cards move forward one step at a time. Use the detail drawer for other moves.');
          return;
        }
        await load();
      } catch (error) {
        onError(describeError(error));
        await load();
      }
    },
    [requests, load, onError],
  );

  function startDrag(event: DragEvent<HTMLButtonElement>, request: Request) {
    event.dataTransfer.setData('text/plain', request.id);
    event.dataTransfer.effectAllowed = 'move';
    dragRef.current = { id: request.id };
    setDragging(request.id);
  }

  function endDrag() {
    setDragging(null);
    setOver(null);
    dragRef.current = null;
  }

  function drop(event: DragEvent<HTMLDivElement>, column: Column) {
    event.preventDefault();
    const id = dragRef.current?.id ?? event.dataTransfer.getData('text/plain');
    endDrag();
    if (id) void move(id, column);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading the floor...
      </div>
    );
  }

  return (
    <div className="flex h-full snap-x snap-mandatory gap-3 overflow-x-auto p-3 md:grid md:grid-cols-6 md:gap-3 md:overflow-visible md:p-4">
      {COLUMNS.map((column) => {
        const cards = byColumn(column);
        return (
          <div
            key={column}
            data-testid={`column-${column}`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setOver(column);
            }}
            onDragLeave={() => setOver((current) => (current === column ? null : current))}
            onDrop={(event) => drop(event, column)}
            className={cn(
              'flex min-h-0 min-w-[85vw] snap-start flex-col rounded-xl border border-transparent bg-zinc-900/20 p-2 transition-colors md:min-w-0',
              over === column && 'border-zinc-700 bg-zinc-900/50',
            )}
          >
            <header className="flex flex-wrap items-center justify-between gap-1 px-1 pb-2 pt-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                  {COLUMN_LABELS[column]}
                </span>
                {column === 'finalize' ? (
                  <button
                    type="button"
                    aria-label={
                      indexAllPending ? 'Confirm index all' : 'Index all finalize requests'
                    }
                    title={
                      cards.length === 0
                        ? 'No requests in Finalize'
                        : indexAllPending
                          ? 'Click again within 4 seconds to index and close every ready request'
                          : `Index and close ${cards.length} request${cards.length === 1 ? '' : 's'} in Finalize`
                    }
                    disabled={cards.length === 0 || indexAllBusy}
                    onClick={() => {
                      if (indexAllBusy || cards.length === 0) return;
                      if (indexAllPending) void runIndexAll();
                      else setIndexAllPending(true);
                    }}
                    className="rounded-md bg-white px-1.5 py-0.5 text-[10px] font-semibold text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {indexAllBusy
                      ? 'Indexing…'
                      : indexAllPending
                        ? 'Confirm index all?'
                        : 'Index all'}
                  </button>
                ) : null}
              </div>
              <span className="text-[11px] tabular-nums text-zinc-600">{cards.length}</span>
            </header>
            {column === 'finalize' && indexAllNotice ? (
              <p
                role="status"
                aria-live="polite"
                title={indexAllNotice.detail || undefined}
                className="px-1 pb-2 text-[10px] leading-snug text-zinc-400"
              >
                {indexAllNotice.text}
              </p>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
              {cards.length === 0 ? (
                <p className="py-6 text-center text-[11px] text-zinc-700">empty</p>
              ) : (
                cards.map((request) => (
                  <button
                    key={request.id}
                    type="button"
                    draggable
                    onDragStart={(event) => startDrag(event, request)}
                    onDragEnd={endDrag}
                    onClick={() => onOpen(request.id)}
                    className={cn(
                      'cursor-grab rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-800/70',
                      dragging === request.id && 'opacity-50',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm leading-snug text-zinc-200">
                        {request.title}
                      </p>
                      {request.unchecked ? (
                        <span
                          className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                          title="The agent finished; open the request"
                        />
                      ) : null}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10px]">
                      <span className={AGENT_BADGE[request.agentStatus].className}>
                        {AGENT_BADGE[request.agentStatus].label}
                      </span>
                      <span className="text-zinc-600">{timeAgo(request.updatedAt)}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
