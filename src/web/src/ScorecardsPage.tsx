import { useEffect, useState } from 'react';
import { api, describeError } from './api';
import { Scorecard } from './Scorecard';
import type { CellDetail, Summary, SummaryStatus } from './types';
import { timeAgo } from './types';
import { Button, Card, EmptyState, SectionTitle, Spinner } from './ui';

interface ScorecardGroup {
  cell: CellDetail;
  reports: Summary[];
}

/** How many reports to pull per cell when browsing every cell at once. */
const ALL_CELLS_HISTORY = 10;
/** A focused cell can show a deeper history in one request. */
const SINGLE_CELL_HISTORY = 25;

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
 * least one report, newest first.
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
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [cells, summaryStatus] = await Promise.all([
          api.getCells(),
          api.getSummaryStatus(cellId ?? undefined),
        ]);
        let next: ScorecardGroup[];
        if (cellId) {
          const reports = await api.getSummaries({ cellId, limit: SINGLE_CELL_HISTORY });
          const cell = cells.find((item) => item.id === cellId);
          next = cell ? [{ cell, reports }] : [];
        } else {
          const reportsByCell = await Promise.all(
            cells.map((cell) =>
              api.getSummaries({ cellId: cell.id, limit: ALL_CELLS_HISTORY }),
            ),
          );
          next = cells
            .map((cell, index) => ({ cell, reports: reportsByCell[index] ?? [] }))
            .filter((group) => group.reports.length > 0)
            .sort((a, b) => (b.reports[0]?.createdAt ?? 0) - (a.reports[0]?.createdAt ?? 0));
        }
        if (cancelled) return;
        setStatus(summaryStatus);
        setGroups(next);
      } catch (error) {
        if (!cancelled) onError(describeError(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cellId, onError, reloadKey]);

  return (
    <div className="mx-auto h-full w-full max-w-5xl space-y-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Scorecards</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Persisted reports written per cell over a trailing window. They are observational:
            a report never moves work or writes to the cell master. Pick a cell in the sidebar
            to focus its history.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => setReloadKey((key) => key + 1)}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
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
        <EmptyState
          title="No scorecards yet"
          hint="The scheduler writes one per cell on its cadence. Run one from a cell master, or enable the schedule in Config."
        />
      ) : (
        <div className="space-y-4">
          {groups.map(({ cell, reports }) => {
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
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
