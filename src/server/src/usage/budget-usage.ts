import type { BudgetUsageReader } from '../domain/budget.js';
import type { UsageRepository } from './repository.js';

/**
 * The budget service only needs aggregate totals. The usage repository owns the
 * ledger query, so this adapter keeps that seam narrow and testable.
 */
export function createBudgetUsageReader(
  usage: Pick<UsageRepository, 'totals'>,
): BudgetUsageReader {
  return {
    available: () => true,
    totals: (filter) => usage.totals(filter),
  };
}
