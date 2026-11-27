import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import { Scorecard } from './Scorecard';
import type { CellDetail, Summary, SummaryFeedCursor, SummaryStatus } from './types';
import { timeAgo } from './types';
import { Button, Card, EmptyState, SectionTitle, Spinner } from './ui';

interface ScorecardGroup {
  cell: CellDetail;
  reports: Summary[];
  /** More reports exist in the selected period below the oldest one shown. */
  hasMore: boolean;
  loadingMore: boolean;
}

interface ScorecardFeed {
  reports: Summary[];
  hasMore: boolean;
  nextCursor: SummaryFeedCursor | null;
  /** Period bound used for the first page; later pages reuse it. */
  since: number | undefined;
}

type RangeKey = '24h' | '72h' | '7d' | '30d' | 'all';

type ScorecardsView = 'grouped' | 'flat';

const VIEWS: Array<{ key: ScorecardsView; label: string }> = [
  { key: 'grouped', label: 'Grouped' },
  { key: 'flat', label: 'Flat' },
];

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
/** Reports rendered per flat feed page. */
const FEED_PAGE_SIZE = 25;

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
  const [feed, setFeed] = useState<ScorecardFeed | null>(null);
  const [cellsById, setCellsById] = useState<Map<string, CellDetail>>(() => new Map());
  const [status, setStatus] = useState<SummaryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMoreFeed, setLoadingMoreFeed] = useState(false);
  const [view, setView] = useState<ScorecardsView>('grouped');
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const [cells, summaryStatus] = await Promise.all([
        api.getCells(),
        api.getSummaryStatus(cellId ?? undefined),
      ]);
      const since = sinceFor(range);
      const nextCells = new Map(cells.map((cell) => [cell.id, cell] as const));
      if (cellId === null && view === 'flat') {
        const page = await api.getSummaryFeed({ limit: FEED_PAGE_SIZE, since });
        if (generation !== loadGeneration.current) return;
        setCellsById(nextCells);
        setStatus(summaryStatus);
        setFeed({
          reports: page.reports,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          since,
        });
        setGroups(null);
        return;
      }
      let next: ScorecardGroup[];
      if (cellId) {
        const page = pageReports(
          await api.getSummaries({ cellId, limit: PAGE_SIZE + 1, since }),
        );
        const cell = cells.find((item) => item.id === cellId);
        next =
          cell && page.reports.length > 0
            ? [{ cell, ...page, loadingMore: false }]
            : [];
      } else {
        const pages = await Promise.all(
          cells.map((cell) =>
            api.getSummaries({ cellId: cell.id, limit: PAGE_SIZE + 1, since }),
          ),
        );
        next = cells
          .map((cell, index) => ({
            cell,
            ...pageReports(pages[index] ?? []),
            loadingMore: false,
          }))
          .filter((group) => group.reports.length > 0)
          .sort((a, b) => (b.reports[0]?.createdAt ?? 0) - (a.reports[0]?.createdAt ?? 0));
      }
      if (generation !== loadGeneration.current) return;
      setCellsById(nextCells);
      setStatus(summaryStatus);
      setGroups(next);
      setFeed(null);
    } catch (error) {
      if (generation === loadGeneration.current) {
        setGroups(
          (previous) =>
            previous?.map((item) => ({ ...item, loadingMore: false })) ?? previous,
        );
        setLoadingMoreFeed(false);
        onError(describeError(error));
      }
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setLoadingMoreFeed(false);
      }
    }
  }, [cellId, onError, range, view]);

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

  const loadMoreFeed = useCallback(async () => {
    if (!feed || loadingMoreFeed || !feed.hasMore || !feed.nextCursor) return;
    const generation = loadGeneration.current;
    setLoadingMoreFeed(true);
    try {
      const page = await api.getSummaryFeed({
        limit: FEED_PAGE_SIZE,
        since: feed.since,
        before: feed.nextCursor.before,
        beforeId: feed.nextCursor.beforeId,
      });
      if (generation !== loadGeneration.current) return;
      setFeed((current) => {
        if (!current) return current;
        const seen = new Set(current.reports.map((report) => report.id));
        const appended = page.reports.filter((report) => !seen.has(report.id));
        return {
          ...current,
          reports: appended.length > 0 ? [...current.reports, ...appended] : current.reports,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        };
      });
    } catch (error) {
      if (generation === loadGeneration.current) onError(describeError(error));
    } finally {
      if (generation === loadGeneration.current) setLoadingMoreFeed(false);
    }
  }, [feed, loadingMoreFeed, onError]);

  const option = rangeOption(range);
  const flat = cellId === null && view === 'flat';
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
            window. Grouped shows each cell's newest report first; Flat is one
            chronological cross-cell stream. Pick a cell in the sidebar to focus its
            history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cellId === null ? (
            <div
              className="flex rounded-lg border border-zinc-800 p-0.5"
              role="group"
              aria-label="Scorecards layout"
            >
              {VIEWS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={view === item.key}
                  onClick={() => {
                    if (item.key === view) return;
                    setGroups(null);
                    setFeed(null);
                    setLoadingMoreFeed(false);
                    setLoading(true);
                    setView(item.key);
                  }}
                  className={
                    view === item.key
                      ? 'rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100'
                      : 'rounded-md px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200'
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
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
                  setFeed(null);
                  setLoadingMoreFeed(false);
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

      {groups === null && feed === null ? (
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
      ) : flat && feed ? (
        feed.reports.length === 0 ? (
          <EmptyState title={emptyTitle} hint={emptyHint} />
        ) : (
          <div className="space-y-4">
            {feed.reports.map((report) => (
              <Card key={report.id} className="space-y-3 p-4">
                <div>
                  <SectionTitle>
                    {cellsById.get(report.cellId)?.name ?? report.cellId}
                  </SectionTitle>
                  <p className="mt-1 text-[11px] text-zinc-600">
                    Generated {timeAgo(report.createdAt)} ago · window{' '}
                    {duration(report.windowMinutes)} · {windowLabel(report)}
                  </p>
                </div>

                <Scorecard summary={report} />
              </Card>
            ))}

            {feed.hasMore && feed.nextCursor ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={loadingMoreFeed}
                onClick={() => void loadMoreFeed()}
              >
                {loadingMoreFeed ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </div>
        )
      ) : groups && groups.length === 0 ? (
        <EmptyState title={emptyTitle} hint={emptyHint} />
      ) : groups ? (
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
      ) : null}
    </div>
  );
}
