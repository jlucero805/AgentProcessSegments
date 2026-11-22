import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { BudgetScope, BudgetThreshold } from '../domain/budget.js';

export interface BudgetAlertRecord {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  periodStart: number;
  threshold: BudgetThreshold;
  alertAtPercent: number;
  budgetUsd: number;
  spendUsd: number;
  unknownCostTurns: number;
  createdAt: number;
  acknowledgedAt: number | null;
}

export interface BudgetAlertInput {
  scope: BudgetScope;
  scopeId: string;
  periodStart: number;
  threshold: BudgetThreshold;
  alertAtPercent: number;
  budgetUsd: number;
  spendUsd: number;
  unknownCostTurns: number;
}

interface BudgetAlertRow {
  id: string;
  scope: BudgetScope;
  scope_id: string;
  period_start: number;
  threshold: BudgetThreshold;
  alert_at_percent: number;
  budget_usd: number;
  spend_usd: number;
  unknown_cost_turns: number;
  created_at: number;
  acknowledged_at: number | null;
}

function toRecord(row: BudgetAlertRow): BudgetAlertRecord {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    periodStart: row.period_start,
    threshold: row.threshold,
    alertAtPercent: row.alert_at_percent,
    budgetUsd: row.budget_usd,
    spendUsd: row.spend_usd,
    unknownCostTurns: row.unknown_cost_turns,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

/**
 * Durable budget-alert rows. The unique identity includes the budget amount and
 * warning percentage, so changing either starts a new generation without
 * deleting acknowledged history.
 */
export class BudgetAlertRepository {
  constructor(private readonly db: Db) {}

  upsert(input: BudgetAlertInput, now: number): BudgetAlertRecord {
    this.db
      .prepare(
        `INSERT INTO budget_alerts
           (id, scope, scope_id, period_start, threshold, alert_at_percent, budget_usd,
            spend_usd, unknown_cost_turns, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(scope, scope_id, period_start, threshold, budget_usd, alert_at_percent)
         DO UPDATE SET spend_usd = excluded.spend_usd,
                       unknown_cost_turns = excluded.unknown_cost_turns
         WHERE budget_alerts.acknowledged_at IS NULL`,
      )
      .run(
        randomUUID(),
        input.scope,
        input.scopeId,
        input.periodStart,
        input.threshold,
        input.alertAtPercent,
        input.budgetUsd,
        input.spendUsd,
        input.unknownCostTurns,
        now,
      );

    const row = this.db
      .prepare(
        `SELECT * FROM budget_alerts
          WHERE scope = ? AND scope_id = ? AND period_start = ? AND threshold = ?
            AND budget_usd = ? AND alert_at_percent = ?`,
      )
      .get(
        input.scope,
        input.scopeId,
        input.periodStart,
        input.threshold,
        input.budgetUsd,
        input.alertAtPercent,
      ) as BudgetAlertRow;
    return toRecord(row);
  }

  get(id: string): BudgetAlertRecord | null {
    const row = this.db.prepare('SELECT * FROM budget_alerts WHERE id = ?').get(id) as
      | BudgetAlertRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  acknowledge(id: string, now: number): BudgetAlertRecord | null {
    this.db
      .prepare(
        'UPDATE budget_alerts SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?',
      )
      .run(now, id);
    return this.get(id);
  }

  listUnacknowledged(periodStart: number): BudgetAlertRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM budget_alerts
          WHERE acknowledged_at IS NULL AND period_start = ?
          ORDER BY created_at DESC`,
      )
      .all(periodStart) as BudgetAlertRow[];
    return rows.map(toRecord);
  }

  hasAcknowledged(
    scope: BudgetScope,
    scopeId: string,
    periodStart: number,
    threshold: BudgetThreshold,
    budgetUsd: number,
    alertAtPercent: number,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM budget_alerts
          WHERE scope = ? AND scope_id = ? AND period_start = ? AND threshold = ?
            AND budget_usd = ? AND alert_at_percent = ? AND acknowledged_at IS NOT NULL
          LIMIT 1`,
      )
      .get(scope, scopeId, periodStart, threshold, budgetUsd, alertAtPercent) as
      | { found: number }
      | undefined;
    return row !== undefined;
  }

  removeOtherUnacknowledged(
    scope: BudgetScope,
    scopeId: string,
    periodStart: number,
    keep: Pick<BudgetAlertInput, 'threshold' | 'budgetUsd' | 'alertAtPercent'>,
  ): number {
    return this.db
      .prepare(
        `DELETE FROM budget_alerts
          WHERE scope = ? AND scope_id = ? AND period_start = ? AND acknowledged_at IS NULL
            AND NOT (threshold = ? AND budget_usd = ? AND alert_at_percent = ?)`,
      )
      .run(
        scope,
        scopeId,
        periodStart,
        keep.threshold,
        keep.budgetUsd,
        keep.alertAtPercent,
      ).changes;
  }

  removeUnacknowledged(scope: BudgetScope, scopeId: string, periodStart: number): number {
    return this.db
      .prepare(
        `DELETE FROM budget_alerts
          WHERE scope = ? AND scope_id = ? AND period_start = ? AND acknowledged_at IS NULL`,
      )
      .run(scope, scopeId, periodStart).changes;
  }

  removeUnacknowledgedBefore(periodStart: number): number {
    return this.db
      .prepare('DELETE FROM budget_alerts WHERE acknowledged_at IS NULL AND period_start < ?')
      .run(periodStart).changes;
  }
}
