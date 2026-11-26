/**
 * Pure usage contract shared by the brain and the SPA. Keep this module free of
 * Node imports so Vite can bundle it through `src/web/src/types.ts`.
 */
import type { SegmentId } from '../process/definition.js';

export const USAGE_SCOPES = ['request', 'master', 'kb', 'setup'] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

export const USAGE_BUCKETS = ['hour', 'day'] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

export const USAGE_BUCKET_MS: Record<UsageBucket, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

export interface UsageEventInput {
  turnId: string;
  sessionId: string;
  scope: UsageScope;
  cellId: string | null;
  requestId: string | null;
  model: string | null;
  effort: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** The harness-reported cost, or null when no complete cost was reported. */
  costUsd: number | null;
  /** Process segment that ran the turn; null outside the request pipeline. */
  segment?: SegmentId | null;
  createdAt?: number;
}

export interface UsageFilter {
  cellId?: string | undefined;
  requestId?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  bucket?: UsageBucket | undefined;
  limit?: number | undefined;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Sum of harness-reported costs. Null when no turn reported a cost. */
  costUsd: number | null;
  /** Sum of estimates for unreported turns that matched an effective price. */
  estimatedCostUsd: number | null;
  /** costUsd + estimatedCostUsd. Null only when neither is known. */
  totalCostUsd: number | null;
  /** Turns with a harness-reported cost. */
  reportedCostTurns: number;
  /** Turns without a reported cost that matched an effective price. */
  estimatedCostTurns: number;
  /** Turns with neither a reported nor an estimated cost. */
  unpricedTurns: number;
  /** Turns with no harness-reported cost (estimatedCostTurns + unpricedTurns). */
  unknownCostTurns: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
  /** Request groups carry the request's current cell for the usage table. */
  cellId?: string;
  cellLabel?: string;
}

export interface UsageBucketRow extends UsageTotals {
  bucketStart: number;
}

/**
 * One cell/segment pair. Cycle time is separate from usage: a segment can hold
 * a request for a long wall-clock time with no turns, or run turns with no
 * reported cost.
 */
export interface UsageCellSegmentGroup extends UsageTotals {
  key: string;
  /** Canonical segment label, or "Unattributed" for non-pipeline spend. */
  label: string;
  cellId: string;
  cellLabel: string;
  segment: SegmentId | null;
  /** Wall-clock time in the segment, including idle and waiting. */
  wallMs: number;
  /** Time covered by agent turns running in the segment. */
  activeMs: number;
}

export interface UsageCoverage {
  /**
   * Exclusive boundary between daily rollups and raw rows. Raw rows exist at
   * or after this timestamp; daily rollups cover everything before it. Null
   * when no rollup has run.
   */
  rolledThrough: number | null;
  /**
   * Raw rows older than this many days are pruned; `0` keeps them forever.
   * Served from `usage.retentionDays` so the dashboard can explain what
   * "all time" covers without a second settings request.
   */
  retentionDays: number;
}

export interface UsageResponse {
  range: { from: number | null; to: number | null };
  totals: UsageTotals;
  series: UsageBucketRow[];
  byModel: UsageGroup[];
  byCell: UsageGroup[];
  byRequest: UsageGroup[];
  byCellSegment: UsageCellSegmentGroup[];
  coverage: UsageCoverage;
}

export function totalTokens(tokens: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}): number {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheReadTokens +
    tokens.cacheWriteTokens +
    tokens.reasoningTokens
  );
}

/** UTC-aligned bucket start for an epoch-ms timestamp. */
export function usageBucketStart(timestamp: number, bucket: UsageBucket): number {
  return Math.floor(timestamp / USAGE_BUCKET_MS[bucket]) * USAGE_BUCKET_MS[bucket];
}
