import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { ClarifyChat } from './ClarifyChat';
import {
  MASTER_SESSION_ID,
  timeAgo,
  type Cell,
  type CommandInfo,
  type MasterConfig,
  type MasterEvent,
  type MasterResult,
  type MasterStatus,
} from './types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionTitle,
  Spinner,
  Textarea,
} from './ui';

interface ConfigPageProps {
  onError: (message: string) => void;
  commands: CommandInfo[];
}

const ACTION_TONES = {
  cycle: 'neutral',
  prod: 'blue',
  review: 'green',
  skip: 'amber',
} as const;

function clock(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleTimeString() : '—';
}

function eventDetail(event: MasterEvent): string {
  if (event.action !== 'cycle') return event.detail;
  try {
    const parsed = JSON.parse(event.detail) as {
      dispatch?: number;
      prodded?: number;
      skipped?: number;
    };
    return `${parsed.dispatch ?? 0} queued · ${parsed.prodded ?? 0} prodded · ${parsed.skipped ?? 0} skipped`;
  } catch {
    return event.detail;
  }
}

/** Edits the persisted master policy and shows its live status and activity. */
export function ConfigPage({ onError, commands }: ConfigPageProps) {
  const [master, setMaster] = useState<MasterConfig | null>(null);
  const [path, setPath] = useState('');
  const [status, setStatus] = useState<MasterStatus | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [events, setEvents] = useState<MasterEvent[]>([]);
  const [lastResult, setLastResult] = useState<MasterResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [config, masterStatus, cellList, eventList] = await Promise.all([
        api.getConfig(),
        api.getMasterStatus(),
        api.getCells(),
        api.getMasterEvents({ limit: 20 }),
      ]);
      setMaster(config.master);
      setPath(config.path);
      setStatus(masterStatus);
      setCells(cellList);
      setEvents(eventList);
      setLastResult(masterStatus.lastResult);
    } catch (error) {
      onError(describeError(error));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof MasterConfig>(key: K, value: MasterConfig[K]) => {
    setMaster((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  async function save() {
    if (!master) return;
    setSaving(true);
    try {
      const config = await api.patchConfig(master);
      setMaster(config.master);
      setPath(config.path);
      setStatus(await api.getMasterStatus());
      setSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const result = await api.runMaster();
      setLastResult(result);
      const [nextStatus, nextEvents] = await Promise.all([
        api.getMasterStatus(),
        api.getMasterEvents({ limit: 20 }),
      ]);
      setStatus(nextStatus);
      setEvents(nextEvents);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setRunning(false);
    }
  }

  async function toggleCell(cell: Cell) {
    try {
      const updated = await api.patchCell(cell.id, { masterEnabled: !cell.masterEnabled });
      setCells((current) => current.map((item) => (item.id === cell.id ? updated : item)));
    } catch (error) {
      onError(describeError(error));
    }
  }

  if (!master) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading settings...
      </div>
    );
  }

  return (
    <div className="mx-auto h-full w-full max-w-3xl space-y-4 overflow-y-auto p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Cell master</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The master reviews each cell&apos;s implementation queue on a cadence, prods
          stalled agents to record decisions and keep moving, and can move completed work
          to Review.
        </p>
      </div>

      <Card className="space-y-5 p-4">
        <SectionTitle>Policy</SectionTitle>

        <Checkbox
          label="Master enabled"
          checked={master.enabled}
          onChange={(event) => set('enabled', event.target.checked)}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Interval (minutes)" hint="how often to review">
            <Input
              type="number"
              min={1}
              max={1440}
              value={master.intervalMinutes}
              onChange={(event) => set('intervalMinutes', Number(event.target.value))}
            />
          </Field>
          <Field label="Idle threshold (minutes)" hint="prod after this long">
            <Input
              type="number"
              min={1}
              max={1440}
              value={master.idleMinutes}
              onChange={(event) => set('idleMinutes', Number(event.target.value))}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <Checkbox
            label="Move to Review when the agent ends with READY FOR REVIEW"
            checked={master.autoReview}
            onChange={(event) => set('autoReview', event.target.checked)}
          />
          <Checkbox
            label="Include requests without a cell"
            checked={master.includeUnassigned}
            onChange={(event) => set('includeUnassigned', event.target.checked)}
          />
        </div>

        <Field label="Prod prompt" hint="sent to stalled implementation sessions">
          <Textarea
            rows={8}
            value={master.prompt}
            onChange={(event) => set('prompt', event.target.value)}
          />
        </Field>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="break-all font-mono text-[11px] text-zinc-600">{path}</p>
          <div className="flex items-center justify-end gap-2">
            {saved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : 'Save settings'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionTitle>Master</SectionTitle>
            <p className="mt-1 text-sm text-zinc-400">
              {status?.enabled ? `Scheduled every ${status.intervalMinutes} min` : 'Disabled'}
              {status?.running ? ' · running' : ''}
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              last {status?.lastRunAt ? `${timeAgo(status.lastRunAt)} ago` : 'never'} ·
              next {clock(status?.nextRunAt)}
            </p>
          </div>
          <Button variant="secondary" disabled={running || status?.running} onClick={() => void runNow()}>
            {running ? <Spinner /> : 'Run master now'}
          </Button>
        </div>
        {lastResult ? (
          <p className="text-[11px] text-zinc-500">
            Last cycle: {lastResult.prodded} prodded · {lastResult.reviewed} moved to review ·{' '}
            {lastResult.skipped} skipped across {lastResult.cells} queue
            {lastResult.cells === 1 ? '' : 's'}.
          </p>
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Cells</SectionTitle>
        {cells.length === 0 ? (
          <p className="text-sm text-zinc-500">No cells yet. Create one in the left menu.</p>
        ) : (
          <div className="space-y-2">
            {cells.map((cell) => (
              <div
                key={cell.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2"
              >
                <span className="truncate text-sm text-zinc-300">{cell.name}</span>
                <Checkbox
                  label={`${cell.name} master`}
                  checked={cell.masterEnabled}
                  onChange={() => void toggleCell(cell)}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Activity</SectionTitle>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">No master activity yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {events.map((event) => (
              <li key={event.id} className="flex items-start gap-2 py-2 text-xs">
                <span className="w-10 shrink-0 text-zinc-600">{timeAgo(event.createdAt)}</span>
                <Badge tone={ACTION_TONES[event.action]}>{event.action}</Badge>
                <span className="w-24 shrink-0 truncate text-zinc-500">
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

      <Card className="overflow-hidden p-0">
        <div className="border-b border-zinc-800 px-4 py-3">
          <SectionTitle>Master chat</SectionTitle>
          <p className="mt-1 text-[11px] text-zinc-500">
            The scheduler posts cycle, prod, and review notes here. Ask the master what it is
            doing; it can read the board and the knowledge base.
          </p>
        </div>
        <div className="h-96">
          <ClarifyChat
            requestId={MASTER_SESSION_ID}
            started
            commands={commands}
            onError={onError}
            placeholder="Ask the master what it is doing…"
          />
        </div>
      </Card>
    </div>
  );
}
