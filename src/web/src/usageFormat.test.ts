import { describe, expect, it } from 'vitest';
import { costBreakdown, formatCost, formatDuration } from './usageFormat';
import { makeUsageTotals } from './test/fixtures';

describe('usage cost formatting', () => {
  it('renders reported-only cost as exact', () => {
    const totals = makeUsageTotals({
      costUsd: 1.23,
      estimatedCostUsd: null,
      totalCostUsd: 1.23,
      reportedCostTurns: 2,
      estimatedCostTurns: 0,
      unpricedTurns: 0,
      unknownCostTurns: 0,
    });
    expect(formatCost(totals)).toBe('$1.23');
    expect(costBreakdown(totals)).toBe('reported $1.23');
  });

  it('marks an estimate-only total as approximate', () => {
    const totals = makeUsageTotals({
      costUsd: null,
      estimatedCostUsd: 0.004,
      totalCostUsd: 0.004,
      reportedCostTurns: 0,
      estimatedCostTurns: 2,
      unpricedTurns: 0,
      unknownCostTurns: 2,
    });
    expect(formatCost(totals)).toBe('≈ $0.0040');
    expect(costBreakdown(totals)).toBe('estimated $0.0040');
  });

  it('marks any unpriced turns as a lower bound', () => {
    const totals = makeUsageTotals({
      costUsd: 0.012,
      estimatedCostUsd: 0.004,
      totalCostUsd: 0.016,
      reportedCostTurns: 1,
      estimatedCostTurns: 1,
      unpricedTurns: 2,
      unknownCostTurns: 3,
    });
    expect(formatCost(totals)).toBe('≥ $0.0160 · 2 unpriced');
    expect(costBreakdown(totals)).toBe('reported $0.0120 · estimated $0.0040');
  });

  it('never turns a missing cost into zero', () => {
    const totals = makeUsageTotals({
      turns: 2,
      costUsd: null,
      estimatedCostUsd: null,
      totalCostUsd: null,
      reportedCostTurns: 0,
      estimatedCostTurns: 0,
      unpricedTurns: 2,
      unknownCostTurns: 2,
    });
    expect(formatCost(totals)).toBe('unknown');
    expect(costBreakdown(totals)).toBe('');
    expect(formatCost(makeUsageTotals({ turns: 0, totalCostUsd: null }))).toBe('—');
  });

  it('formats cycle time coarsely and keeps missing time distinct', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(400)).toBe('<1s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
    expect(formatDuration(50 * 60 * 60_000)).toBe('2d 2h');
  });

  it('renders a known zero as zero', () => {
    const totals = makeUsageTotals({
      costUsd: null,
      estimatedCostUsd: 0,
      totalCostUsd: 0,
      reportedCostTurns: 0,
      estimatedCostTurns: 1,
      unpricedTurns: 0,
      unknownCostTurns: 1,
    });
    expect(formatCost(totals)).toBe('≈ $0');
  });
});
