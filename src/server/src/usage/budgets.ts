import type { CellRepository } from '../cells/repository.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';
import {
  budgetAlertThreshold,
  budgetPeriod,
  budgetStatus,
  spendPause,
  type BudgetAlert,
  type BudgetStatus,
  type BudgetsResponse,
  type SpendPause,
} from '../domain/budget.js';
import { BudgetAlertRepository, type BudgetAlertRecord } from './budget-alerts.js';
import type { UsageRepository } from './repository.js';

const DEFAULT_INTERVAL_MS = 60_000;

export interface BudgetServiceDeps {
  usage: Pick<UsageRepository, 'totals'>;
  cells: Pick<CellRepository, 'list' | 'get'>;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  alerts: BudgetAlertRepository;
  errors?: ErrorSink;
  /** Receives the current unacknowledged alerts after reconciliation. */
  onAlerts?: (alerts: BudgetAlert[]) => void;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Computes monthly budget status, reconciles durable alerts, and answers hard-cap
 * admission. Evaluation is synchronous and never throws: a budget failure must not
 * affect a turn, the master, or the HTTP layer.
 */
export class BudgetService {
  private readonly usage: Pick<UsageRepository, 'totals'>;
  private readonly cells: Pick<CellRepository, 'list' | 'get'>;
  private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>;
  private readonly alerts: BudgetAlertRepository;
  private readonly errors?: ErrorSink;
  private readonly onAlerts?: (alerts: BudgetAlert[]) => void;
  private readonly clock: () => number;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: BudgetServiceDeps) {
    this.usage = options.usage;
    this.cells = options.cells;
    this.settings = options.settings;
    this.alerts = options.alerts;
    this.errors = options.errors;
    this.onAlerts = options.onAlerts;
    this.clock = options.now ?? (() => Date.now());
    this.intervalMs =
      options.intervalMs && options.intervalMs > 0
        ? options.intervalMs
        : DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.settings.onChange(() => this.evaluate());
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
    this.timer.unref?.();
    this.evaluate();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  statuses(now = this.clock()): BudgetsResponse {
    const period = budgetPeriod(now);
    const settings = this.settings.get();
    const cells = this.cells.list();
    const statuses: BudgetStatus[] = [];

    if (settings.budget.monthlyUsd !== null) {
      statuses.push(
        budgetStatus({
          scope: 'overall',
          cellId: null,
          cellName: null,
          budgetUsd: settings.budget.monthlyUsd,
          alertAtPercent: settings.budget.alertAtPercent,
          period,
          totals: this.usage.totals({ from: period.start, to: period.end }),
          pauseOnExceeded: settings.budget.pauseOnExceeded,
        }),
      );
    }

    for (const cell of cells) {
      if (cell.monthlyBudgetUsd === null) continue;
      statuses.push(
        budgetStatus({
          scope: 'cell',
          cellId: cell.id,
          cellName: cell.name,
          budgetUsd: cell.monthlyBudgetUsd,
          alertAtPercent: settings.budget.alertAtPercent,
          period,
          totals: this.usage.totals({
            from: period.start,
            to: period.end,
            cellId: cell.id,
          }),
          pauseOnExceeded: cell.pauseOnExceeded,
        }),
      );
    }

    const configured = new Set(
      statuses.map(
        (status) =>
          `${status.scope}:${status.scope === 'overall' ? '' : status.cellId ?? ''}`,
      ),
    );

    return {
      periodStart: period.start,
      periodEnd: period.end,
      alertAtPercent: settings.budget.alertAtPercent,
      statuses,
      alerts: this.alerts
        .listUnacknowledged(period.start)
        .filter((record) => configured.has(`${record.scope}:${record.scopeId}`))
        .map((record) => this.toAlert(record, cells)),
      pauses: statuses.filter((status) => status.paused).map(spendPause),
    };
  }

  /**
   * Return the pause that refuses a new turn for this cell, if any. This is an
   * admission check, not a cancellation: callers use it before starting work.
   * A failed ledger read fails open and is reported to the error sink.
   */
  admission(cellId: string | null, now = this.clock()): SpendPause | null {
    const period = budgetPeriod(now);

    try {
      const settings = this.settings.get();
      if (settings.budget.monthlyUsd !== null && settings.budget.pauseOnExceeded) {
        const status = budgetStatus({
          scope: 'overall',
          cellId: null,
          cellName: null,
          budgetUsd: settings.budget.monthlyUsd,
          alertAtPercent: settings.budget.alertAtPercent,
          period,
          totals: this.usage.totals({ from: period.start, to: period.end }),
          pauseOnExceeded: true,
        });
        if (status.paused) return spendPause(status);
      }

      if (cellId !== null) {
        const cell = this.cells.get(cellId);
        if (
          cell?.monthlyBudgetUsd !== null &&
          cell?.monthlyBudgetUsd !== undefined &&
          cell.pauseOnExceeded
        ) {
          const status = budgetStatus({
            scope: 'cell',
            cellId: cell.id,
            cellName: cell.name,
            budgetUsd: cell.monthlyBudgetUsd,
            alertAtPercent: settings.budget.alertAtPercent,
            period,
            totals: this.usage.totals({
              from: period.start,
              to: period.end,
              cellId: cell.id,
            }),
            pauseOnExceeded: true,
          });
          if (status.paused) return spendPause(status);
        }
      }
    } catch (error) {
      this.errors?.error('usage.budgets', error, {
        periodStart: period.start,
        cellId,
        phase: 'admission',
      });
    }
    return null;
  }

  /** Refresh alert rows for the current month. Never throws. */
  evaluate(now = this.clock()): void {
    let periodStart = budgetPeriod(now).start;
    try {
      const response = this.statuses(now);
      periodStart = response.periodStart;

      const configured = new Set<string>();
      for (const status of response.statuses) {
        const scopeId = status.scope === 'overall' ? '' : status.cellId ?? '';
        configured.add(`${status.scope}:${scopeId}`);
        const threshold = budgetAlertThreshold(status);
        if (threshold === null) {
          this.alerts.removeUnacknowledged(status.scope, scopeId, response.periodStart);
          continue;
        }

        // Acknowledging a higher-severity alert also silences the lower one.
        if (
          threshold === 'warning' &&
          this.alerts.hasAcknowledged(
            status.scope,
            scopeId,
            response.periodStart,
            'exceeded',
            status.budgetUsd,
            response.alertAtPercent,
          )
        ) {
          this.alerts.removeUnacknowledged(status.scope, scopeId, response.periodStart);
          continue;
        }

        this.alerts.upsert(
          {
            scope: status.scope,
            scopeId,
            periodStart: response.periodStart,
            threshold,
            alertAtPercent: response.alertAtPercent,
            budgetUsd: status.budgetUsd,
            spendUsd: status.spendUsd,
            unknownCostTurns: status.unknownCostTurns,
          },
          now,
        );
        this.alerts.removeOtherUnacknowledged(status.scope, scopeId, response.periodStart, {
          threshold,
          budgetUsd: status.budgetUsd,
          alertAtPercent: response.alertAtPercent,
        });
      }

      // Clearing a budget, changing alert identity, or deleting a cell must not
      // leave an actionable alert for a scope that is no longer configured.
      for (const record of this.alerts.listUnacknowledged(response.periodStart)) {
        const key = `${record.scope}:${record.scopeId}`;
        if (!configured.has(key)) {
          this.alerts.removeUnacknowledged(record.scope, record.scopeId, response.periodStart);
        }
      }

      this.alerts.removeUnacknowledgedBefore(response.periodStart);
      // Delivery is a separate hazard domain: a notifier bug must not be
      // reported as a budget-evaluation failure or block the next run.
      try {
        this.onAlerts?.(response.alerts);
      } catch (error) {
        this.errors?.error('budget.notify', error, { phase: 'observe' });
      }
    } catch (error) {
      this.errors?.error('usage.budgets', error, { periodStart });
    }
  }

  acknowledge(id: string, now = this.clock()): BudgetAlert | null {
    const record = this.alerts.acknowledge(id, now);
    if (!record) return null;
    return this.toAlert(record, this.cells.list());
  }

  private toAlert(
    record: BudgetAlertRecord,
    cells: Array<{ id: string; name: string }>,
  ): BudgetAlert {
    const cellId = record.scope === 'cell' ? record.scopeId : null;
    return {
      id: record.id,
      scope: record.scope,
      cellId,
      cellName: cellId ? cells.find((cell) => cell.id === cellId)?.name ?? 'Deleted cell' : null,
      threshold: record.threshold,
      alertAtPercent: record.alertAtPercent,
      budgetUsd: record.budgetUsd,
      spendUsd: record.spendUsd,
      unknownCostTurns: record.unknownCostTurns,
      periodStart: record.periodStart,
      createdAt: record.createdAt,
      acknowledgedAt: record.acknowledgedAt,
    };
  }
}
