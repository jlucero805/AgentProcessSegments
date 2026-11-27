import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import { Scorecard } from './Scorecard';
import type { Summary, SummaryCellRef, SummaryStatus } from './types';
import { timeAgo } from './types';
import { Button, Card, EmptyState, SectionTitle, Spinner } from './ui';

interface ScorecardGroup {
  cell: SummaryCellRef;
  reports: Summary[];
  /** More reports exist in the selected period below the oldest one shown. */
  hasMore: boolean;
  loadingMore: boolean;
}

type RangeKey = '24h' | '72h' | '7d' | '30d' | 'all';

const RANGES: Array<{ key: RangeKey; label: string; spellout: string; ms: number | null }> = [
  { key: '24h', label: '24h', spellout: 'the last 24 hours', ms: 24 * 60 * 60_000 },
  { key: '72h', label: '72h', spellout: 'the last 72 hours', ms: 72 * 60 * 60_000 },
  { key: '7d', label: '7d', spellout: 'the last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { key: '30d', label: '30d', spellout: 'the last 30 days', ms: 30 * 24 * 60 * 60_000 },
  { key: 'all', label: 'All', spellout: 'all time', ms: null },
];

const DEFAULT_RANGE: RangeKey = '72h';
/** Reports rendered per cell before the group offers "Load older". */
const PAGE_SIZE = 25;

function rangeOption(range: RangeKey) {
  return RANGES.find((option) => option.key === range) ?? RANGES[1]!;
}

/** Inclusive lower bound for the selected period; undefined means all time. */
function sinceFor(range: RangeKey): number | undefined {
  const option = rangeOption(range);
  return option.ms === null ? undefined : Date.now() - option.ms;
}

/** Keep one probe row so the caller knows whether another page exists. */
function pageReports(reports: Summary[]): { reports: Summary[]; hasMore: boolean } {
  return { reports: reports.slice(0, PAGE_SIZE), hasMore: reports.length > PAGE_SIZE };
}

function duration(minutes: number | undefined): string {
  if (!minutes) return '—';
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function clock(timestamp: number | null | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : '—';
}

function windowLabel(summary: Summary): string {
  return `${new Date(summary.windowStart).toLocaleString()} – ${new Date(
    summary.windowEnd,
  ).toLocaleTimeString()}`;
}

/**
 * Browse the persisted scorecard reports, grouped by cell. The sidebar's cell
 * selection scopes the page to one cell; "All cells" shows every cell with at
 * least one report in the selected period, newest first.
 */
export function ScorecardsPage({
  cellId,
  onError,
}: {
  cellId: string | null;
  onError: (message: string) => void;
}) {
  const [groups, setGroups] = useState<ScorecardGroup[] | null>(null);
  const [status, setStatus] = useState<SummaryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const statusPromise = api.getSummaryStatus(cellId ?? undefined);
      const since = sinceFor(range);
      let next: ScorecardGroup[];
      let summaryStatus: SummaryStatus;
      if (cellId) {
        const [cells, status, rows] = await Promise.all([
          api.getCells(),
          statusPromise,
          api.getSummaries({ cellId, limit: PAGE_SIZE + 1, since }),
        ]);
        const page = pageReports(rows);
        const cell = cells.find((item) => item.id === cellId);
        summaryStatus = status;
        next =
          cell && page.reports.length > 0
            ? [{ cell, ...page, loadingMore: false }]
            : [];
      } else {
        const [feed, status] = await Promise.all([
          api.getLatestSummariesPerCell({ since }),
          statusPromise,
        ]);
        summaryStatus = status;
        next = feed.map(({ cell, summary, hasOlder }) => ({
          cell,
          reports: [summary],
          hasMore: hasOlder,
          loadingMore: false,
        }));
      }
      if (generation !== loadGeneration.current) return;
      setStatus(summaryStatus);
      setGroups(next);
    } catch (error) {
      if (generation === loadGeneration.current) {
        setGroups(
          (previous) =>
            previous?.map((item) => ({ ...item, loadingMore: false })) ?? previous,
        );
        onError(describeError(error));
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [cellId, onError, range]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const loadOlder = useCallback(
    async (targetCellId: string) => {
      const group = groups?.find((item) => item.cell.id === targetCellId);
      const oldest = group?.reports.at(-1);
      if (!group || group.loadingMore || !group.hasMore || !oldest) return;
      const generation = loadGeneration.current;
      setGroups(
        (current) =>
          current?.map((item) =>
            item.cell.id === targetCellId ? { ...item, loadingMore: true } : item,
          ) ?? current,
      );
      try {
        const older = await api.getSummaries({
          cellId: targetCellId,
          limit: PAGE_SIZE + 1,
          since: sinceFor(range),
          before: oldest.createdAt,
          beforeId: oldest.id,
        });
        if (generation !== loadGeneration.current) return;
        const page = pageReports(older);
        setGroups((current) => {
          if (!current) return current;
          return current.map((item) => {
            if (item.cell.id !== targetCellId) return item;
            const seen = new Set(item.reports.map((report) => report.id));
            const appended = page.reports.filter((report) => !seen.has(report.id));
            return {
              ...item,
              reports: appended.length > 0 ? [...item.reports, ...appended] : item.reports,
              hasMore: page.hasMore,
              loadingMore: false,
            };
          });
        });
      } catch (error) {
        if (generation === loadGeneration.current) onError(describeError(error));
      } finally {
        if (generation === loadGeneration.current) {
          setGroups(
            (current) =>
              current?.map((item) =>
                item.cell.id === targetCellId ? { ...item, loadingMore: false } : item,
              ) ?? current,
          );
        }
      }
    },
    [groups, onError, range],
  );

  const option = rangeOption(range);
  const emptyTitle =
    range === 'all'
      ? 'No scorecards yet'
      : `No scorecards in ${option.spellout}`;
  const emptyHint =
    range === 'all'
      ? 'The scheduler writes one per cell on its cadence. Run one from a cell master, or enable the schedule in Config.'
      : 'Choose a longer period, run one from a cell master, or enable the schedule in Config.';

  return (
    <div className="mx-auto h-full w-full max-w-5xl space-y-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Scorecards</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Persisted reports written per cell over a trailing window. The period filters
            by when a report was generated; each report still covers its own configured
            window. Pick a cell in the sidebar to focus its history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex rounded-lg border border-zinc-800 p-0.5"
            role="group"
            aria-label="Scorecard period"
          >
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={range === item.key}
                onClick={() => {
                  if (item.key === range) return;
                  setGroups(null);
                  setLoading(true);
                  setRange(item.key);
                }}
                className={
                  range === item.key
                    ? 'rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100'
                    : 'rounded-md px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200'
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {status ? (
        <p className="text-[11px] text-zinc-600">
          {status.enabled
            ? `Automatic reports every ${duration(status.intervalMinutes)} over the last ${duration(
                status.windowMinutes,
              )}`
            : 'Automatic scorecards are disabled; run one from a cell master or enable the schedule in Config'}
          {status.running ? ' · running now' : ''}
          {' · '}last {status.lastRunAt ? `${timeAgo(status.lastRunAt)} ago` : 'never'}
          {' · '}next {clock(status.nextRunAt)}
        </p>
      ) : null}

      {status?.lastError ? (
        <p className="rounded-lg border border-amber-900/70 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
          Last attempt failed: {status.lastError}
        </p>
      ) : null}

      {groups === null ? (
        loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading scorecards...
          </div>
        ) : (
          <EmptyState
            title="Couldn't load scorecards"
            hint="Retry to reload the reports from the brain."
          />
        )
      ) : groups.length === 0 ? (
        <EmptyState title={emptyTitle} hint={emptyHint} />
      ) : (
        <div className="space-y-4">
          {groups.map(({ cell, reports, hasMore, loadingMore }) => {
            const latest = reports[0];
            if (!latest) return null;
            return (
              <Card key={cell.id} className="space-y-3 p-4">
                <div>
                  <SectionTitle>{cell.name}</SectionTitle>
                  <p className="mt-1 text-[11px] text-zinc-600">
                    Generated {timeAgo(latest.createdAt)} ago · window{' '}
                    {duration(latest.windowMinutes)} · {windowLabel(latest)}
                  </p>
                </div>

                <Scorecard summary={latest} />

                {reports.length > 1 ? (
                  <details className="rounded-lg border border-zinc-800 px-3 py-2">
                    <summary className="cursor-pointer text-[11px] text-zinc-500">
                      Earlier scorecards ({reports.length - 1})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {reports.slice(1).map((report) => (
                        <li key={report.id} className="border-t border-zinc-800 pt-2">
                          <p className="mb-1 text-[11px] text-zinc-600">
                            {new Date(report.createdAt).toLocaleString()} ·{' '}
                            {duration(report.windowMinutes)} · {windowLabel(report)}
                          </p>
                          <Scorecard summary={report} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {hasMore ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => void loadOlder(cell.id)}
                  >
                    {loadingMore ? 'Loading…' : 'Load older'}
                  </Button>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
