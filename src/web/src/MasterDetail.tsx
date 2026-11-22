import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, describeError } from './api';
import { ClarifyChat } from './ClarifyChat';
import { ACTION_TONES, eventDetail, resultSummary } from './masterView';
import { markdownComponents } from './Thread';
import {
  masterSessionId,
  timeAgo,
  type Cell,
  type CellDetail,
  type CommandInfo,
  type MasterConfig,
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

interface MasterDetailProps {
  cellId?: string | null;
  onClose: () => void;
  onConfigure: (cell: CellDetail | null) => void;
  onError: (message: string) => void;
  commands: CommandInfo[];
}

function clock(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleTimeString() : '—';
}

function duration(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function Scorecard({ summary }: { summary: Summary }) {
  return (
    <div className="break-words rounded-lg border border-zinc-800 bg-black/20 p-3">
      <ReactMarkdown components={markdownComponents}>{summary.content}</ReactMarkdown>
    </div>
  );
}

/** The cell master as a first-class thread: cron policy, activity, and chat. */
export function MasterDetail({ cellId, onClose, onConfigure, onError, commands }: MasterDetailProps) {
  const [master, setMaster] = useState<MasterConfig | null>(null);
  const [process, setProcess] = useState<ProcessConfig | null>(null);
  const [cell, setCell] = useState<CellDetail | null>(null);
  const [status, setStatus] = useState<MasterStatus | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [events, setEvents] = useState<MasterEvent[]>([]);
  const [lastResult, setLastResult] = useState<MasterResult | null>(null);
  const [running, setRunning] = useState(false);
  const [latestSummary, setLatestSummary] = useState<Summary | null>(null);
  const [summaryHistory, setSummaryHistory] = useState<Summary[]>([]);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus | null>(null);
  const [summaryRunning, setSummaryRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [
        config,
        globalProcess,
        masterStatus,
        cellList,
        eventList,
        latest,
        history,
        scorecardStatus,
      ] = await Promise.all([
        api.getConfig(),
        api.getProcess(),
        api.getMasterStatus(cellId ?? undefined),
        api.getCells(),
        api.getMasterEvents({ cellId: cellId ?? undefined, limit: 30 }),
        cellId ? api.getLatestSummary(cellId) : Promise.resolve(null),
        cellId ? api.getSummaries({ cellId, limit: 5 }) : Promise.resolve([]),
        cellId ? api.getSummaryStatus(cellId) : Promise.resolve(null),
      ]);
      const selected = cellId ? cellList.find((item) => item.id === cellId) ?? null : null;
      const effective = selected?.process ?? {
        version: globalProcess.version,
        segments: globalProcess.segments,
      };
      setMaster(config.master);
      setCell(selected);
      setProcess(effective);
      setStatus(masterStatus);
      setCells(cellList);
      setEvents(eventList);
      setLastResult(masterStatus.lastResult);
      setLatestSummary(latest);
      setSummaryHistory(history);
      setSummaryStatus(scorecardStatus);
    } catch (error) {
      onError(describeError(error));
    }
  }, [cellId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the live view current while the drawer is open.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function runNow() {
    setRunning(true);
    try {
      const result = await api.runMaster(cellId ?? undefined);
      setLastResult(result);
      await load();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setRunning(false);
    }
  }

  async function runSummary() {
    if (!cellId) return;
    setSummaryRunning(true);
    try {
      setLatestSummary(await api.runSummary(cellId));
      await load();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSummaryRunning(false);
    }
  }

  const enabled = process?.segments.filter((segment) => segment.enabled) ?? [];

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[42rem] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <Badge tone="purple">cell master</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
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
        {!master || !process || !status ? (
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

            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <SectionTitle>Cron loop</SectionTitle>
                <span className="text-[11px] text-zinc-600">
                  {enabled.length} of {process.segments.length} enabled
                </span>
              </div>
              <p className="text-[11px] text-zinc-600">
                {cell
                  ? `${cell.process ? 'Cell policy' : 'Global default (cell has no policy yet)'} · ${
                      cell.maxConcurrent
                    }× concurrency · ${cell.model ?? 'CLI model'} · ${
                      cell.effort ?? 'default effort'
                    } · compact ${cell.autocompactPercent}%`
                  : master.includeUnassigned
                    ? 'Global template · includes unassigned requests'
                    : 'Global template · cell-assigned requests only'}
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

                {latestSummary ? (
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
                    No scorecard yet. The scheduler writes one for this cell on its cadence,
                    or you can run one now.
                  </p>
                )}
              </Card>
            ) : null}

            <Card className="space-y-3 p-4">
              <SectionTitle>Activity</SectionTitle>
              {events.length === 0 ? (
                <p className="text-sm text-zinc-500">No master activity yet.</p>
              ) : (
                <ul className="divide-y divide-zinc-800">
                  {events.map((event) => (
                    <li key={event.id} className="flex items-start gap-2 py-2 text-xs">
                      <span className="w-10 shrink-0 text-zinc-600">
                        {timeAgo(event.createdAt)}
                      </span>
                      <Badge tone={ACTION_TONES[event.action]}>{event.action}</Badge>
                      <span className="w-20 shrink-0 truncate text-zinc-500">
                        {event.cellId
                          ? cells.find((cell) => cell.id === event.cellId)?.name ?? 'Deleted cell'
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
        <div className="border-b border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
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
