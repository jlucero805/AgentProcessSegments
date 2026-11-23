import { PRICE_TOKEN_BASIS } from '../pricing/types.js';
import { USAGE_BUCKET_MS } from './types.js';

/**
 * Effective-dated price lookup: exact model, newest row at or before the turn.
 * Shared by raw queries and the daily rollup writer so both estimate
 * unreported cost with identical rules.
 */
export const PRICE_JOIN = `
  LEFT JOIN model_pricing p ON p.id = (
    SELECT p2.id FROM model_pricing p2
     WHERE p2.model = u.model AND p2.effective_from <= u.created_at
     ORDER BY p2.effective_from DESC
     LIMIT 1
  )
`;

/** Null for a priced turn or an unmatched model; never a guessed number. */
export const ESTIMATE_SQL = `CASE WHEN u.cost_usd IS NULL AND p.id IS NOT NULL THEN
  (u.input_tokens * p.input_usd_per_mtok
 + u.output_tokens * p.output_usd_per_mtok
 + u.cache_read_tokens * p.cache_read_usd_per_mtok
 + u.cache_write_tokens * p.cache_write_usd_per_mtok
 + u.reasoning_tokens * p.reasoning_usd_per_mtok) / ${PRICE_TOKEN_BASIS}.0
END`;

/** 1 when this raw turn contributed to estimated cost, 0 otherwise. */
export const ESTIMATE_TURN_SQL = `CASE WHEN u.cost_usd IS NULL AND p.id IS NOT NULL THEN 1 ELSE 0 END`;

/**
 * Raw ledger rows and daily rollups share one shape. `period_start` and
 * `period_end` make range filtering work for both without special cases:
 * raw rows are one millisecond wide, daily rows are one UTC day wide, so a
 * range that overlaps a rolled-up day includes that day in full.
 */
const RAW_SOURCE = `
  SELECT
    u.created_at AS period_start,
    u.created_at + 1 AS period_end,
    1 AS turns,
    u.scope AS scope,
    COALESCE(u.cell_id, '') AS cell_id,
    COALESCE(u.request_id, '') AS request_id,
    COALESCE(u.model, '') AS model,
    u.input_tokens AS input_tokens,
    u.output_tokens AS output_tokens,
    u.cache_read_tokens AS cache_read_tokens,
    u.cache_write_tokens AS cache_write_tokens,
    u.reasoning_tokens AS reasoning_tokens,
    u.cost_usd AS cost_usd,
    CASE WHEN u.cost_usd IS NULL THEN 0 ELSE 1 END AS reported_cost_turns,
    ${ESTIMATE_SQL} AS estimated_cost_usd,
    ${ESTIMATE_TURN_SQL} AS estimated_cost_turns
  FROM usage_events u
  ${PRICE_JOIN}
  WHERE u.created_at >= @rawSince
`;

const DAILY_SOURCE = `
  SELECT
    d.day_start AS period_start,
    d.day_start + ${USAGE_BUCKET_MS.day} AS period_end,
    d.turns AS turns,
    d.scope AS scope,
    d.cell_id AS cell_id,
    d.request_id AS request_id,
    d.model AS model,
    d.input_tokens AS input_tokens,
    d.output_tokens AS output_tokens,
    d.cache_read_tokens AS cache_read_tokens,
    d.cache_write_tokens AS cache_write_tokens,
    d.reasoning_tokens AS reasoning_tokens,
    d.reported_cost_usd AS cost_usd,
    d.reported_cost_turns AS reported_cost_turns,
    d.estimated_cost_usd AS estimated_cost_usd,
    d.estimated_cost_turns AS estimated_cost_turns
  FROM usage_daily d
  WHERE d.day_start < @rawSince
`;

/**
 * Build the query source. Raw rows are authoritative at or after the rollup
 * watermark; daily rows cover everything before it, so the arms never overlap.
 */
export function usageSource(includeDaily: boolean): string {
  return includeDaily ? `(${RAW_SOURCE} UNION ALL ${DAILY_SOURCE})` : `(${RAW_SOURCE})`;
}

/** Aggregate select for the normalized source alias `x`. */
export const USAGE_AGGREGATE = `
  SUM(x.turns) AS turns,
  COALESCE(SUM(x.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(x.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(x.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(x.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(x.reasoning_tokens), 0) AS reasoning_tokens,
  SUM(x.cost_usd) AS cost_usd,
  COALESCE(SUM(x.reported_cost_turns), 0) AS reported_cost_turns,
  SUM(x.estimated_cost_usd) AS estimated_cost_usd,
  COALESCE(SUM(x.estimated_cost_turns), 0) AS estimated_cost_turns
`;

/**
 * Known-cost groups first, then effective cost, tokens, and key. Uses aggregate
 * expressions so a merged raw/daily group keeps the same order as before.
 */
export const GROUP_ORDER_BY = `
  (SUM(x.cost_usd) IS NULL AND SUM(x.estimated_cost_usd) IS NULL),
  (COALESCE(SUM(x.cost_usd), 0) + COALESCE(SUM(x.estimated_cost_usd), 0)) DESC,
  SUM(x.input_tokens + x.output_tokens + x.cache_read_tokens + x.cache_write_tokens + x.reasoning_tokens) DESC,
  key
`;
