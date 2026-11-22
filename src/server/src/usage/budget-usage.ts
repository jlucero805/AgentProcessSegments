import type { Db } from '../db.js';
import type { BudgetUsageFilter, BudgetUsageReader, BudgetUsageTotals } from '../domain/budget.js';

interface UsageTotalsRow {
  turns: number;
  cost_usd: number | null;
  unknown_cost_turns: number | null;
}

/**
 * Reads the usage ledger without owning it.
 *
 * The usage dashboard lands separately. Until `usage_events` exists this reader
 * reports an unavailable ledger and zero totals, so budget configuration can
 * ship first without creating a second usage schema. Once the parent lands, this
 * adapter can be replaced by its repository's `totals` method.
 */
export function createBudgetUsageReader(db: Db): BudgetUsageReader {
  return {
    available(): boolean {
      const row = db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'")
        .get() as { found: number } | undefined;
      return row !== undefined;
    },

    totals(filter: BudgetUsageFilter): BudgetUsageTotals {
      const table = db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'")
        .get() as { found: number } | undefined;
      if (!table) return { turns: 0, costUsd: null, unknownCostTurns: 0 };

      const where = ['created_at >= ?', 'created_at < ?'];
      const params: Array<string | number> = [filter.from, filter.to];
      if (filter.cellId !== undefined) {
        where.push('cell_id = ?');
        params.push(filter.cellId);
      }

      const row = db
        .prepare(
          `SELECT COUNT(*) AS turns,
                  SUM(cost_usd) AS cost_usd,
                  SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_turns
             FROM usage_events
            WHERE ${where.join(' AND ')}`,
        )
        .get(...params) as UsageTotalsRow;

      return {
        turns: row.turns ?? 0,
        costUsd: row.cost_usd ?? null,
        unknownCostTurns: row.unknown_cost_turns ?? 0,
      };
    },
  };
}
