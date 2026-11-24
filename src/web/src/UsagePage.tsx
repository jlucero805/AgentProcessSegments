import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { costBreakdown, formatCost, formatTokens, formatUsd } from './usageFormat';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  Select,
  Spinner,
} from './ui';
import type {
  BudgetStatus,
  CellDetail,
  UsageBucket,
  UsageCoverage,
  UsageGroup,
  UsageResponse,
  UsageTotals,
} from './types';
import { SpendOverrideControl, overrideExpiryLabel } from './SpendOverrideControl';
import type { BudgetFeed } from './useBudgets';
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

/**
 * Explain how much history is raw versus daily, and how far back raw rows are
 * kept. The coverage rides on the usage payload so a config outage cannot
 * hide the retention window.
 */
function coverageNote({ rolledThrough, retentionDays }: UsageCoverage): string {
  if (rolledThrough !== null) {
    const day = new Date(rolledThrough).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return retentionDays === 0
      ? `Daily totals preserve history before ${day}; raw turns are kept from ${day} onward. All raw turns are kept indefinitely.`
      : `Daily totals preserve history before ${day}; raw turns are kept from ${day} onward. Raw retention is ${retentionDays} days.`;
  }
  return retentionDays === 0
    ? 'Usage history is kept indefinitely.'
    : `Raw usage is kept for ${retentionDays} days; older turns are pruned. All-time totals cover the retained window.`;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function moneyLabel(value: number): string {
  return money.format(value);
}

function budgetTone(status: BudgetStatus): 'neutral' | 'green' | 'amber' | 'red' {
  if (status.state === 'exceeded') return 'red';
  if (status.state === 'warning') return 'amber';
  if (status.state === 'unknown') return 'neutral';
  return 'green';
}

function BudgetSummary({ feed }: { feed: BudgetFeed }) {
  const { budgets, error, loading, refresh, acknowledge: onAck } = feed;
  const retry = (
    <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={loading}>
      {loading ? 'Retrying…' : 'Retry'}
    </Button>
  );

  if (!budgets) {
    if (!error) return null;
    return (
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <SectionTitle>Monthly budgets</SectionTitle>
            <p className="mt-1 text-[11px] text-zinc-600">Current UTC month</p>
          </div>
          {retry}
        </div>
        <div
          role="alert"
          className="space-y-1 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200"
        >
          <p className="font-medium">Couldn&apos;t load budgets.</p>
          <p className="break-words text-[11px] text-red-300/80">{error}</p>
        </div>
        <p className="text-[11px] text-zinc-600">
          Usage above is unaffected. Retry to load budget status.
        </p>
      </Card>
    );
  }

  const month = new Date(budgets.periodStart).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <SectionTitle>Monthly budgets</SectionTitle>
          <p className="mt-1 text-[11px] text-zinc-600">
            {month} (UTC) · alerts use reported cost; pause-on-exceeded caps also count
            estimates, and strict caps pause while any turn is unpriced.
          </p>
        </div>
        <span className="text-xs text-zinc-500">warning at {budgets.alertAtPercent}%</span>
      </div>

      {error ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200"
        >
          <span>Couldn&apos;t refresh budgets; showing the last successful update.</span>
          {retry}
        </div>
      ) : null}

      {budgets.statuses.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No budgets configured. Set an overall budget in Config or edit a cell.
        </p>
      ) : (
        <div className="space-y-2">
          {budgets.statuses.map((status) => (
            <div
              key={`${status.scope}:${status.cellId ?? ''}`}
              className="space-y-1.5 rounded-lg border border-zinc-800 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-zinc-300">{status.label}</span>
                <div className="flex items-center gap-2">
                  {status.paused ? (
                    <Badge tone={status.overrideId ? 'amber' : 'red'}>
                      {status.overrideId ? 'snoozed' : 'paused'}
                    </Badge>
                  ) : null}
                  <Badge tone={budgetTone(status)}>{status.state}</Badge>
                </div>
              </div>
              {status.state === 'unknown' ? (
                <p className="text-[11px] text-zinc-500">
                  Spend unknown
                  {status.unknownCostTurns > 0
                    ? ` · ${status.unknownCostTurns} unpriced turn${status.unknownCostTurns === 1 ? '' : 's'}`
                    : ''}
                </p>
              ) : (
                <>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={
                        status.state === 'exceeded'
                          ? 'h-full rounded-full bg-red-500'
                          : status.state === 'warning'
                            ? 'h-full rounded-full bg-amber-400'
                            : 'h-full rounded-full bg-emerald-500'
                      }
                      style={{
                        width: `${Math.min(100, Math.max(0, status.percentUsed))}%`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    {status.spendIsLowerBound ? 'At least ' : ''}
                    {moneyLabel(status.spendUsd)} of {moneyLabel(status.budgetUsd)} ·{' '}
                    {status.percentUsed.toFixed(0)}% used · {moneyLabel(status.remainingUsd)}{' '}
                    remaining
                  </p>
                </>
              )}
              {status.paused ? (
                <p
                  className={
                    status.overrideId ? 'text-[11px] text-amber-300' : 'text-[11px] text-red-300'
                  }
                >
                  {status.pauseReason === 'unknown_cost' ? (
                    status.overrideId ? (
                      <>
                        Cost is unknown: {status.unpricedTurns} unpriced turn
                        {status.unpricedTurns === 1 ? '' : 's'}, so cost cannot be verified;
                        an override is admitting new work until{' '}
                        {overrideExpiryLabel(status.overrideExpiresAt ?? status.periodEnd)}.
                      </>
                    ) : (
                      <>
                        Paused: {status.unpricedTurns} unpriced turn
                        {status.unpricedTurns === 1 ? '' : 's'}, so cost cannot be verified.
                        New work is refused and in-flight turns were stopped. Add a matching
                        price, clear the budget, or turn off strict pause.
                      </>
                    )
                  ) : status.overrideId ? (
                    <>
                      Cap reached; an override is admitting new work until{' '}
                      {overrideExpiryLabel(status.overrideExpiresAt ?? status.periodEnd)} at{' '}
                      {moneyLabel(status.capSpendUsd)} cap spend
                      {status.capSpendIsLowerBound ? ' (lower bound)' : ''}.
                    </>
                  ) : (
                    <>
                      Paused: new work is refused and in-flight turns were stopped at{' '}
                      {moneyLabel(status.capSpendUsd)} cap spend
                      {status.capSpendIsLowerBound ? ' (lower bound)' : ''}.
                    </>
                  )}
                </p>
              ) : null}
              {status.paused ? (
                <SpendOverrideControl
                  label={
                    status.scope === 'overall'
                      ? 'overall spend'
                      : `${status.cellName ?? 'cell'} spend`
                  }
                  paused
                  overrideId={status.overrideId}
                  overrideExpiresAt={status.overrideExpiresAt}
                  periodEnd={status.periodEnd}
                  onSnooze={(minutes) =>
                    feed.snooze({
                      scope: status.scope,
                      ...(status.cellId === null ? {} : { cellId: status.cellId }),
                      minutes,
                    })
                  }
                  onRevoke={feed.revokeOverride}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}

      {budgets.alerts.length > 0 ? (
        <div className="space-y-1 border-t border-zinc-800 pt-2">
          {budgets.alerts.map((alert) => (
            <div key={alert.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-amber-300">
                {alert.scope === 'overall' ? 'Overall' : alert.cellName ?? 'Cell'} budget{' '}
                {alert.threshold} ({moneyLabel(alert.spendUsd)} of{' '}
                {moneyLabel(alert.budgetUsd)})
              </span>
              <button
                type="button"
                className="text-zinc-500 hover:text-zinc-200"
                aria-label={`Dismiss budget alert for ${alert.scope === 'overall' ? 'overall spend' : alert.cellName ?? 'cell'}`}
                onClick={() => onAck(alert)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function BreakdownTable({
  title,
  rows,
  empty,
  showCell = false,
}: {
  title: string;
  rows: UsageGroup[];
  empty: string;
  showCell?: boolean;
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
                {showCell ? <th className="pb-2 font-medium">Cell</th> : null}
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
                  {showCell ? (
                    <td
                      className="max-w-[12rem] truncate py-2 pr-3 text-zinc-500"
                      title={row.cellLabel ?? 'Unassigned'}
                    >
                      {row.cellLabel ?? '—'}
                    </td>
                  ) : null}
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
  const max = Math.max(0, ...data.series.map((row) => row.totalCostUsd ?? 0));
  const totals = data.series.reduce(
    (sum, row) => ({
      turns: sum.turns + row.turns,
      unpriced: sum.unpriced + row.unpricedTurns,
    }),
    { turns: 0, unpriced: 0 },
  );

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle>Cost over time</SectionTitle>
          <p className="mt-1 text-[11px] text-zinc-600">
            Reported by the harness plus effective-dated estimates. Unpriced turns are
            marked, never drawn as zero.
          </p>
        </div>
        <div className="text-right">
          <span className="text-xs text-zinc-500">{formatCost(data.totals)}</span>
          <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-zinc-600">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-emerald-600/70" /> reported
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-sky-600/70" /> estimated
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-amber-600/70" /> unpriced
            </span>
          </div>
        </div>
      </div>
      {data.series.length === 0 || (max === 0 && totals.turns === 0) ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-600">
          No turns in this range.
        </div>
      ) : (
        <>
          <div className="flex h-40 items-end gap-1 border-b border-zinc-800 pb-1">
            {data.series.map((row) => {
              const reported = row.costUsd ?? 0;
              const estimated = row.estimatedCostUsd ?? 0;
              const effective = reported + estimated;
              const height = max > 0 ? (effective / max) * 100 : 0;
              const reportedShare = effective > 0 ? (reported / effective) * 100 : 0;
              const estimatedShare = effective > 0 ? (estimated / effective) * 100 : 0;
              const unpriced = row.unpricedTurns > 0;
              const title = `${bucketLabel(row.bucketStart, chartBucket)}: ${
                row.totalCostUsd === null ? 'cost unknown' : formatUsd(row.totalCostUsd)
              } · ${formatUsd(reported)} reported · ${formatUsd(estimated)} estimated · ${
                row.unpricedTurns
              } unpriced · ${formatTokens(row.totalTokens)} tokens · ${row.turns} turns`;
              return (
                <div
                  key={row.bucketStart}
                  className="group relative min-w-[2px] flex-1"
                  title={title}
                >
                  {effective === 0 ? (
                    <div
                      className={
                        unpriced
                          ? 'h-1 w-full rounded-t-sm bg-amber-700/60'
                          : 'h-1 w-full rounded-t-sm bg-zinc-700'
                      }
                    />
                  ) : (
                    <div
                      className={`flex w-full flex-col justify-end overflow-hidden rounded-t-sm ${
                        unpriced ? 'border-t-2 border-amber-500/70' : ''
                      }`}
                      style={{ height: `${Math.max(height, 2)}%` }}
                    >
                      <div
                        className="w-full bg-sky-600/70 group-hover:bg-sky-500"
                        style={{ height: `${estimatedShare}%` }}
                      />
                      <div
                        className="w-full bg-emerald-600/70 group-hover:bg-emerald-500"
                        style={{ height: `${reportedShare}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-zinc-600">
            <span>{bucketLabel(data.series[0]?.bucketStart ?? 0, chartBucket)}</span>
            <span>
              {totals.unpriced > 0
                ? `${totals.unpriced} unpriced turn${totals.unpriced === 1 ? '' : 's'}`
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
  const breakdown = costBreakdown(totals);
  const cards = [
    {
      label: 'Effective cost',
      value: formatCost(totals),
      hint:
        breakdown ||
        (totals.turns === 0 ? 'no turns in range' : 'no reported or estimated cost'),
    },
    { label: 'Total tokens', value: formatTokens(totals.totalTokens), hint: 'input + output + cache + reasoning' },
    { label: 'Turns', value: String(totals.turns), hint: 'completed agent turns' },
    {
      label: 'Unpriced turns',
      value: String(totals.unpricedTurns),
      hint: 'reported and estimate both missing',
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

export function UsagePage({
  onError,
  budgetFeed,
}: {
  onError: (message: string) => void;
  budgetFeed: BudgetFeed;
}) {
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
            Token and cost spend across requests, cells, and every agent session. Reported
            cost comes from the harness; an unreported turn uses an effective-dated model
            price when one exists. Anything still unpriced stays unknown, never zero. Prices
            are managed in <span className="text-zinc-300">Config</span>.
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
          <p className="text-[11px] text-zinc-600">{coverageNote(data.coverage)}</p>
          <BudgetSummary feed={budgetFeed} />
          <CostChart data={data} />
          {data.totals.turns === 0 ? (
            <EmptyState
              title="No usage in this range"
              hint="Completed agent turns appear here after the harness reports usage; unreported costs become estimates when a model price is effective."
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
                showCell
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
