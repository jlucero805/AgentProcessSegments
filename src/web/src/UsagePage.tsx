import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { formatCost, formatTokens } from './usageFormat';
import {
  Card,
  EmptyState,
  SectionTitle,
  Select,
  Spinner,
} from './ui';
import type {
  CellDetail,
  UsageBucket,
  UsageGroup,
  UsageResponse,
  UsageTotals,
} from './types';
import { USAGE_BUCKET_MS } from './types';

type RangeKey = '24h' | '7d' | '30d' | 'all';

const RANGES: Array<{ key: RangeKey; label: string; ms: number | null }> = [
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'All time', ms: null },
];

function bucketLabel(timestamp: number, bucket: UsageBucket): string {
  const date = new Date(timestamp);
  return bucket === 'hour'
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function rangeQuery(range: RangeKey): {
  from?: number;
  to?: number;
  bucket?: UsageBucket;
} {
  const option = RANGES.find((item) => item.key === range);
  if (!option?.ms) return { bucket: 'day' };
  const to = Date.now();
  return {
    from: to - option.ms,
    to,
    bucket: range === '24h' ? 'hour' : 'day',
  };
}

function BreakdownTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: UsageGroup[];
  empty: string;
}) {
  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-600">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-zinc-600">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 text-right font-medium">Cost</th>
                <th className="pb-2 text-right font-medium">Tokens</th>
                <th className="pb-2 text-right font-medium">Turns</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {rows.map((row) => (
                <tr key={row.key || row.label}>
                  <td className="max-w-[18rem] truncate py-2 pr-3 text-zinc-300" title={row.label}>
                    {row.label}
                  </td>
                  <td className="py-2 text-right text-zinc-400">{formatCost(row)}</td>
                  <td className="py-2 text-right text-zinc-400">
                    {formatTokens(row.totalTokens)}
                  </td>
                  <td className="py-2 text-right text-zinc-500">{row.turns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CostChart({ data }: { data: UsageResponse }) {
  const step =
    data.series.length > 1
      ? (data.series[1]?.bucketStart ?? 0) - (data.series[0]?.bucketStart ?? 0)
      : 0;
  const chartBucket: UsageBucket =
    step > 0 && step < USAGE_BUCKET_MS.day ? 'hour' : 'day';
  const max = Math.max(0, ...data.series.map((row) => row.costUsd ?? 0));
  const totals = data.series.reduce(
    (sum, row) => ({
      turns: sum.turns + row.turns,
      unknown: sum.unknown + row.unknownCostTurns,
    }),
    { turns: 0, unknown: 0 },
  );

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle>Cost over time</SectionTitle>
          <p className="mt-1 text-[11px] text-zinc-600">
            Harness-reported cost. Buckets without a reported price are not drawn as zero.
          </p>
        </div>
        <span className="text-xs text-zinc-500">{formatCost(data.totals)}</span>
      </div>
      {data.series.length === 0 || (max === 0 && totals.turns === 0) ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-600">
          No turns in this range.
        </div>
      ) : (
        <>
          <div className="flex h-40 items-end gap-1 border-b border-zinc-800 pb-1">
            {data.series.map((row) => {
              const height = max > 0 ? ((row.costUsd ?? 0) / max) * 100 : 0;
              const unknown = row.costUsd === null && row.turns > 0;
              return (
                <div
                  key={row.bucketStart}
                  className="group relative min-w-[2px] flex-1"
                  title={`${bucketLabel(row.bucketStart, chartBucket)}: ${
                    row.costUsd === null ? 'cost unknown' : `$${row.costUsd.toFixed(4)}`
                  } · ${formatTokens(row.totalTokens)} tokens · ${row.turns} turns`}
                >
                  <div
                    className={
                      unknown
                        ? 'w-full rounded-t-sm bg-amber-700/50'
                        : 'w-full rounded-t-sm bg-emerald-600/70 group-hover:bg-emerald-500'
                    }
                    style={{ height: unknown ? '4px' : `${Math.max(height, 2)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-zinc-600">
            <span>{bucketLabel(data.series[0]?.bucketStart ?? 0, chartBucket)}</span>
            <span>
              {totals.unknown > 0
                ? `${totals.unknown} unpriced turn${totals.unknown === 1 ? '' : 's'}`
                : `${formatTokens(data.totals.totalTokens)} tokens`}
            </span>
            <span>
              {bucketLabel(
                data.series[data.series.length - 1]?.bucketStart ?? 0,
                chartBucket,
              )}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

function Summary({ totals }: { totals: UsageTotals }) {
  const cards = [
    { label: 'Known cost', value: formatCost(totals), hint: 'reported by the harness' },
    { label: 'Total tokens', value: formatTokens(totals.totalTokens), hint: 'input + output + cache' },
    { label: 'Turns', value: String(totals.turns), hint: 'completed agent turns' },
    {
      label: 'Unpriced turns',
      value: String(totals.unknownCostTurns),
      hint: 'cost shown as unknown',
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label} className="space-y-1 p-3">
          <p className="text-[10px] uppercase tracking-wide text-zinc-600">{card.label}</p>
          <p className="truncate text-lg font-semibold text-zinc-100" title={card.value}>
            {card.value}
          </p>
          <p className="text-[10px] text-zinc-600">{card.hint}</p>
        </Card>
      ))}
    </div>
  );
}

export function UsagePage({ onError }: { onError: (message: string) => void }) {
  const [range, setRange] = useState<RangeKey>('30d');
  const [cellId, setCellId] = useState('');
  const [cells, setCells] = useState<CellDetail[]>([]);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    api
      .getCells()
      .then((list) => {
        if (mounted) setCells(list);
      })
      .catch((error) => {
        if (mounted) onError(describeError(error));
      });
    return () => {
      mounted = false;
    };
  }, [onError]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = rangeQuery(range);
      const result = await api.getUsage({
        ...query,
        ...(cellId ? { cellId } : {}),
      });
      setData(result);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [cellId, onError, range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto h-full w-full max-w-5xl space-y-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Usage</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Token and cost spend across requests, cells, and every agent session. Cost comes
            from the harness; an unpriced turn stays unknown instead of becoming zero.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-zinc-800 p-0.5">
            {RANGES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setRange(option.key)}
                className={
                  range === option.key
                    ? 'rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100'
                    : 'rounded-md px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <Select
            aria-label="Filter usage by cell"
            value={cellId}
            onChange={(event) => setCellId(event.target.value)}
          >
            <option value="">All cells</option>
            {cells.map((cell) => (
              <option key={cell.id} value={cell.id}>
                {cell.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex h-40 items-center justify-center gap-2 text-sm text-zinc-500">
          <Spinner /> Loading usage...
        </div>
      ) : data ? (
        <>
          <Summary totals={data.totals} />
          <CostChart data={data} />
          {data.totals.turns === 0 ? (
            <EmptyState
              title="No usage in this range"
              hint="Completed agent turns appear here after the harness reports usage."
            />
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-2">
                <BreakdownTable
                  title="By model"
                  rows={data.byModel}
                  empty="No models reported usage."
                />
                <BreakdownTable
                  title="By cell"
                  rows={data.byCell}
                  empty="No cells reported usage."
                />
              </div>
              <BreakdownTable
                title="Top requests"
                rows={data.byRequest}
                empty="No request turns in this range."
              />
            </>
          )}
          {loading ? (
            <p className="flex items-center gap-2 text-[11px] text-zinc-600">
              <Spinner /> Refreshing...
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
