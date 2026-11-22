import type { UsageTotals } from './types';

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatUsd(value: number): string {
  return value === 0 ? '$0' : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** Show how much of an effective cost came from the harness and how much from prices. */
export function costBreakdown(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.costUsd !== null) parts.push(`reported ${formatUsd(totals.costUsd)}`);
  if (totals.estimatedCostUsd !== null) {
    parts.push(`estimated ${formatUsd(totals.estimatedCostUsd)}`);
  }
  return parts.join(' · ');
}

/**
 * Never turn an unknown price into zero. A mixed total is a lower bound; a
 * total that includes estimates is approximate; reported-only cost is exact.
 */
export function formatCost(totals: UsageTotals): string {
  if (totals.totalCostUsd === null) return totals.turns === 0 ? '—' : 'unknown';
  const value = formatUsd(totals.totalCostUsd);
  if (totals.unpricedTurns > 0) {
    return `≥ ${value} · ${totals.unpricedTurns} unpriced`;
  }
  return totals.estimatedCostTurns > 0 ? `≈ ${value}` : value;
}
