import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { ClarifyChat } from './ClarifyChat';
import { ACTION_TONES, eventDetail, resultSummary } from './masterView';
import { ProcessEditor } from './ProcessEditor';
import {
  DEFAULT_BUDGET_SETTINGS,
  MASTER_SESSION_ID,
  MAX_BUDGET_USD,
  timeAgo,
  type BudgetSettings,
  type BudgetStatus,
  type BudgetsResponse,
  type CellDetail,
  type CommandInfo,
  type MasterConfig,
  type MasterEvent,
  type MasterResult,
  type MasterStatus,
  type ProcessConfig,
  type SegmentConfig,
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
} from './ui';

interface ConfigPageProps {
  onError: (message: string) => void;
  commands: CommandInfo[];
  onEditCell?: (cell: CellDetail) => void;
}

function clock(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleTimeString() : '—';
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function moneyLabel(value: number): string {
  return money.format(value);
}

function pct(value: number): string {
  return `${value.toFixed(0)}%`;
}

function budgetTone(status: BudgetStatus): 'neutral' | 'green' | 'amber' | 'red' {
  if (status.state === 'exceeded') return 'red';
  if (status.state === 'warning') return 'amber';
  if (status.state === 'unknown') return 'neutral';
  return 'green';
}

/** Edits the persisted master policy and shows its live status and activity. */
export function ConfigPage({ onError, commands, onEditCell }: ConfigPageProps) {
  const [master, setMaster] = useState<MasterConfig | null>(null);
  const [process, setProcess] = useState<ProcessConfig | null>(null);
  const [path, setPath] = useState('');
  const [processPath, setProcessPath] = useState('');
  const [status, setStatus] = useState<MasterStatus | null>(null);
  const [cells, setCells] = useState<CellDetail[]>([]);
  const [events, setEvents] = useState<MasterEvent[]>([]);
  const [lastResult, setLastResult] = useState<MasterResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [processSaving, setProcessSaving] = useState(false);
  const [processSaved, setProcessSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [budgetMonthly, setBudgetMonthly] = useState('');
  const [budgetAlertPercent, setBudgetAlertPercent] = useState('80');
  const [budgetView, setBudgetView] = useState<BudgetsResponse | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetSaved, setBudgetSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [config, processConfig, masterStatus, cellList, eventList, budgetResponse] =
        await Promise.all([
          api.getConfig(),
          api.getProcess(),
          api.getMasterStatus(),
          api.getCells(),
          api.getMasterEvents({ limit: 20 }),
          api.getBudgets().catch(() => null),
        ]);
      const loadedBudget = config.budget ?? { ...DEFAULT_BUDGET_SETTINGS };
      setMaster(config.master);
      setPath(config.path);
      setProcess({ version: processConfig.version, segments: processConfig.segments });
      setProcessPath(processConfig.path);
      setStatus(masterStatus);
      setCells(cellList);
      setEvents(eventList);
      setLastResult(masterStatus.lastResult);
      setBudget(loadedBudget);
      setBudgetMonthly(
        loadedBudget.monthlyUsd === null ? '' : String(loadedBudget.monthlyUsd),
      );
      setBudgetAlertPercent(String(loadedBudget.alertAtPercent));
      setBudgetView(
        budgetResponse && Array.isArray(budgetResponse.statuses) ? budgetResponse : null,
      );
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
    if (!master) return;
    setSaving(true);
    try {
      const config = await api.patchConfig({ master });
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

  async function saveBudget() {
    if (!budget) return;
    const monthlyText = budgetMonthly.trim();
    const monthlyUsd = monthlyText === '' ? null : Number(monthlyText);
    if (
      monthlyUsd !== null &&
      (!Number.isFinite(monthlyUsd) ||
        monthlyUsd <= 0 ||
        monthlyUsd > MAX_BUDGET_USD ||
        Math.abs(monthlyUsd * 100 - Math.round(monthlyUsd * 100)) > 1e-6)
    ) {
      onError(
        `The overall budget must be a positive dollar amount up to ${moneyLabel(MAX_BUDGET_USD)} with at most two decimals, or blank for no budget.`,
      );
      return;
    }
    const alertAtPercent = Number(budgetAlertPercent);
    if (!Number.isInteger(alertAtPercent) || alertAtPercent < 1 || alertAtPercent > 100) {
      onError('The alert threshold must be a whole number from 1 to 100.');
      return;
    }

    setBudgetSaving(true);
    try {
      const config = await api.patchConfig({
        budget: { monthlyUsd, alertAtPercent },
      });
      const savedBudget = config.budget ?? { monthlyUsd, alertAtPercent };
      setBudget(savedBudget);
      setBudgetMonthly(
        savedBudget.monthlyUsd === null ? '' : String(savedBudget.monthlyUsd),
      );
      setBudgetAlertPercent(String(savedBudget.alertAtPercent));
      const nextView = await api.getBudgets().catch(() => null);
      setBudgetView(nextView && Array.isArray(nextView.statuses) ? nextView : null);
      setBudgetSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBudgetSaving(false);
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

  async function toggleCell(cell: CellDetail) {
    try {
      const updated = await api.patchCell(cell.id, { masterEnabled: !cell.masterEnabled });
      setCells((current) => current.map((item) => (item.id === cell.id ? updated : item)));
    } catch (error) {
      onError(describeError(error));
    }
  }

  if (!master || !process) {
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
          The master walks the process segments on a cadence, starts or prods due work,
          records follow-up requests, and advances on exact markers.
        </p>
      </div>

      <Card className="space-y-5 p-4">
        <SectionTitle>Schedule</SectionTitle>

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
          <div className="flex items-end pb-1">
            <Checkbox
              label="Include requests without a cell"
              checked={master.includeUnassigned}
              onChange={(event) => set('includeUnassigned', event.target.checked)}
            />
          </div>
        </div>

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

      <Card className="space-y-4 p-4">
        <div>
          <SectionTitle>Spend budgets</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Advisory monthly budgets for the whole brain and each cell. Alerts are warnings;
            they never stop work.
          </p>
        </div>

        {budgetView && !budgetView.usageAvailable ? (
          <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
            Usage tracking is not available yet. Budgets are saved and will become measurable
            when the usage ledger lands.
          </p>
        ) : budgetView && budgetView.statuses.length > 0 ? (
          <div className="space-y-2">
            {budgetView.statuses.map((status) => (
              <div
                key={`${status.scope}:${status.cellId ?? ''}`}
                className="space-y-1.5 rounded-lg border border-zinc-800 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-zinc-300">{status.label}</span>
                  <Badge tone={budgetTone(status)}>{status.state}</Badge>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={
                      status.state === 'exceeded'
                        ? 'h-full rounded-full bg-red-500'
                        : status.state === 'warning'
                          ? 'h-full rounded-full bg-amber-400'
                          : 'h-full rounded-full bg-emerald-500'
                    }
                    style={{ width: `${Math.min(100, Math.max(0, status.percentUsed))}%` }}
                  />
                </div>
                <p className="text-[11px] text-zinc-500">
                  {status.spendIsLowerBound ? 'At least ' : ''}
                  {moneyLabel(status.spendUsd)} of {moneyLabel(status.budgetUsd)} (
                  {pct(status.percentUsed)})
                  {status.unknownCostTurns > 0
                    ? ` · ${status.unknownCostTurns} unpriced turn${status.unknownCostTurns === 1 ? '' : 's'}`
                    : ''}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">
            No budgets configured. Set an overall budget below or edit a cell.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Overall monthly budget (USD)" hint="blank means no overall budget">
            <Input
              type="number"
              min={0.01}
              step="0.01"
              value={budgetMonthly}
              onChange={(event) => {
                setBudgetMonthly(event.target.value);
                setBudgetSaved(false);
              }}
              placeholder="No overall budget"
            />
          </Field>
          <Field
            label="Alert threshold (%)"
            hint="warning percentage; 100 alerts only at the budget"
          >
            <Input
              type="number"
              min={1}
              max={100}
              step={1}
              value={budgetAlertPercent}
              onChange={(event) => {
                setBudgetAlertPercent(event.target.value);
                setBudgetSaved(false);
              }}
            />
          </Field>
        </div>

        <p className="text-[11px] text-zinc-600">
          Budgets use the UTC calendar month. Costs are harness-reported; unpriced turns are
          shown as unknown or a lower bound. Cell budgets are set when editing a cell.
        </p>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-zinc-600">
            {budget?.monthlyUsd === null
              ? 'No overall budget saved.'
              : `Overall budget ${moneyLabel(budget?.monthlyUsd ?? 0)} per month.`}
          </p>
          <div className="flex items-center justify-end gap-2">
            {budgetSaved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
            <Button variant="primary" disabled={budgetSaving} onClick={() => void saveBudget()}>
              {budgetSaving ? <Spinner /> : 'Save budgets'}
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
        description="Used by unassigned work and cells without their own policy; new cells start with a copy that can diverge."
        onChange={setSegment}
        onFollowUp={setFollowUp}
        onSave={() => void saveProcess()}
      />

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionTitle>Master</SectionTitle>
            <p className="mt-1 text-sm text-zinc-400">
              {status?.enabled
                ? `Global cadence every ${status.intervalMinutes} min`
                : 'Disabled'}
              {status?.running ? ' · running' : ''}
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">cells may set their own interval</p>
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
          <p className="text-[11px] text-zinc-500">Last cycle: {resultSummary(lastResult)}.</p>
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
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-600">
                    {cell.masterIntervalMinutes ? `${cell.masterIntervalMinutes}m` : 'global'} ·{' '}
                    {cell.maxConcurrent}× ·{' '}
                    {cell.monthlyBudgetUsd === null
                      ? 'no budget'
                      : `${moneyLabel(cell.monthlyBudgetUsd)}/mo`}
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

      <Card className="overflow-hidden p-0">
        <div className="border-b border-zinc-800 px-4 py-3">
          <SectionTitle>Global master chat</SectionTitle>
          <p className="mt-1 text-[11px] text-zinc-500">
            Notes for unassigned work and this global template. Each cell has its own chat
            in the Cell master drawer when that cell is selected.
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
