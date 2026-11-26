import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import { overrideExpiryLabel } from './SpendOverrideControl';
import type {
  Cell,
  SpendCapOverrideHistoryItem,
  SpendCapOverrideHistoryResponse,
  SpendCapOverrideState,
} from './types';
import { Badge, Button, Select, cn } from './ui';

const PAGE_SIZE = 10;

const periodLabel = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const STATE_TONES = {
  active: 'amber',
  revoked: 'neutral',
  expired: 'red',
} as const;

function absolute(value: number | null): string {
  return value === null ? '—' : overrideExpiryLabel(value);
}

function isoTitle(value: number | null): string | undefined {
  return value === null ? undefined : new Date(value).toISOString();
}

/**
 * Read-only history of retained spend-cap overrides. The card fetches its own
 * snapshot so the shared budget poll and the live pause controls stay unchanged.
 */
export function SpendOverrideHistory({
  cells,
  refreshToken = 0,
  onError,
}: {
  cells: Array<Pick<Cell, 'id' | 'name'>>;
  refreshToken?: number;
  onError: (message: string) => void;
}) {
  const [history, setHistory] = useState<SpendCapOverrideHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState('');
  const [state, setState] = useState<'' | SpendCapOverrideState>('');
  const [offset, setOffset] = useState(0);
  const [seenToken, setSeenToken] = useState(refreshToken);

  const alive = useRef(true);
  const requestId = useRef(0);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  if (seenToken !== refreshToken) {
    setSeenToken(refreshToken);
    if (offset !== 0) setOffset(0);
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (nextOffset: number): Promise<void> => {
      const current = ++requestId.current;
      if (alive.current) setLoading(true);
      try {
        const response = await api.getBudgetOverrideHistory({
          ...(scope === '' ? {} : { scope: scope === 'overall' ? 'overall' : 'cell' }),
          ...(scope === '' || scope === 'overall' ? {} : { cellId: scope }),
          ...(state === '' ? {} : { state }),
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        if (!alive.current || current !== requestId.current) return;
        if (!response || !Array.isArray(response.overrides)) {
          throw new Error('Override history response was malformed.');
        }
        setHistory(response);
        setError(null);
      } catch (caught) {
        if (alive.current && current === requestId.current) {
          const message = describeError(caught);
          setError(message);
          onErrorRef.current(message);
        }
      } finally {
        if (alive.current && current === requestId.current) setLoading(false);
      }
    },
    [scope, state],
  );

  useEffect(() => {
    void (async () => {
      await load(offset);
    })();
  }, [load, offset, refreshToken]);

  const cellName = (item: SpendCapOverrideHistoryItem): string => {
    if (item.scope === 'overall') return 'Overall spend';
    return cells.find((cell) => cell.id === item.cellId)?.name ?? item.cellName ?? 'Deleted cell';
  };

  const hasFilters = scope !== '' || state !== '';
  const total = history?.total ?? 0;
  const from = history && history.overrides.length > 0 ? history.offset + 1 : 0;
  const to = history ? history.offset + history.overrides.length : 0;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Read-only history of hard-cap snoozes across retained UTC months. Active means the
        window is still open; the Spend budgets status above shows whether that scope is
        currently paused. History is kept for 400 days.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-[11px] text-zinc-500">
          <span>Scope</span>
          <Select
            aria-label="Override scope filter"
            className="w-full"
            value={scope}
            disabled={loading}
            onChange={(event) => {
              setScope(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All scopes</option>
            <option value="overall">Overall</option>
            {cells.map((cell) => (
              <option key={cell.id} value={cell.id}>
                {cell.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-[11px] text-zinc-500">
          <span>State</span>
          <Select
            aria-label="Override state filter"
            className="w-full"
            value={state}
            disabled={loading}
            onChange={(event) => {
              setState(event.target.value as '' | SpendCapOverrideState);
              setOffset(0);
            }}
          >
            <option value="">All states</option>
            <option value="active">Active</option>
            <option value="revoked">Revoked</option>
            <option value="expired">Expired</option>
          </Select>
        </label>
      </div>

      {error && history === null ? (
        <p className="text-sm text-red-300">Could not load override history.</p>
      ) : loading && history === null ? (
        <p className="text-sm text-zinc-500">Loading override history…</p>
      ) : history && history.overrides.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {hasFilters ? 'No overrides match these filters.' : 'No override history yet.'}
        </p>
      ) : history ? (
        <div className="overflow-x-auto">
          <table aria-label="Spend cap override history" className="w-full min-w-[52rem] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-zinc-600">
              <tr>
                <th className="pb-2 font-medium">Scope</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 font-medium">Period</th>
                <th className="pb-2 font-medium">Granted</th>
                <th className="pb-2 font-medium">Extended</th>
                <th className="pb-2 font-medium">Expires</th>
                <th className="pb-2 font-medium">Revoked</th>
                <th className="pb-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {history.overrides.map((item) => (
                <tr key={item.id}>
                  <td className="py-2 pr-3 text-zinc-300">{cellName(item)}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={STATE_TONES[item.state]}>{item.state}</Badge>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-zinc-400">
                    {periodLabel.format(item.periodStart)}
                  </td>
                  <td
                    className="whitespace-nowrap py-2 pr-3 text-zinc-400"
                    title={isoTitle(item.createdAt)}
                  >
                    {overrideExpiryLabel(item.createdAt)}
                  </td>
                  <td
                    className={cn(
                      'whitespace-nowrap py-2 pr-3',
                      item.extensionCount > 0 ? 'text-amber-300' : 'text-zinc-600',
                    )}
                    title={isoTitle(item.lastExtendedAt)}
                  >
                    {item.extensionCount > 0
                      ? `${absolute(item.lastExtendedAt)} ×${item.extensionCount}`
                      : '—'}
                  </td>
                  <td
                    className="whitespace-nowrap py-2 pr-3 text-zinc-400"
                    title={isoTitle(item.expiresAt)}
                  >
                    {overrideExpiryLabel(item.expiresAt)}
                  </td>
                  <td
                    className="whitespace-nowrap py-2 pr-3 text-zinc-400"
                    title={isoTitle(item.revokedAt)}
                  >
                    {absolute(item.revokedAt)}
                  </td>
                  <td
                    className="max-w-[16rem] truncate py-2 pr-3 text-zinc-500"
                    title={item.note ?? ''}
                  >
                    {item.note ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3 text-[11px] text-zinc-500">
        <span>
          {history && history.total > 0
            ? `Showing ${from}–${to} of ${history.total}`
            : 'No overrides'}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            aria-label="Newer override history"
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Newer
          </Button>
          <Button
            size="sm"
            aria-label="Older override history"
            disabled={loading || !history || to >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Older
          </Button>
          <Button
            size="sm"
            aria-label="Refresh override history"
            disabled={loading}
            onClick={() => void load(offset)}
          >
            Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}
