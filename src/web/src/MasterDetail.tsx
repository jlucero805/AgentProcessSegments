import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import { ClarifyChat } from './ClarifyChat';
import { ACTION_TONES, eventDetail, resultSummary } from './masterView';
import { Scorecard } from './Scorecard';
import {
  DEFAULT_RANGE,
  ScorecardPeriod,
  rangeOption,
  sinceFor,
  type RangeKey,
} from './ScorecardPeriod';
import {
  masterSessionId,
  timeAgo,
  type CellDetail,
  type CommandInfo,
  type MasterEvent,
  type MasterResult,
  type MasterStatus,
  type ProcessConfig,
  type Summary,
  type SummaryStatus,
} from './types';
import {
  Badge,
  Button,
  Card,
  IconButton,
  SectionTitle,
  Spinner,
} from './ui';
import type { CellsFeed } from './useCells';

interface MasterDetailProps {
  cellId: string;
  onClose: () => void;
  onConfigure: (cell: CellDetail | null) => void;
  onError: (message: string) => void;
  commands: CommandInfo[];
  cellsFeed: CellsFeed;
}

function clock(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleTimeString() : '—';
}

function duration(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** The cell master as a first-class thread: cron policy, activity, and chat. */
export function MasterDetail({
  cellId,
  onClose,
  onConfigure,
  onError,
  commands,
  cellsFeed,
}: MasterDetailProps) {
  const [process, setProcess] = useState<ProcessConfig | null>(null);
  const [status, setStatus] = useState<MasterStatus | null>(null);
  const [events, setEvents] = useState<MasterEvent[]>([]);
  const [lastResult, setLastResult] = useState<MasterResult | null>(null);
  const [running, setRunning] = useState(false);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [summaryHistory, setSummaryHistory] = useState<Summary[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus | null>(null);
  const [summaryRunning, setSummaryRunning] = useState(false);

  const selectedCell = cellsFeed.cells.find((item) => item.id === cellId) ?? null;
  const cellMissing = cellsFeed.loaded && selectedCell === null;
  const cellReady = cellsFeed.loaded && selectedCell !== null;

  const currentRequest = useRef({ cellId, range });
  useEffect(() => {
    currentRequest.current = { cellId, range };
  }, [cellId, range]);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!cellReady) return;
    // A queued poll from a previous cell or period must not start a new request.
    if (cellId !== currentRequest.current.cellId || range !== currentRequest.current.range) {
      return;
    }
    const generation = ++loadGeneration.current;
    try {
      const [
        globalProcess,
        masterStatus,
        eventList,
        history,
        scorecardStatus,
      ] = await Promise.all([
        api.getProcess(),
        api.getMasterStatus(cellId),
        api.getMasterEvents({ cellId, limit: 30 }),
        api.getSummaries({ cellId, limit: 5, since: sinceFor(range) }),
        api.getSummaryStatus(cellId),
      ]);
      if (generation !== loadGeneration.current) return;
      const effective = selectedCell.process ?? {
        version: globalProcess.version,
        segments: globalProcess.segments,
      };
      setProcess(effective);
      setStatus(masterStatus);
      setEvents(eventList);
      setLastResult(masterStatus.lastResult);
      setSummaryHistory(history);
      setSummaryLoading(false);
      setSummaryStatus(scorecardStatus);
    } catch (error) {
      if (generation === loadGeneration.current) {
        setSummaryLoading(false);
        onError(describeError(error));
      }
    }
  }, [cellId, cellReady, onError, range, selectedCell]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // Keep the live view current while the drawer is open.
  useEffect(() => {
    if (!cellReady) return;
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [cellReady, load]);

  async function runNow() {
    setRunning(true);
    try {
      const result = await api.runMaster(cellId);
      setLastResult(result);
      await load();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setRunning(false);
    }
  }

  function changeRange(next: RangeKey) {
    if (next === range) return;
    setRange(next);
    setSummaryHistory([]);
    setSummaryLoading(true);
  }

  async function runSummary() {
    if (!cellId) return;
    setSummaryRunning(true);
    try {
      await api.runSummary(cellId);
      await load();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSummaryRunning(false);
    }
  }

  if (!cellsFeed.loaded) {
    return (
      <aside
        data-testid="master-detail"
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[42rem] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Badge tone="purple">cell master</Badge>
          <span
            data-testid="master-title"
            className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100"
          >
            Cell master
          </span>
          <IconButton label="Close master detail" onClick={onClose}>
            ×
          </IconButton>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-sm text-zinc-500">
          {cellsFeed.error ? (
            <>
              <p>Couldn't load the cell list.</p>
              <p className="text-xs text-zinc-600">{cellsFeed.error}</p>
              <Button variant="secondary" size="sm" onClick={() => void cellsFeed.reload()}>
                Retry
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Spinner /> Loading cell...
            </div>
          )}
        </div>
      </aside>
    );
  }

  if (cellMissing) {
    return (
      <aside
        data-testid="master-detail"
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[42rem] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Badge tone="purple">cell master</Badge>
          <span
            data-testid="master-title"
            className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100"
          >
            Cell deleted
          </span>
          <IconButton label="Close master detail" onClick={onClose}>
            ×
          </IconButton>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
          <p className="text-sm text-zinc-400">This cell was deleted.</p>
          <p className="text-xs text-zinc-600">
            No policy or actions remain for <span className="font-mono">{cellId}</span>.
          </p>
        </div>
      </aside>
    );
  }

  const cell = selectedCell;
  const enabled = process?.segments.filter((segment) => segment.enabled) ?? [];
  const latestSummary = summaryHistory[0] ?? null;
  const rangeDetails = rangeOption(range);

  return (
    <aside
      data-testid="master-detail"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[42rem] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
    >
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <Badge tone="purple">cell master</Badge>
        <span
          data-testid="master-title"
          className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100"
        >
          {cell ? `${cell.name} · process automation` : 'Process automation'}
        </span>
        <Button variant="secondary" size="sm" onClick={() => onConfigure(cell)}>
          Configure
        </Button>
        <IconButton label="Close master detail" onClick={onClose}>
          ×
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!process || !status ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading master...
          </div>
        ) : (
          <>
            <Card className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <SectionTitle>Status</SectionTitle>
                  <p className="mt-1 text-sm text-zinc-400">
                    {status.enabled ? `Scheduled every ${status.intervalMinutes} min` : 'Disabled'}
                    {status.running ? ' · running' : ''}
                  </p>
                  <p className="mt-1 text-[11px] text-zinc-600">
                    last {status.lastRunAt ? `${timeAgo(status.lastRunAt)} ago` : 'never'} ·
                    next {clock(status.nextRunAt)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={running || status.running}
                  onClick={() => void runNow()}
                >
                  {running ? <Spinner /> : 'Run now'}
                </Button>
              </div>
              {lastResult ? (
                <p className="text-[11px] text-zinc-500">
                  Last cycle: {resultSummary(lastResult)}.
                </p>
              ) : null}
            </Card>

            <Card testId="master-cron-loop" className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <SectionTitle>Cron loop</SectionTitle>
                <span className="text-[11px] text-zinc-600">
                  {enabled.length} of {process.segments.length} enabled
                </span>
              </div>
              <p data-testid="master-policy" className="text-[11px] text-zinc-600">
                {cell
                  ? `${cell.process ? 'Cell policy' : 'Global default (cell has no policy yet)'} · ${
                      cell.maxConcurrent
                    }× concurrency · ${cell.model ?? 'CLI model'} · ${
                      cell.effort ?? 'default effort'
                    } · compact ${cell.autocompactPercent}%`
                  : 'This cell no longer exists.'}
              </p>
              <ul className="space-y-2">
                {process.segments.map((segment) => (
                  <li
                    key={segment.id}
                    className="rounded-lg border border-zinc-800 px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-200">{segment.label}</span>
                      <Badge tone={segment.enabled ? 'green' : 'neutral'}>
                        {segment.enabled ? 'on' : 'off'}
                      </Badge>
                      <span className="text-zinc-500">
                        {segment.idleMinutes}m idle ·{' '}
                        {segment.advanceTo ? `→ ${segment.advanceTo}` : 'stays'}
                      </span>
                      {segment.followUps.enabled ? (
                        <Badge tone="purple">follow-ups</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-600">{segment.purpose}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-zinc-500">
                        Prompt used on cron
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10px] text-zinc-400">
                        {segment.prompt || '(built-in start prompt)'}
                      </pre>
                      {segment.readyMarker ? (
                        <p className="mt-1 font-mono text-[10px] text-zinc-600">
                          ready: {segment.readyMarker}
                        </p>
                      ) : null}
                    </details>
                  </li>
                ))}
              </ul>
            </Card>

            {cellId ? (
              <Card className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <SectionTitle>Scorecard</SectionTitle>
                    <p className="mt-1 text-sm text-zinc-400">
                      {summaryStatus?.enabled
                        ? `Every ${duration(summaryStatus.intervalMinutes)} over the last ${duration(
                            summaryStatus.windowMinutes,
                          )}`
                        : 'Automatic scorecards disabled'}
                      {summaryStatus?.running ? ' · running' : ''}
                    </p>
                    <p className="mt-1 text-[11px] text-zinc-600">
                      last {summaryStatus?.lastRunAt ? `${timeAgo(summaryStatus.lastRunAt)} ago` : 'never'} ·
                      next {clock(summaryStatus?.nextRunAt)}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={summaryRunning || summaryStatus?.running}
                    onClick={() => void runSummary()}
                  >
                    {summaryRunning ? <Spinner /> : 'Run scorecard now'}
                  </Button>
                </div>

                {summaryStatus?.lastError ? (
                  <p className="rounded-lg border border-amber-900/70 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
                    Last attempt failed: {summaryStatus.lastError}
                  </p>
                ) : null}

                <div className="space-y-1">
                  <ScorecardPeriod value={range} onChange={changeRange} />
                  <p className="text-[10px] text-zinc-600">
                    Period filters by generation time; each report still covers its own
                    configured window.
                  </p>
                </div>

                {summaryLoading ? (
                  <div className="flex h-20 items-center justify-center gap-2 text-sm text-zinc-500">
                    <Spinner /> Loading scorecards...
                  </div>
                ) : latestSummary ? (
                  <>
                    <p className="text-[11px] text-zinc-600">
                      Generated {timeAgo(latestSummary.createdAt)} ago · window{' '}
                      {duration(latestSummary.windowMinutes)} ·{' '}
                      {new Date(latestSummary.windowStart).toLocaleString()} –{' '}
                      {new Date(latestSummary.windowEnd).toLocaleTimeString()}
                    </p>
                    <Scorecard summary={latestSummary} />
                    {summaryHistory.length > 1 ? (
                      <details className="rounded-lg border border-zinc-800 px-3 py-2">
                        <summary className="cursor-pointer text-[11px] text-zinc-500">
                          Earlier scorecards ({summaryHistory.length - 1})
                        </summary>
                        <ul className="mt-2 space-y-2">
                          {summaryHistory.slice(1).map((summary) => (
                            <li key={summary.id} className="border-t border-zinc-800 pt-2">
                              <p className="mb-1 text-[11px] text-zinc-600">
                                {new Date(summary.createdAt).toLocaleString()} ·{' '}
                                {duration(summary.windowMinutes)}
                              </p>
                              <Scorecard summary={summary} />
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-zinc-500">
                    {range === 'all'
                      ? 'No scorecard yet. The scheduler writes one for this cell on its cadence, or you can run one now.'
                      : `No scorecards in ${rangeDetails.spellout}. Choose a longer period, or run one now.`}
                  </p>
                )}
              </Card>
            ) : null}

            <Card className="space-y-3 p-4">
              <SectionTitle>Activity</SectionTitle>
              {events.length === 0 ? (
                <p className="text-sm text-zinc-500">No master activity yet.</p>
              ) : (
                <ul
                  aria-label="Recent activity"
                  className="max-h-80 divide-y divide-zinc-800 overflow-y-auto overscroll-contain pr-1"
                >
                  {events.map((event) => (
                    <li key={event.id} className="flex items-start gap-2 py-2 text-xs">
                      <span className="w-10 shrink-0 text-zinc-600">
                        {timeAgo(event.createdAt)}
                      </span>
                      <Badge tone={ACTION_TONES[event.action]}>{event.action}</Badge>
                      <span className="w-20 shrink-0 truncate text-zinc-500">
                        {event.cellId
                          ? cellsFeed.cells.find((item) => item.id === event.cellId)?.name ??
                            'Deleted cell'
                          : 'Unassigned'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-zinc-400">
                        {eventDetail(event)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>

      <div className="h-80 shrink-0 border-t border-zinc-800">
        <div
          data-testid="master-chat"
          className="border-b border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500"
        >
          Master chat — scheduler notes and your questions
        </div>
        <div className="h-[calc(100%-1.75rem)]">
          <ClarifyChat
            requestId={masterSessionId(cellId)}
            started
            commands={commands}
            onError={onError}
            placeholder="Ask the master what it is doing…"
          />
        </div>
      </div>
    </aside>
  );
}
