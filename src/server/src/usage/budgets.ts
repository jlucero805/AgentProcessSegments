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
  type BudgetScope,
  type BudgetsResponse,
  type SpendCapOverride,
  type SpendPause,
} from '../domain/budget.js';
import { BudgetAlertRepository, type BudgetAlertRecord } from './budget-alerts.js';
import type { UsageRepository } from './repository.js';
import { SpendCapOverrideError } from './spend-cap.js';
import {
  SpendCapOverrideRepository,
  type SpendCapOverrideRecord,
} from './spend-cap-overrides.js';

const DEFAULT_INTERVAL_MS = 60_000;
const OVERRIDE_RETENTION_MS = 400 * 86_400_000;

export interface SpendCapOverrideGrantInput {
  scope: BudgetScope;
  cellId: string | null;
  /** Positive whole minutes; clamped before the end of the UTC period. */
  minutes: number;
  note: string | null;
}

export interface BudgetServiceDeps {
  usage: Pick<UsageRepository, 'totals'>;
  cells: Pick<CellRepository, 'list' | 'get'>;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  alerts: BudgetAlertRepository;
  overrides: SpendCapOverrideRepository;
  errors?: ErrorSink;
  /** Receives the current unacknowledged alerts after reconciliation. */
  onAlerts?: (alerts: BudgetAlert[]) => void;
  /** Runs after a successful evaluation so hard caps can stop in-flight turns. */
  onEvaluated?: () => void;
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
  private readonly overrides: SpendCapOverrideRepository;
  private readonly errors?: ErrorSink;
  private readonly onAlerts?: (alerts: BudgetAlert[]) => void;
  private readonly onEvaluated?: () => void;
  private readonly clock: () => number;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: BudgetServiceDeps) {
    this.usage = options.usage;
    this.cells = options.cells;
    this.settings = options.settings;
    this.alerts = options.alerts;
    this.overrides = options.overrides;
    this.errors = options.errors;
    this.onAlerts = options.onAlerts;
    this.onEvaluated = options.onEvaluated;
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
    const active = this.overrides.listActive(period.start, now);
    const overallOverride =
      settings.budget.monthlyUsd !== null && settings.budget.pauseOnExceeded
        ? active.find((record) => record.scope === 'overall') ?? null
        : null;

    if (settings.budget.monthlyUsd !== null) {
      statuses.push(
        this.withOverride(
          budgetStatus({
            scope: 'overall',
            cellId: null,
            cellName: null,
            budgetUsd: settings.budget.monthlyUsd,
            alertAtPercent: settings.budget.alertAtPercent,
            period,
            totals: this.usage.totals({ from: period.start, to: period.end }),
            pauseOnExceeded: settings.budget.pauseOnExceeded,
            pauseOnUnknownCost: settings.budget.pauseOnUnknownCost,
          }),
          overallOverride,
          null,
        ),
      );
    }

    for (const cell of cells) {
      if (cell.monthlyBudgetUsd === null) continue;
      const cellOverride =
        active.find(
          (record) => record.scope === 'cell' && record.scopeId === cell.id,
        ) ?? null;
      statuses.push(
        this.withOverride(
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
            pauseOnUnknownCost: cell.pauseOnUnknownCost,
          }),
          overallOverride,
          cellOverride,
        ),
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
      overrides: active
        .map((record) => this.toOverride(record))
        .sort((left, right) => {
          if (left.scope !== right.scope) return left.scope === 'overall' ? -1 : 1;
          return (left.cellName ?? '').localeCompare(right.cellName ?? '');
        }),
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
      const overallHardCap =
        settings.budget.monthlyUsd !== null && settings.budget.pauseOnExceeded;
      const overallOverride = overallHardCap
        ? this.overrides.activeFor('overall', '', period.start, now)
        : null;

      if (overallHardCap && settings.budget.monthlyUsd !== null) {
        const status = budgetStatus({
          scope: 'overall',
          cellId: null,
          cellName: null,
          budgetUsd: settings.budget.monthlyUsd,
          alertAtPercent: settings.budget.alertAtPercent,
          period,
          totals: this.usage.totals({ from: period.start, to: period.end }),
          pauseOnExceeded: true,
          pauseOnUnknownCost: settings.budget.pauseOnUnknownCost,
        });
        if (status.paused && !overallOverride) return spendPause(status);
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
            pauseOnUnknownCost: cell.pauseOnUnknownCost,
          });
          if (status.paused) {
            const cellOverride = this.overrides.activeFor(
              'cell',
              cell.id,
              period.start,
              now,
            );
            if (!overallOverride && !cellOverride) return spendPause(status);
          }
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

  /**
   * Grant or extend a bounded override for one scope. An override only suppresses
   * admission; it never changes budget status or alerts.
   */
  grantOverride(
    input: SpendCapOverrideGrantInput,
    now = this.clock(),
  ): { override: SpendCapOverride; created: boolean } {
    const period = budgetPeriod(now);
    const settings = this.settings.get();
    let scopeId = '';

    if (input.scope === 'overall') {
      if (
        settings.budget.monthlyUsd === null ||
        !settings.budget.pauseOnExceeded
      ) {
        throw new SpendCapOverrideError(
          'cap_not_configured',
          'the overall budget is not a configured hard cap',
        );
      }
    } else {
      const cell = input.cellId === null ? null : this.cells.get(input.cellId);
      const cellLabel = cell?.name ?? input.cellId ?? 'cell';
      if (
        !cell ||
        cell.monthlyBudgetUsd === null ||
        !cell.pauseOnExceeded
      ) {
        throw new SpendCapOverrideError(
          'cap_not_configured',
          `${cellLabel} does not have a configured hard cap`,
        );
      }
      scopeId = cell.id;
    }

    const expiresAt = Math.min(now + input.minutes * 60_000, period.end - 1);
    if (expiresAt <= now) {
      throw new SpendCapOverrideError(
        'period_ending',
        'the current budget period is ending; the override would expire immediately',
      );
    }

    const { record, created } = this.overrides.grant(
      {
        scope: input.scope,
        scopeId,
        periodStart: period.start,
        expiresAt,
        note: input.note,
      },
      now,
    );
    return { override: this.toOverride(record), created };
  }

  /**
   * Revoke an override early; an already-revoked row is returned unchanged.
   * A revoke is a policy edit: re-evaluate immediately so the enforcer stops
   * live turns in a scope that is still over its cap (D65/D68).
   */
  revokeOverride(id: string, now = this.clock()): SpendCapOverride | null {
    const record = this.overrides.revoke(id, now);
    if (!record) return null;
    this.evaluate(now);
    return this.toOverride(record);
  }

  private withOverride(
    status: BudgetStatus,
    overall: SpendCapOverrideRecord | null,
    cell: SpendCapOverrideRecord | null,
  ): BudgetStatus {
    const own = status.scope === 'overall' ? overall : cell;
    const covering =
      own === null
        ? overall
        : overall === null
          ? own
          : overall.expiresAt >= own.expiresAt
            ? overall
            : own;
    return {
      ...status,
      overrideId: covering?.id ?? null,
      overrideExpiresAt: covering?.expiresAt ?? null,
    };
  }

  private toOverride(record: SpendCapOverrideRecord): SpendCapOverride {
    const cellId = record.scope === 'cell' ? record.scopeId : null;
    return {
      id: record.id,
      scope: record.scope,
      cellId,
      cellName: cellId ? this.cells.get(cellId)?.name ?? 'Deleted cell' : null,
      periodStart: record.periodStart,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      note: record.note,
      revokedAt: record.revokedAt,
    };
  }

  /** Refresh alert rows for the current month. Never throws. */
  evaluate(now = this.clock()): void {
    let periodStart = budgetPeriod(now).start;
    try {
      this.overrides.pruneBefore(budgetPeriod(now - OVERRIDE_RETENTION_MS).start);
    } catch (error) {
      this.errors?.error('usage.budgets', error, { phase: 'override-prune' });
    }
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
      // Enforcement is a separate hazard domain: a bug there must not be
      // reported as a budget-evaluation failure or block the next run.
      try {
        this.onEvaluated?.();
      } catch (error) {
        this.errors?.error('budget.enforce', error, { periodStart: response.periodStart });
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
