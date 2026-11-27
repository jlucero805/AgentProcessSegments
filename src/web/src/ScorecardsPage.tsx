import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import { Scorecard } from './Scorecard';
import type { CellDetail, Summary, SummaryStatus } from './types';
import { timeAgo } from './types';
import { Button, Card, EmptyState, Field, Input, SectionTitle, Spinner } from './ui';

interface ScorecardGroup {
  cell: CellDetail;
  reports: Summary[];
  /** More reports exist in the selected period below the oldest one shown. */
  hasMore: boolean;
  loadingMore: boolean;
}

type PresetKey = '24h' | '72h' | '7d' | '30d' | 'all';
type RangeKey = PresetKey | 'custom';

interface DateWindow {
  since?: number;
  until?: number;
}

const RANGES: Array<{ key: PresetKey; label: string; spellout: string; ms: number | null }> = [
  { key: '24h', label: '24h', spellout: 'the last 24 hours', ms: 24 * 60 * 60_000 },
  { key: '72h', label: '72h', spellout: 'the last 72 hours', ms: 72 * 60 * 60_000 },
  { key: '7d', label: '7d', spellout: 'the last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { key: '30d', label: '30d', spellout: 'the last 30 days', ms: 30 * 24 * 60 * 60_000 },
  { key: 'all', label: 'All', spellout: 'all time', ms: null },
];

const DEFAULT_RANGE: PresetKey = '72h';
/** Fallback span when Custom is opened from All, which has no lower bound. */
const CUSTOM_FALLBACK_MS = 72 * 60 * 60_000;
/** Reports rendered per cell before the group offers "Load older". */
const PAGE_SIZE = 25;

function presetOption(range: PresetKey) {
  return RANGES.find((option) => option.key === range) ?? RANGES[1]!;
}

/** Inclusive window for a preset, evaluated at `now`; an empty window means all time. */
function presetWindow(range: PresetKey, now = Date.now()): DateWindow {
  const option = presetOption(range);
  return option.ms === null ? {} : { since: now - option.ms };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local `YYYY-MM-DD` value for an `<input type="date">`. */
function dateInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Local whole-day window for two date inputs. The start date includes local
 * midnight and the end date includes the last millisecond of the local day.
 * Returns a validation message when either date is missing or inverted.
 */
function customWindow(start: string, end: string): DateWindow | string {
  const startMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  const endMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!startMatch || !endMatch) return 'Choose both a start and end date.';
  const bounded = (match: RegExpExecArray, edge: 'start' | 'end'): number | null => {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date =
      edge === 'start'
        ? new Date(year, month, day, 0, 0, 0, 0)
        : new Date(year, month, day, 23, 59, 59, 999);
    return date.getFullYear() === year &&
      date.getMonth() === month &&
      date.getDate() === day
      ? date.getTime()
      : null;
  };
  const since = bounded(startMatch, 'start');
  const until = bounded(endMatch, 'end');
  if (since === null || until === null) return 'Choose a valid start and end date.';
  if (until < since) return 'Choose a start date on or before the end date.';
  return { since, until };
}

function segmentClass(active: boolean): string {
  return active
    ? 'rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100'
    : 'rounded-md px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200';
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
      const [cells, summaryStatus] = await Promise.all([
        api.getCells(),
        api.getSummaryStatus(cellId ?? undefined),
      ]);
      let next: ScorecardGroup[];
      if (cellId) {
        const page = pageReports(
          await api.getSummaries({ cellId, limit: PAGE_SIZE + 1, ...bounds }),
        );
        const cell = cells.find((item) => item.id === cellId);
        next =
          cell && page.reports.length > 0
            ? [{ cell, ...page, loadingMore: false }]
            : [];
      } else {
        const page = await api.getSummaryGroups({ limit: PAGE_SIZE, ...bounds });
        const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
        next = page.groups
          .map((group): ScorecardGroup | null => {
            const cell = cellsById.get(group.cellId);
            if (!cell || group.reports.length === 0) return null;
            return {
              cell,
              reports: group.reports,
              hasMore: group.hasMore,
              loadingMore: false,
            };
          })
          .filter((group): group is ScorecardGroup => group !== null)
          .sort((a, b) => (b.reports[0]?.createdAt ?? 0) - (a.reports[0]?.createdAt ?? 0));
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
    emptyTitle = `No scorecards in ${presetOption(range).spellout}`;
    emptyHint =
      'Choose a longer period, run one from a cell master, or enable the schedule in Config.';
  }

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
                className={segmentClass(range === item.key)}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={range === 'custom'}
              onClick={selectCustom}
              className={segmentClass(range === 'custom')}
            >
              Custom
            </button>
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
