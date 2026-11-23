/**
 * Spend-budget contract shared by the server and the SPA. Keep this module free
 * of Node-only imports so `src/web/src/types.ts` can re-export it for Vite.
 */

export const BUDGET_SCOPES = ['overall', 'cell'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_THRESHOLDS = ['warning', 'exceeded'] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

export type BudgetState = 'ok' | 'warning' | 'exceeded' | 'unknown';

/** The operator-editable brain-level budget policy. */
export interface BudgetSettings {
  /** Null disables the overall budget. */
  monthlyUsd: number | null;
  /** Warning percentage for every budget; 100 means only the exceeded alert. */
  alertAtPercent: number;
}

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  monthlyUsd: null,
  alertAtPercent: 80,
};

export const MAX_BUDGET_USD = 1_000_000;

/** Known-cost totals for one budget period. Kept narrow so tests can fake it. */
export interface BudgetUsageTotals {
  turns: number;
  /** Sum of known cost_usd values; null when no turn reported a cost. */
  costUsd: number | null;
  unknownCostTurns: number;
}

export interface BudgetUsageFilter {
  from: number;
  to: number;
  cellId?: string;
}

/** The usage ledger seam. The parent usage dashboard can satisfy this shape. */
export interface BudgetUsageReader {
  available(): boolean;
  totals(filter: BudgetUsageFilter): BudgetUsageTotals;
}

export interface BudgetStatus {
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  label: string;
  periodStart: number;
  periodEnd: number;
  budgetUsd: number;
  /** Known cost only. Zero when nothing is priced. */
  spendUsd: number;
  /** max(0, budgetUsd - spendUsd); an upper bound when spend is a lower bound. */
  remainingUsd: number;
  percentUsed: number;
  pricedTurns: number;
  unknownCostTurns: number;
  spendIsLowerBound: boolean;
  state: BudgetState;
}

export interface BudgetAlert {
  id: string;
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  threshold: BudgetThreshold;
  alertAtPercent: number;
  budgetUsd: number;
  spendUsd: number;
  unknownCostTurns: number;
  periodStart: number;
  createdAt: number;
  acknowledgedAt: number | null;
}

export interface BudgetsResponse {
  periodStart: number;
  periodEnd: number;
  alertAtPercent: number;
  /** False until the usage ledger exists; budgets are configured but unmeasurable. */
  usageAvailable: boolean;
  /** Overall first, then cells by name. Only configured budgets appear. */
  statuses: BudgetStatus[];
  /** Unacknowledged alerts for the current period only. */
  alerts: BudgetAlert[];
}

export const WEBHOOK_FORMATS = ['json', 'slack', 'discord'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Outbound budget-alert webhook policy. The secret is never returned by the API. */
export interface WebhookSettings {
  enabled: boolean;
  url: string | null;
  format: WebhookFormat;
  secret: string | null;
}

/** A webhook patch may omit any field; omitted fields keep their stored value. */
export type WebhookPatch = Partial<WebhookSettings>;

export interface NotificationsSettings {
  webhook: WebhookSettings;
}

/** The API view: the secret is always redacted and `secretSet` reports its presence. */
export interface WebhookView {
  enabled: boolean;
  url: string | null;
  format: WebhookFormat;
  secret: null;
  secretSet: boolean;
}

export interface NotificationsView {
  webhook: WebhookView;
}

export const DEFAULT_NOTIFICATIONS: NotificationsSettings = {
  webhook: { enabled: false, url: null, format: 'json', secret: null },
};

export const DELIVERY_STATUSES = [
  'pending',
  'delivering',
  'delivered',
  'failed',
  'skipped',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const WEBHOOK_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Validate an operator-supplied webhook URL. https is required except for a
 * loopback collector, which is useful for local testing.
 */
export function webhookUrlError(value: string): string | null {
  if (value.length > 2048) return 'must be at most 2048 characters';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'must use http or https';
  }
  if (url.username !== '' || url.password !== '') {
    return 'must not contain credentials';
  }
  if (url.hash !== '') return 'must not contain a fragment';
  if (url.protocol === 'http:' && !WEBHOOK_LOOPBACK_HOSTS.has(url.hostname)) {
    return 'http is only allowed for localhost or loopback addresses';
  }
  return null;
}

const alertMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** Human-readable alert sentence shared by the banner and outbound delivery. */
export function budgetAlertText(alert: BudgetAlert): string {
  const label = alert.scope === 'overall' ? 'Overall spend' : alert.cellName ?? 'Cell spend';
  const spend =
    alert.unknownCostTurns > 0
      ? `at least ${alertMoney.format(alert.spendUsd)}`
      : alertMoney.format(alert.spendUsd);
  if (alert.threshold === 'exceeded') {
    return `${label} is over its ${alertMoney.format(alert.budgetUsd)} monthly budget (${spend}).`;
  }
  return `${label} reached ${alert.alertAtPercent.toFixed(0)}% of its ${alertMoney.format(alert.budgetUsd)} monthly budget (${spend}).`;
}

export interface BudgetAlertEvent {
  version: 1;
  event: 'budget.alert' | 'budget.test';
  alert: {
    id: string;
    scope: BudgetScope;
    cellId: string | null;
    cellName: string | null;
    threshold: BudgetThreshold;
    alertAtPercent: number;
    budgetUsd: number;
    spendUsd: number;
    spendIsLowerBound: boolean;
    unknownCostTurns: number;
    periodStart: number;
    periodEnd: number;
    createdAt: number;
  };
  text: string;
}

/** Build the stable JSON event sent to a webhook. */
export function budgetAlertEvent(
  alert: BudgetAlert,
  event: BudgetAlertEvent['event'] = 'budget.alert',
): BudgetAlertEvent {
  return {
    version: 1,
    event,
    alert: {
      id: alert.id,
      scope: alert.scope,
      cellId: alert.cellId,
      cellName: alert.cellName,
      threshold: alert.threshold,
      alertAtPercent: alert.alertAtPercent,
      budgetUsd: alert.budgetUsd,
      spendUsd: alert.spendUsd,
      spendIsLowerBound: alert.unknownCostTurns > 0,
      unknownCostTurns: alert.unknownCostTurns,
      periodStart: alert.periodStart,
      periodEnd: budgetPeriod(alert.periodStart).end,
      createdAt: alert.createdAt,
    },
    text: budgetAlertText(alert),
  };
}

export interface BudgetPeriod {
  start: number;
  end: number;
}

/** UTC calendar month containing `now`. */
export function budgetPeriod(now: number): BudgetPeriod {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start, end };
}

export interface BudgetStatusInput {
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  budgetUsd: number;
  alertAtPercent: number;
  period: BudgetPeriod;
  totals: BudgetUsageTotals;
  usageAvailable?: boolean;
}

export function budgetStatus(input: BudgetStatusInput): BudgetStatus {
  const {
    scope,
    cellId,
    cellName,
    budgetUsd,
    alertAtPercent,
    period,
    totals,
    usageAvailable = true,
  } = input;
  const pricedTurns = Math.max(0, totals.turns - totals.unknownCostTurns);
  const spendUsd = totals.costUsd ?? 0;
  const spendIsLowerBound = totals.unknownCostTurns > 0;
  const percentUsed = budgetUsd > 0 ? (spendUsd / budgetUsd) * 100 : 0;

  let state: BudgetState;
  if (!usageAvailable) {
    state = 'unknown';
  } else if (totals.turns > 0 && pricedTurns === 0) {
    state = 'unknown';
  } else if (spendUsd >= budgetUsd) {
    state = 'exceeded';
  } else if (
    alertAtPercent < 100 &&
    spendUsd >= (budgetUsd * alertAtPercent) / 100
  ) {
    state = 'warning';
  } else {
    state = 'ok';
  }

  return {
    scope,
    cellId,
    cellName,
    label: scope === 'overall' ? 'Overall' : cellName ?? 'Cell',
    periodStart: period.start,
    periodEnd: period.end,
    budgetUsd,
    spendUsd,
    remainingUsd: Math.max(0, budgetUsd - spendUsd),
    percentUsed,
    pricedTurns,
    unknownCostTurns: totals.unknownCostTurns,
    spendIsLowerBound,
    state,
  };
}

/** The highest alert threshold crossed by a status, or null. */
export function budgetAlertThreshold(status: BudgetStatus): BudgetThreshold | null {
  if (status.state === 'exceeded') return 'exceeded';
  if (status.state === 'warning') return 'warning';
  return null;
}
