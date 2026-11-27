import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import { Scorecard } from './Scorecard';
import {
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
import type { Summary, SummaryCellRef, SummaryStatus } from './types';
import { timeAgo } from './types';
import { Button, Card, EmptyState, Field, Input, SectionTitle, Spinner } from './ui';

interface ScorecardGroup {
  cell: SummaryCellRef;
  reports: Summary[];
  /** More reports exist in the selected period below the oldest one shown. */
  hasMore: boolean;
  loadingMore: boolean;
}

/** Reports rendered per cell before the group offers "Load older". */
const PAGE_SIZE = 25;

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
 * selection scopes the page to one cell; "All cells" shows each cell's newest
 * report in the selected period, newest cell first.
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
  const [range, setRange] = useState<PageRangeKey>(DEFAULT_RANGE);
  const [customStart, setCustomStart] = useState(() =>
    dateInputValue(Date.now() - CUSTOM_FALLBACK_MS),
  );
  const [customEnd, setCustomEnd] = useState(() => dateInputValue(Date.now()));
  const [appliedCustom, setAppliedCustom] = useState<DateWindow>({});
  const loadGeneration = useRef(0);
  /** Bounds used by the load that produced the visible page; paging reuses them. */
  const pageWindow = useRef<DateWindow>({});

  const draftWindow = customWindow(customStart, customEnd);
  const draftError = typeof draftWindow === 'string' ? draftWindow : null;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const bounds = range === 'custom' ? appliedCustom : presetWindow(range);
    try {
      const statusPromise = api.getSummaryStatus(cellId ?? undefined);
      let next: ScorecardGroup[];
      let summaryStatus: SummaryStatus;
      if (cellId) {
        const [cells, status, rows] = await Promise.all([
          api.getCells(),
          statusPromise,
          api.getSummaries({ cellId, limit: PAGE_SIZE + 1, ...bounds }),
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
          api.getLatestSummariesPerCell(bounds),
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
      pageWindow.current = bounds;
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
  }, [appliedCustom, cellId, onError, range]);

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
    setRange('custom');
    setAppliedCustom(bounds);
    setGroups(null);
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
    setLoading(true);
  };

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
          ...pageWindow.current,
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
    [groups, onError],
  );

  let emptyTitle: string;
  let emptyHint: string;
  if (range === 'all') {
    emptyTitle = 'No scorecards yet';
    emptyHint =
      'The scheduler writes one per cell on its cadence. Run one from a cell master, or enable the schedule in Config.';
  } else if (range === 'custom') {
    emptyTitle = 'No scorecards in the selected date range';
    emptyHint =
      'Widen the start or end date, run one from a cell master, or enable the schedule in Config.';
  } else {
    emptyTitle = `No scorecards in ${rangeOption(range).spellout}`;
    emptyHint =
      'Choose a longer period, run one from a cell master, or enable the schedule in Config.';
  }

  const presetRange: RangeKey | null = range === 'custom' ? null : range;

  return (
    <div className="mx-auto h-full w-full max-w-5xl space-y-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Scorecards</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Persisted reports written per cell over a trailing window. The period filters
            by when a report was generated; each report still covers its own configured
            window. Custom dates use local time and include whole days. Pick a cell in the
            sidebar to focus its history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ScorecardPeriod
            value={presetRange}
            onChange={(next) => {
              setGroups(null);
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
          <Field label="End date">
            <Input
              type="date"
              aria-label="End date"
              className="w-40"
              value={customEnd}
              onChange={(event) => setCustomEnd(event.target.value)}
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
            {draftError ?? 'Local time; whole days.'}
          </p>
        </div>
      ) : null}

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
