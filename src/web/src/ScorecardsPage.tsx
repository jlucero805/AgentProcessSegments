import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, describeError } from './api';
import { Scorecard } from './Scorecard';
import {
  CUSTOM_DEFAULT_END_TIME,
  CUSTOM_DEFAULT_START_TIME,
  CUSTOM_FALLBACK_MS,
  DEFAULT_RANGE,
  ScorecardPeriod,
  customWindow,
  dateInputValue,
  presetWindow,
  rangeOption,
  type DateWindow,
  type PageRangeKey,
  type RangeKey,
} from './ScorecardPeriod';
import type { Summary, SummaryCellRef, SummaryFeedCursor, SummaryStatus } from './types';
import { timeAgo } from './types';
import { Button, Card, EmptyState, Field, Input, SectionTitle, Spinner } from './ui';
import type { CellsFeed } from './useCells';

interface ScorecardGroup {
  cell: SummaryCellRef;
  reports: Summary[];
  /** More reports exist in the selected period below the oldest one shown. */
  hasMore: boolean;
  loadingMore: boolean;
}

interface ScorecardFeed {
  reports: Summary[];
  hasMore: boolean;
  nextCursor: SummaryFeedCursor | null;
  /** Inclusive window used for the first page; later pages reuse it. */
  window: DateWindow;
}

type ScorecardsView = 'grouped' | 'flat';

const VIEWS: Array<{ key: ScorecardsView; label: string }> = [
  { key: 'grouped', label: 'Grouped' },
  { key: 'flat', label: 'Flat' },
];

/** Reports rendered per cell before the group offers "Load older". */
const PAGE_SIZE = 25;
/** Reports rendered per flat feed page. */
const FEED_PAGE_SIZE = 25;

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

/** Applied Custom window in the operator's local time, to minute precision. */
function appliedRangeLabel(window: DateWindow): string {
  if (window.since === undefined || window.until === undefined) return '';
  const format = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  return `Applied: ${format(window.since)} – ${format(window.until)} (local; the end minute is included)`;
}

/**
 * Browse the persisted scorecard reports. The sidebar's cell selection, or a flat
 * item's cell name, scopes the page to one cell; "All cells" shows each cell's newest
 * report in the selected period, newest cell first, or one flat chronological
 * cross-cell feed.
 */
export function ScorecardsPage({
  cellId,
  onSelectCell,
  onError,
  cellsFeed,
}: {
  cellId: string | null;
  onSelectCell: (cellId: string | null) => void;
  onError: (message: string) => void;
  cellsFeed: CellsFeed;
}) {
  const [groups, setGroups] = useState<ScorecardGroup[] | null>(null);
  const [feed, setFeed] = useState<ScorecardFeed | null>(null);
  const [status, setStatus] = useState<SummaryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMoreFeed, setLoadingMoreFeed] = useState(false);
  const [view, setView] = useState<ScorecardsView>('grouped');
  const [range, setRange] = useState<PageRangeKey>(DEFAULT_RANGE);
  const [customStart, setCustomStart] = useState(() =>
    dateInputValue(Date.now() - CUSTOM_FALLBACK_MS),
  );
  const [customEnd, setCustomEnd] = useState(() => dateInputValue(Date.now()));
  const [customStartTime, setCustomStartTime] = useState(CUSTOM_DEFAULT_START_TIME);
  const [customEndTime, setCustomEndTime] = useState(CUSTOM_DEFAULT_END_TIME);
  const [appliedCustom, setAppliedCustom] = useState<DateWindow>({});
  const loadGeneration = useRef(0);
  /**
   * Bumped whenever load() commits a new first page; paging captures this so a page
   * fetched against a superseded window is dropped even when the generation matches.
   */
  const pageVersion = useRef(0);
  /** Bounds used by the load that produced the visible page; paging reuses them. */
  const pageWindow = useRef<DateWindow>({});

  const cellNames = useMemo(
    () => new Map(cellsFeed.cells.map((cell) => [cell.id, cell.name])),
    [cellsFeed.cells],
  );
  const selectedCell = cellId ? cellsFeed.cells.find((cell) => cell.id === cellId) ?? null : null;
  const missingCell = cellId !== null && cellsFeed.loaded && selectedCell === null;
  const cellReady = cellId === null || (cellsFeed.loaded && selectedCell !== null);

  const draftWindow = customWindow(customStart, customEnd, customStartTime, customEndTime);
  const draftError = typeof draftWindow === 'string' ? draftWindow : null;

  const load = useCallback(async () => {
    if (cellId !== null && !cellReady) return;
    const generation = ++loadGeneration.current;
    const bounds = range === 'custom' ? appliedCustom : presetWindow(range);
    try {
      const statusPromise = api.getSummaryStatus(cellId ?? undefined);
      if (cellId === null && view === 'flat') {
        const [summaryStatus, page] = await Promise.all([
          statusPromise,
          api.getSummaryFeed({ limit: FEED_PAGE_SIZE, ...bounds }),
        ]);
        if (generation !== loadGeneration.current) return;
        pageVersion.current += 1;
        pageWindow.current = bounds;
        setStatus(summaryStatus);
        setFeed({
          reports: page.reports,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          window: bounds,
        });
        setGroups(null);
        return;
      }
      let next: ScorecardGroup[];
      let summaryStatus: SummaryStatus;
      if (cellId) {
        const [status, rows] = await Promise.all([
          statusPromise,
          api.getSummaries({ cellId, limit: PAGE_SIZE + 1, ...bounds }),
        ]);
        const page = pageReports(rows);
        summaryStatus = status;
        next = selectedCell ? [{ cell: selectedCell, ...page, loadingMore: false }] : [];
      } else {
        const [latest, status] = await Promise.all([
          api.getLatestSummariesPerCell(bounds),
          statusPromise,
        ]);
        summaryStatus = status;
        next = latest.map(({ cell, summary, hasOlder }) => ({
          cell,
          reports: [summary],
          hasMore: hasOlder,
          loadingMore: false,
        }));
      }
      if (generation !== loadGeneration.current) return;
      pageVersion.current += 1;
      pageWindow.current = bounds;
      setStatus(summaryStatus);
      setGroups(next);
      setFeed(null);
    } catch (error) {
      if (generation === loadGeneration.current) {
        setGroups(
          (previous) =>
            previous?.map((item) => ({ ...item, loadingMore: false })) ?? previous,
        );
        onError(describeError(error));
      }
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setLoadingMoreFeed(false);
      }
    }
  }, [appliedCustom, cellId, cellReady, onError, range, selectedCell, view]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const selectCustom = () => {
    if (range === 'custom') return;
    const now = Date.now();
    const startTime =
      range === 'all'
        ? now - CUSTOM_FALLBACK_MS
        : presetWindow(range, now).since ?? now - CUSTOM_FALLBACK_MS;
    const start = dateInputValue(startTime);
    const end = dateInputValue(now);
    const bounds = customWindow(start, end);
    if (typeof bounds === 'string') return;
    setCustomStart(start);
    setCustomEnd(end);
    setCustomStartTime(CUSTOM_DEFAULT_START_TIME);
    setCustomEndTime(CUSTOM_DEFAULT_END_TIME);
    setRange('custom');
    setAppliedCustom(bounds);
    setGroups(null);
    setFeed(null);
    setLoadingMoreFeed(false);
    setLoading(true);
  };

  const applyCustom = () => {
    if (typeof draftWindow === 'string') return;
    if (
      range === 'custom' &&
      draftWindow.since === appliedCustom.since &&
      draftWindow.until === appliedCustom.until
    ) {
      return;
    }
    setRange('custom');
    setAppliedCustom(draftWindow);
    setGroups(null);
    setFeed(null);
    setLoadingMoreFeed(false);
    setLoading(true);
  };

  const loadOlder = useCallback(
    async (targetCellId: string) => {
      const group = groups?.find((item) => item.cell.id === targetCellId);
      const oldest = group?.reports.at(-1);
      if (!group || group.loadingMore || !group.hasMore || !oldest) return;
      const generation = loadGeneration.current;
      const version = pageVersion.current;
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
          ...pageWindow.current,
          before: oldest.createdAt,
          beforeId: oldest.id,
        });
        if (generation !== loadGeneration.current || version !== pageVersion.current) return;
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
    [groups, onError],
  );

  const loadMoreFeed = useCallback(async () => {
    if (!feed || loadingMoreFeed || !feed.hasMore || !feed.nextCursor) return;
    const generation = loadGeneration.current;
    const version = pageVersion.current;
    setLoadingMoreFeed(true);
    try {
      const page = await api.getSummaryFeed({
        limit: FEED_PAGE_SIZE,
        ...feed.window,
        before: feed.nextCursor.before,
        beforeId: feed.nextCursor.beforeId,
      });
      if (generation !== loadGeneration.current || version !== pageVersion.current) return;
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

  let emptyTitle: string;
  let emptyHint: string;
  if (range === 'all') {
    emptyTitle = 'No scorecards yet';
    emptyHint =
      'The scheduler writes one per cell on its cadence. Run one from a cell master, or enable the schedule in Config.';
  } else if (range === 'custom') {
    emptyTitle = 'No scorecards in the selected range';
    emptyHint =
      'Widen the start or end date or time, run one from a cell master, or enable the schedule in Config.';
  } else {
    emptyTitle = `No scorecards in ${rangeOption(range).spellout}`;
    emptyHint =
      'Choose a longer period, run one from a cell master, or enable the schedule in Config.';
  }

  const presetRange: RangeKey | null = range === 'custom' ? null : range;
  const flat = cellId === null && view === 'flat';

  return (
    <div className="mx-auto h-full w-full max-w-5xl space-y-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Scorecards</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Persisted reports written per cell over a trailing window. The period filters
            by when a report was generated; each report still covers its own configured
            window. Custom start and end use browser-local date and time; the end minute
            is included. Grouped shows each cell's newest report first; Flat is one
            chronological cross-cell stream. Pick a cell in the sidebar, or click its name
            in Flat, to focus its history.
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
          <ScorecardPeriod
            value={presetRange}
            onChange={(next) => {
              setGroups(null);
              setFeed(null);
              setLoadingMoreFeed(false);
              setLoading(true);
              setRange(next);
            }}
            onSelectCustom={selectCustom}
            customSelected={range === 'custom'}
          />
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

      {range === 'custom' ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <Field label="Start date">
            <Input
              type="date"
              aria-label="Start date"
              className="w-40"
              value={customStart}
              onChange={(event) => setCustomStart(event.target.value)}
            />
          </Field>
          <Field label="Start time">
            <Input
              type="time"
              step={60}
              aria-label="Start time"
              className="w-28"
              value={customStartTime}
              onChange={(event) => setCustomStartTime(event.target.value)}
            />
          </Field>
          <Field label="End date">
            <Input
              type="date"
              aria-label="End date"
              className="w-40"
              value={customEnd}
              onChange={(event) => setCustomEnd(event.target.value)}
            />
          </Field>
          <Field label="End time">
            <Input
              type="time"
              step={60}
              aria-label="End time"
              className="w-28"
              value={customEndTime}
              onChange={(event) => setCustomEndTime(event.target.value)}
            />
          </Field>
          <Button
            variant="secondary"
            size="sm"
            disabled={draftError !== null}
            onClick={applyCustom}
          >
            Apply
          </Button>
          <p
            className={
              draftError ? 'text-[11px] text-amber-300' : 'text-[11px] text-zinc-600'
            }
          >
            {draftError ?? appliedRangeLabel(appliedCustom)}
          </p>
        </div>
      ) : null}

      {!missingCell && status ? (
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

      {!missingCell && status?.lastError ? (
        <p className="rounded-lg border border-amber-900/70 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
          Last attempt failed: {status.lastError}
        </p>
      ) : null}

      {missingCell ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 p-8 text-center">
          <p className="text-sm text-zinc-400">This cell no longer exists</p>
          <p className="text-xs text-zinc-600">
            It was deleted. Show all cells to browse the remaining reports.
          </p>
          <Button variant="secondary" size="sm" onClick={() => onSelectCell(null)}>
            Show all cells
          </Button>
        </div>
      ) : groups === null && feed === null ? (
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
            {feed.reports.map((report) => {
              const name = cellNames.get(report.cellId);
              return (
                <Card key={report.id} className="space-y-3 p-4">
                  <div>
                    <SectionTitle>
                      {name ? (
                        <button
                          type="button"
                          aria-label={`Focus ${name}`}
                          onClick={() => onSelectCell(report.cellId)}
                          className="rounded-sm hover:text-zinc-200 hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
                        >
                          {name}
                        </button>
                      ) : (
                        report.cellId
                      )}
                    </SectionTitle>
                    <p className="mt-1 text-[11px] text-zinc-600">
                      Generated {timeAgo(report.createdAt)} ago · window{' '}
                      {duration(report.windowMinutes)} · {windowLabel(report)}
                    </p>
                  </div>

                  <Scorecard summary={report} />
                </Card>
              );
            })}

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
