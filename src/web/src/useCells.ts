import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import type { CellDetail } from './types';

export interface CellsFeed {
  /** Last successful list; kept while a refresh is failing. */
  cells: CellDetail[];
  /** True once a list has loaded successfully. A failed refresh does not clear it. */
  loaded: boolean;
  /** Why the most recent load failed, or null after a success. */
  error: string | null;
  /** Force a read. A newer call supersedes an older in-flight response. */
  reload: () => Promise<void>;
  /** Apply a PATCH or create response: replace by id, or append. */
  upsert: (cell: CellDetail) => void;
  /** Drop a cell after a successful DELETE, before the refresh lands. */
  remove: (id: string) => void;
}

/**
 * The SPA's one cell list. The sidebar, Config, Usage, Scorecards, the cell
 * master drawer, and the request drawer read this snapshot, so a sidebar
 * create, delete, or save is visible everywhere without a per-page fetch.
 */
export function useCells(onError: (message: string) => void): CellsFeed {
  const [cells, setCells] = useState<CellDetail[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // Keep the parent's callback current without making the mount load depend on
  // an inline function's identity.
  const onErrorRef = useRef(onError);
  // A reload forced after a mutation must win over a load that started before
  // it, or the stale response could put a deleted cell back in the list.
  const generation = useRef(0);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const reload = useCallback(async (): Promise<void> => {
    const startedAt = ++generation.current;
    try {
      const next = await api.getCells();
      if (!alive.current || startedAt !== generation.current) return;
      setCells(next);
      setLoaded(true);
      setError(null);
    } catch (caught) {
      if (!alive.current || startedAt !== generation.current) return;
      const message = describeError(caught);
      setError(message);
      onErrorRef.current(message);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      await reload();
    })();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const upsert = useCallback((cell: CellDetail) => {
    setCells((current) => {
      const index = current.findIndex((item) => item.id === cell.id);
      if (index === -1) return [...current, cell];
      const next = current.slice();
      next[index] = cell;
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setCells((current) => current.filter((cell) => cell.id !== id));
  }, []);

  return { cells, loaded, error, reload, upsert, remove };
}
