import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, describeError, streamNdjson } from './api';
import {
  AGENT_BADGE,
  COLUMNS,
  COLUMN_LABELS,
  columnOf,
  timeAgo,
  type Column,
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
  finalize: { state: 'finalize' },
};

/**
 * The request board. Columns map to workflow segments; cards move forward one
 * step at a time. Anything more involved belongs in the detail drawer.
 */
export function Board({ cellId, onOpen, onError }: BoardProps) {
  const [requests, setRequests] = useState<Map<string, Request>>(new Map());
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Column | null>(null);
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

      try {
        if (target === 'clarify') {
          if (columnOf(request) === 'intake') {
            await api.startClarify(id);
          } else {
            await api.transition(id, 'clarify');
          }
        } else if (target === 'dispatch') {
          await streamNdjson(
            `/api/requests/${encodeURIComponent(id)}/dispatch`,
            () => {},
            { method: 'POST' },
          );
        } else if (target === 'review') {
          await api.transition(id, 'review');
        } else if (target === 'finalize') {
          await streamNdjson(
            `/api/requests/${encodeURIComponent(id)}/finalize`,
            () => {},
            { method: 'POST' },
          );
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
    <div className="grid h-full grid-cols-5 gap-3 p-4">
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
              'flex min-h-0 flex-col rounded-xl border border-transparent bg-zinc-900/20 p-2 transition-colors',
              over === column && 'border-zinc-700 bg-zinc-900/50',
            )}
          >
            <header className="flex items-center justify-between px-1 pb-2 pt-1">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                {COLUMN_LABELS[column]}
              </span>
              <span className="text-[11px] tabular-nums text-zinc-600">{cards.length}</span>
            </header>
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
