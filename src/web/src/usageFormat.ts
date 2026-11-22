import type { UsageTotals } from './types';

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/** Never turn an unknown price into zero; show the lower bound instead. */
export function formatCost(totals: UsageTotals): string {
  if (totals.costUsd === null) return totals.turns === 0 ? '—' : 'unknown';
  const value =
    totals.costUsd === 0
      ? '$0'
      : `$${totals.costUsd.toFixed(totals.costUsd < 1 ? 4 : 2)}`;
  return totals.unknownCostTurns > 0
    ? `≥ ${value} · ${totals.unknownCostTurns} unpriced`
    : value;
}
