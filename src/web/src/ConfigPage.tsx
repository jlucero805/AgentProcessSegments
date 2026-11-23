import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { ACTION_TONES, eventDetail } from './masterView';
import { ProcessEditor } from './ProcessEditor';
import {
  DEFAULT_BUDGET_SETTINGS,
  MAX_BUDGET_USD,
  MAX_USAGE_RETENTION_DAYS,
  timeAgo,
  type BudgetSettings,
  type BudgetStatus,
  type BudgetsResponse,
  type CellDetail,
  type MasterConfig,
  type MasterEvent,
  type ModelPrice,
  type ModelPriceInput,
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

interface PriceFormState {
  model: string;
  effectiveDate: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  reasoning: string;
  source: string;
  note: string;
}

function utcDate(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function emptyPriceForm(): PriceFormState {
  return {
    model: '',
    effectiveDate: utcDate(),
    input: '',
    output: '',
    cacheRead: '',
    cacheWrite: '',
    reasoning: '',
    source: '',
    note: '',
  };
}

function parseUtcDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseRate(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function mergePrice(list: ModelPrice[], created: ModelPrice): ModelPrice[] {
  return [...list, created].sort(
    (left, right) =>
      left.model.localeCompare(right.model) ||
      right.effectiveFrom - left.effectiveFrom ||
      right.createdAt - left.createdAt,
  );
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
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [budgetMonthly, setBudgetMonthly] = useState('');
  const [budgetAlertPercent, setBudgetAlertPercent] = useState('80');
  const [budgetView, setBudgetView] = useState<BudgetsResponse | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetSaved, setBudgetSaved] = useState(false);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [priceForm, setPriceForm] = useState<PriceFormState>(emptyPriceForm);
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceError, setPriceError] = useState('');
  const [pendingPriceDelete, setPendingPriceDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [config, processConfig, cellList, eventList, budgetResponse] =
        await Promise.all([
          api.getConfig(),
          api.getProcess(),
          api.getCells(),
          api.getMasterEvents({ limit: 20 }),
          api.getBudgets().catch(() => null),
        ]);
      const loadedBudget = config.budget ?? { ...DEFAULT_BUDGET_SETTINGS };
      setMaster(config.master);
      setSummary(config.summary);
      setUsage(config.usage);
      setPath(config.path);
      setProcess({ version: processConfig.version, segments: processConfig.segments });
      setProcessPath(processConfig.path);
      setCells(cellList);
      setEvents(eventList);
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

  useEffect(() => {
    let mounted = true;
    api
      .getPricing()
      .then((response) => {
        if (mounted) setPrices(Array.isArray(response.prices) ? response.prices : []);
      })
      .catch((error) => {
        if (mounted) onError(describeError(error));
      });
    return () => {
      mounted = false;
    };
  }, [onError]);

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

  async function toggleCell(cell: CellDetail) {
    try {
      const updated = await api.patchCell(cell.id, { masterEnabled: !cell.masterEnabled });
      setCells((current) => current.map((item) => (item.id === cell.id ? updated : item)));
    } catch (error) {
      onError(describeError(error));
    }
  }

  function setPrice<K extends keyof PriceFormState>(key: K, value: PriceFormState[K]) {
    setPriceForm((current) => ({ ...current, [key]: value }));
    setPriceError('');
  }

  async function addPrice() {
    setPriceError('');
    const effectiveFrom = parseUtcDate(priceForm.effectiveDate);
    const rates = [
      parseRate(priceForm.input),
      parseRate(priceForm.output),
      parseRate(priceForm.cacheRead),
      parseRate(priceForm.cacheWrite),
      parseRate(priceForm.reasoning),
    ];
    if (priceForm.model.trim() === '' || priceForm.source.trim() === '' || effectiveFrom === null) {
      setPriceError('Model, effective date, and source are required.');
      return;
    }
    if (rates.some((value) => value === null)) {
      setPriceError('Enter a non-negative USD rate for every token category.');
      return;
    }

    const [input, output, cacheRead, cacheWrite, reasoning] = rates as [
      number,
      number,
      number,
      number,
      number,
    ];
    const inputPrice: ModelPriceInput = {
      model: priceForm.model.trim(),
      effectiveFrom,
      inputUsdPerMtok: input,
      outputUsdPerMtok: output,
      cacheReadUsdPerMtok: cacheRead,
      cacheWriteUsdPerMtok: cacheWrite,
      reasoningUsdPerMtok: reasoning,
      source: priceForm.source.trim(),
      note: priceForm.note.trim() === '' ? null : priceForm.note.trim(),
    };

    setPriceSaving(true);
    try {
      const created = await api.createPrice(inputPrice);
      setPrices((current) => mergePrice(current, created));
      setPriceForm(emptyPriceForm());
    } catch (error) {
      setPriceError(describeError(error));
    } finally {
      setPriceSaving(false);
    }
  }

  async function removePrice(price: ModelPrice) {
    if (pendingPriceDelete !== price.id) {
      setPendingPriceDelete(price.id);
      return;
    }
    setPendingPriceDelete(null);
    try {
      await api.deletePrice(price.id);
      setPrices((current) => current.filter((item) => item.id !== price.id));
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
          Raw turns older than this window are summarized into daily totals, then pruned in
          the background. Cost is reported by the harness, never estimated here.
        </p>
        <Field label="Retention (days)" hint="0 keeps raw turns forever">
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
            Runs shortly after startup, then hourly. Older history is preserved as daily
            totals. Raising the window cannot restore already-pruned raw turns.
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
            Usage tracking is unavailable, so budgets cannot be measured right now.
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
                {status.state === 'unknown' ? (
                  <p className="text-[11px] text-zinc-500">
                    Spend unknown
                    {status.unknownCostTurns > 0
                      ? ` · ${status.unknownCostTurns} unpriced turn${status.unknownCostTurns === 1 ? '' : 's'}`
                      : ''}
                  </p>
                ) : (
                  <>
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className={
                          status.state === 'exceeded'
                            ? 'h-full rounded-full bg-red-500'
                            : status.state === 'warning'
                              ? 'h-full rounded-full bg-amber-400'
                              : 'h-full rounded-full bg-emerald-500'
                        }
                        style={{
                          width: `${Math.min(100, Math.max(0, status.percentUsed))}%`,
                        }}
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
                  </>
                )}
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
        description="Inherited by cells without their own policy; new cells start with a copy that can diverge."
        onChange={setSegment}
        onFollowUp={setFollowUp}
        onSave={() => void saveProcess()}
      />

      <Card className="space-y-4 p-4">
        <div>
          <SectionTitle>Model pricing</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Used only when the harness does not report cost. Reported cost is never
            overwritten. A model with no effective price stays unknown.
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            USD per 1,000,000 tokens. Enter 0 only when that category is genuinely free.
            A change is a new row with a new effective date.
          </p>
        </div>

        {prices.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No prices configured. Unreported turns remain unknown until you add one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-zinc-600">
                <tr>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Effective</th>
                  <th className="pb-2 text-right font-medium">Input</th>
                  <th className="pb-2 text-right font-medium">Output</th>
                  <th className="pb-2 text-right font-medium">Cache R</th>
                  <th className="pb-2 text-right font-medium">Cache W</th>
                  <th className="pb-2 text-right font-medium">Reasoning</th>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {prices.map((price) => (
                  <tr key={price.id}>
                    <td className="max-w-[14rem] truncate py-2 pr-3 text-zinc-300" title={price.model}>
                      {price.model}
                      {price.note ? (
                        <span className="block truncate text-[10px] text-zinc-600" title={price.note}>
                          {price.note}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-zinc-500">{utcDate(price.effectiveFrom)}</td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.inputUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.outputUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.cacheReadUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.cacheWriteUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.reasoningUsdPerMtok}
                    </td>
                    <td className="max-w-[14rem] truncate py-2 pr-3 text-zinc-500">
                      {price.source.startsWith('http') ? (
                        <a
                          className="text-sky-400 hover:text-sky-300"
                          href={price.source}
                          target="_blank"
                          rel="noreferrer"
                          title={price.source}
                        >
                          {price.source}
                        </a>
                      ) : (
                        <span title={price.source}>{price.source}</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant={pendingPriceDelete === price.id ? 'danger' : 'ghost'}
                        size="sm"
                        aria-label={`Delete price for ${price.model}`}
                        onClick={() => void removePrice(price)}
                      >
                        {pendingPriceDelete === price.id ? 'Confirm?' : 'Delete'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model id" hint="exact match">
            <Input
              value={priceForm.model}
              placeholder="provider/model"
              onChange={(event) => setPrice('model', event.target.value)}
            />
          </Field>
          <Field label="Effective date" hint="UTC">
            <Input
              type="date"
              value={priceForm.effectiveDate}
              onChange={(event) => setPrice('effectiveDate', event.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Input $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.input}
              onChange={(event) => setPrice('input', event.target.value)}
            />
          </Field>
          <Field label="Output $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.output}
              onChange={(event) => setPrice('output', event.target.value)}
            />
          </Field>
          <Field label="Cache read $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.cacheRead}
              onChange={(event) => setPrice('cacheRead', event.target.value)}
            />
          </Field>
          <Field label="Cache write $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.cacheWrite}
              onChange={(event) => setPrice('cacheWrite', event.target.value)}
            />
          </Field>
          <Field label="Reasoning $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.reasoning}
              onChange={(event) => setPrice('reasoning', event.target.value)}
            />
          </Field>
          <Field label="Source" hint="URL or citation">
            <Input
              value={priceForm.source}
              placeholder="https://…"
              onChange={(event) => setPrice('source', event.target.value)}
            />
          </Field>
        </div>

        <Field label="Note" hint="optional">
          <Input
            value={priceForm.note}
            placeholder="Plan, region, or contract note"
            onChange={(event) => setPrice('note', event.target.value)}
          />
        </Field>

        {priceError ? <p className="text-xs text-red-400">{priceError}</p> : null}

        <div className="flex items-center justify-end gap-2">
          <Button variant="primary" disabled={priceSaving} onClick={() => void addPrice()}>
            {priceSaving ? <Spinner /> : 'Add price'}
          </Button>
        </div>
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
                    {cell.maxConcurrent}× · {cell.harness ?? 'brain default'} ·{' '}
                    {cell.monthlyBudgetUsd === null
                      ? 'no budget'
                      : `${moneyLabel(cell.monthlyBudgetUsd)}/mo`}{' '}
                    · {cell.autocompactPercent}% compact
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
          <ul
            aria-label="Recent activity"
            className="max-h-80 divide-y divide-zinc-800 overflow-y-auto overscroll-contain pr-1"
          >
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
