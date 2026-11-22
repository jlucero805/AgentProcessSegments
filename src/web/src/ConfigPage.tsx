import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { ACTION_TONES, eventDetail } from './masterView';
import { ProcessEditor } from './ProcessEditor';
import {
  MAX_USAGE_RETENTION_DAYS,
  timeAgo,
  type CellDetail,
  type MasterConfig,
  type MasterEvent,
  type ProcessConfig,
  type SegmentConfig,
  type SummaryConfig,
  type UsageSettings,
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
  onEditCell?: (cell: CellDetail) => void;
}

/** Edits the global master defaults, process template, and per-cell switches. */
export function ConfigPage({ onError, onEditCell }: ConfigPageProps) {
  const [master, setMaster] = useState<MasterConfig | null>(null);
  const [summary, setSummary] = useState<SummaryConfig | null>(null);
  const [usage, setUsage] = useState<UsageSettings | null>(null);
  const [process, setProcess] = useState<ProcessConfig | null>(null);
  const [path, setPath] = useState('');
  const [processPath, setProcessPath] = useState('');
  const [cells, setCells] = useState<CellDetail[]>([]);
  const [events, setEvents] = useState<MasterEvent[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [usageSaving, setUsageSaving] = useState(false);
  const [usageSaved, setUsageSaved] = useState(false);
  const [processSaving, setProcessSaving] = useState(false);
  const [processSaved, setProcessSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [config, processConfig, cellList, eventList] = await Promise.all([
        api.getConfig(),
        api.getProcess(),
        api.getCells(),
        api.getMasterEvents({ limit: 20 }),
      ]);
      setMaster(config.master);
      setSummary(config.summary);
      setUsage(config.usage);
      setPath(config.path);
      setProcess({ version: processConfig.version, segments: processConfig.segments });
      setProcessPath(processConfig.path);
      setCells(cellList);
      setEvents(eventList);
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

  const setScorecard = <K extends keyof SummaryConfig>(
    key: K,
    value: SummaryConfig[K],
  ) => {
    setSummary((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  const setRetention = (days: number) => {
    setUsage((current) => (current ? { ...current, retentionDays: days } : current));
    setUsageSaved(false);
  };

  const setSegment = <K extends keyof SegmentConfig>(
    id: SegmentConfig['id'],
    key: K,
    value: SegmentConfig[K],
  ) => {
    setProcess((current) =>
      current
        ? {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === id ? { ...segment, [key]: value } : segment,
            ),
          }
        : current,
    );
    setProcessSaved(false);
  };

  const setFollowUp = (
    id: SegmentConfig['id'],
    key: 'enabled' | 'marker',
    value: boolean | string,
  ) => {
    setProcess((current) =>
      current
        ? {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === id
                ? { ...segment, followUps: { ...segment.followUps, [key]: value } }
                : segment,
            ),
          }
        : current,
    );
    setProcessSaved(false);
  };

  async function save() {
    if (!master || !summary) return;
    setSaving(true);
    try {
      const config = await api.patchConfig({ master, summary });
      setMaster(config.master);
      setSummary(config.summary);
      setPath(config.path);
      setSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveUsage() {
    if (!usage) return;
    setUsageSaving(true);
    try {
      const config = await api.patchConfig({ usage });
      setUsage(config.usage);
      setPath(config.path);
      setUsageSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setUsageSaving(false);
    }
  }

  async function saveProcess() {
    if (!process) return;
    setProcessSaving(true);
    try {
      const savedProcess = await api.patchProcess(process.segments);
      setProcess({ version: savedProcess.version, segments: savedProcess.segments });
      setProcessPath(savedProcess.path);
      setProcessSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setProcessSaving(false);
    }
  }

  async function toggleCell(cell: CellDetail) {
    try {
      const updated = await api.patchCell(cell.id, { masterEnabled: !cell.masterEnabled });
      setCells((current) => current.map((item) => (item.id === cell.id ? updated : item)));
    } catch (error) {
      onError(describeError(error));
    }
  }

  if (!master || !summary || !usage || !process) {
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
          Each cell runs its own master on a cadence, starts or prods due work, records
          follow-up requests, and advances on exact markers. Requests without a cell stay
          manual until you assign one.
        </p>
      </div>

      <Card className="space-y-5 p-4">
        <SectionTitle>Schedule</SectionTitle>

        <Checkbox
          label="Master enabled"
          checked={master.enabled}
          onChange={(event) => set('enabled', event.target.checked)}
        />

        <Field label="Interval (minutes)" hint="how often each cell is reviewed">
          <Input
            type="number"
            min={1}
            max={1440}
            value={master.intervalMinutes}
            onChange={(event) => set('intervalMinutes', Number(event.target.value))}
          />
        </Field>

        <p className="text-[11px] text-zinc-600">
          Idle thresholds, prompts, markers, and advancement are per segment below.
        </p>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="break-all font-mono text-[11px] text-zinc-600">{path}</p>
          <div className="flex items-center justify-end gap-2">
            {saved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : 'Save schedule'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-5 p-4">
        <div>
          <SectionTitle>Scorecards</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Each cell gets a periodic report of the work in its trailing window. Run one
            now from the Cell master drawer.
          </p>
        </div>

        <Checkbox
          label="Automatic scorecards enabled"
          checked={summary.enabled}
          onChange={(event) => setScorecard('enabled', event.target.checked)}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Every (minutes)" hint="how often to write a report">
            <Input
              type="number"
              min={1}
              max={10080}
              value={summary.intervalMinutes}
              onChange={(event) => setScorecard('intervalMinutes', Number(event.target.value))}
            />
          </Field>
          <Field label="Window (minutes)" hint="how far back each report looks">
            <Input
              type="number"
              min={1}
              max={10080}
              value={summary.windowMinutes}
              onChange={(event) => setScorecard('windowMinutes', Number(event.target.value))}
            />
          </Field>
        </div>

        <Field label="Report instructions" hint="the facts are added automatically">
          <Textarea
            rows={5}
            value={summary.prompt}
            onChange={(event) => setScorecard('prompt', event.target.value)}
          />
        </Field>

        <p className="text-[11px] text-zinc-600">
          6 hours = 360 minutes. Saved with the schedule above. A failed report is retried
          with backoff.
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Usage retention</SectionTitle>
        <p className="text-sm text-zinc-400">
          Raw usage rows older than this window are pruned in the background. Cost is
          reported by the harness, never estimated here.
        </p>
        <Field label="Retention (days)" hint="0 keeps history forever">
          <Input
            type="number"
            min={0}
            max={MAX_USAGE_RETENTION_DAYS}
            step={1}
            value={usage.retentionDays}
            onChange={(event) => setRetention(Number(event.target.value))}
          />
        </Field>
        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-zinc-600">
            Runs shortly after startup, then hourly. All-time totals cover the retained
            window.
          </p>
          <div className="flex items-center justify-end gap-2">
            {usageSaved ? (
              <span className="text-[11px] text-emerald-400">Saved</span>
            ) : null}
            <Button
              variant="primary"
              disabled={usageSaving}
              onClick={() => void saveUsage()}
            >
              {usageSaving ? <Spinner /> : 'Save usage retention'}
            </Button>
          </div>
        </div>
      </Card>

      <ProcessEditor
        process={process}
        path={processPath}
        saving={processSaving}
        saved={processSaved}
        title="Global process template"
        description="Inherited by cells without their own policy; new cells start with a copy that can diverge."
        onChange={setSegment}
        onFollowUp={setFollowUp}
        onSave={() => void saveProcess()}
      />

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
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-600">
                    {cell.masterIntervalMinutes ? `${cell.masterIntervalMinutes}m` : 'global'} ·{' '}
                    {cell.maxConcurrent}× · {cell.harness ?? 'brain default'}
                  </span>
                  {onEditCell ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditCell(cell)}
                    >
                      Process
                    </Button>
                  ) : null}
                  <Checkbox
                    label={`${cell.name} master`}
                    checked={cell.masterEnabled}
                    onChange={() => void toggleCell(cell)}
                  />
                </div>
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
    </div>
  );
}
