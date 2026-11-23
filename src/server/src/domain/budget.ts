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
  /** When true, new work is paused once cap spend reaches the overall budget. */
  pauseOnExceeded: boolean;
}

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  monthlyUsd: null,
  alertAtPercent: 80,
  pauseOnExceeded: false,
};

export const MAX_BUDGET_USD = 1_000_000;

/** Known-cost totals for one budget period. Kept narrow so tests can fake it. */
export interface BudgetUsageTotals {
  turns: number;
  /** Sum of known cost_usd values; null when no turn reported a cost. */
  costUsd: number | null;
  /** Sum of estimates for unreported turns; null when none matched a price. */
  estimatedCostUsd: number | null;
  /** Turns with neither a reported nor an estimated cost. */
  unpricedTurns: number;
  /** Turns with no harness-reported cost (estimated + unpriced). */
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
  /** True when this scope pauses new work at the budget. */
  pauseOnExceeded: boolean;
  /** Reported plus estimated cost; used by hard caps only. */
  capSpendUsd: number;
  /** True when an unpriced turn makes cap spend a lower bound. */
  capSpendIsLowerBound: boolean;
  /** Turns with neither a reported nor an estimated cost. */
  unpricedTurns: number;
  /** True when this scope is currently refusing new work. */
  paused: boolean;
}

/** A scope that is currently refusing new work because of a hard cap. */
export interface SpendPause {
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  label: string;
  periodStart: number;
  periodEnd: number;
  budgetUsd: number;
  spendUsd: number;
  spendIsLowerBound: boolean;
  unpricedTurns: number;
  percentUsed: number;
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
  /** Overall first, then cells by name. Only paused scopes appear. */
  pauses: SpendPause[];
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
  pauseOnExceeded?: boolean;
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
    pauseOnExceeded = false,
  } = input;
  const pricedTurns = Math.max(0, totals.turns - totals.unknownCostTurns);
  const spendUsd = totals.costUsd ?? 0;
  const spendIsLowerBound = totals.unknownCostTurns > 0;
  const percentUsed = budgetUsd > 0 ? (spendUsd / budgetUsd) * 100 : 0;
  const capSpendUsd = spendUsd + (totals.estimatedCostUsd ?? 0);
  const capSpendIsLowerBound = totals.unpricedTurns > 0;
  const paused =
    pauseOnExceeded && usageAvailable && capSpendUsd >= budgetUsd;

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
    pauseOnExceeded,
    capSpendUsd,
    capSpendIsLowerBound,
    unpricedTurns: totals.unpricedTurns,
    paused,
  };
}

/** Convert a paused status into the admission payload. */
export function spendPause(status: BudgetStatus): SpendPause {
  return {
    scope: status.scope,
    cellId: status.cellId,
    cellName: status.cellName,
    label: status.label,
    periodStart: status.periodStart,
    periodEnd: status.periodEnd,
    budgetUsd: status.budgetUsd,
    spendUsd: status.capSpendUsd,
    spendIsLowerBound: status.capSpendIsLowerBound,
    unpricedTurns: status.unpricedTurns,
    percentUsed: status.capSpendUsd > 0 ? (status.capSpendUsd / status.budgetUsd) * 100 : 0,
  };
}

/** The highest alert threshold crossed by a status, or null. */
export function budgetAlertThreshold(status: BudgetStatus): BudgetThreshold | null {
  if (status.state === 'exceeded') return 'exceeded';
  if (status.state === 'warning') return 'warning';
  return null;
}
