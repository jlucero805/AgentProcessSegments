import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import {
  GROUP_ORDER_BY,
  USAGE_AGGREGATE,
  usageSource,
} from './sql.js';
import {
  USAGE_BUCKET_MS,
  totalTokens,
  usageBucketStart,
  type UsageBucketRow,
  type UsageEventInput,
  type UsageFilter,
  type UsageGroup,
  type UsageResponse,
  type UsageTotals,
} from './types.js';

interface AggregateRow {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  reported_cost_turns: number;
  estimated_cost_usd: number | null;
  estimated_cost_turns: number;
}

interface GroupRow extends AggregateRow {
  key: string;
  label: string;
  cell_id?: string | null;
  cell_label?: string | null;
}

interface BucketRow extends AggregateRow {
  bucket_start: number;
}

/** Keep an accidental all-time hourly query from building a huge array. */
const MAX_SERIES_BUCKETS = 10_000;

function totals(row: AggregateRow | undefined): UsageTotals {
  const turns = Number(row?.turns ?? 0);
  const reported = Number(row?.reported_cost_turns ?? 0);
  const estimated = Number(row?.estimated_cost_turns ?? 0);
  const tokens = {
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
    reasoningTokens: Number(row?.reasoning_tokens ?? 0),
  };
  const costUsd = reported > 0 ? Number(row?.cost_usd ?? 0) : null;
  const estimatedCostUsd = estimated > 0 ? Number(row?.estimated_cost_usd ?? 0) : null;
  return {
    turns,
    ...tokens,
    totalTokens: totalTokens(tokens),
    costUsd,
    estimatedCostUsd,
    totalCostUsd:
      costUsd === null && estimatedCostUsd === null
        ? null
        : (costUsd ?? 0) + (estimatedCostUsd ?? 0),
    reportedCostTurns: reported,
    estimatedCostTurns: estimated,
    unpricedTurns: Math.max(0, turns - reported - estimated),
    unknownCostTurns: Math.max(0, turns - reported),
  };
}

function group(row: GroupRow): UsageGroup {
  return {
    key: row.key,
    label: row.label,
    ...(row.cell_label !== undefined
      ? { cellId: row.cell_id ?? '', cellLabel: row.cell_label ?? 'Unassigned' }
      : {}),
    ...totals(row),
  };
}

function bucket(row: BucketRow): UsageBucketRow {
  return { bucketStart: Number(row.bucket_start), ...totals(row) };
}

/**
 * Owns every usage query. The filters arrive already validated from the HTTP
 * boundary; this class trusts its arguments and never writes outside a record.
 *
 * Queries read from a normalized union of raw `usage_events` at or after the
 * rollup watermark and `usage_daily` rows before it, so pruning never removes
 * history from the dashboard.
 */
export class UsageRepository {
  constructor(private readonly db: Db) {}

  record(input: UsageEventInput): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (
           id, turn_id, session_id, scope, cell_id, request_id, model, effort,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, cost_usd, created_at
         ) VALUES (
           @id, @turnId, @sessionId, @scope, @cellId, @requestId, @model, @effort,
           @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
           @reasoningTokens, @costUsd, @createdAt
         )`,
      )
      .run({
        id: randomUUID(),
        turnId: input.turnId,
        sessionId: input.sessionId,
        scope: input.scope,
        cellId: input.cellId,
        requestId: input.requestId,
        model: input.model,
        effort: input.effort,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        reasoningTokens: input.reasoningTokens,
        costUsd: input.costUsd,
        createdAt: input.createdAt ?? Date.now(),
      });
  }

  /** Just the totals for a filter; budgets use this instead of re-querying. */
  totals(filter: UsageFilter): UsageTotals {
    const rawSince = this.rawSince();
    const { sql, params } = this.where(filter);
    const row = this.db
      .prepare(
        `SELECT ${USAGE_AGGREGATE} FROM ${usageSource(rawSince > 0)} x ${sql}`,
      )
      .get({ ...params, rawSince }) as AggregateRow | undefined;
    return totals(row);
  }

  query(filter: UsageFilter): UsageResponse {
    const bucketKey = filter.bucket ?? 'day';
    const limit = filter.limit ?? 20;
    const rawSince = this.rawSince();
    const includeDaily = rawSince > 0;
    const base = this.where(filter);
    const params = { ...base.params, rawSince };

    const totalsRow = this.db
      .prepare(
        `SELECT ${USAGE_AGGREGATE} FROM ${usageSource(includeDaily)} x ${base.sql}`,
      )
      .get(params) as AggregateRow | undefined;

    // Hourly buckets cannot split daily rows; totals above still include them.
    const seriesSource = usageSource(includeDaily && bucketKey === 'day');
    const bucketRows = this.db
      .prepare(
        `SELECT (x.period_start - (x.period_start % @bucketMs)) AS bucket_start,
                ${USAGE_AGGREGATE}
           FROM ${seriesSource} x ${base.sql}
          GROUP BY bucket_start
          ORDER BY bucket_start`,
      )
      .all({ ...params, bucketMs: USAGE_BUCKET_MS[bucketKey] }) as BucketRow[];

    const modelRows = this.db
      .prepare(
        `SELECT x.model AS key,
                CASE WHEN x.model = '' THEN 'Unknown model' ELSE x.model END AS label,
                ${USAGE_AGGREGATE}
           FROM ${usageSource(includeDaily)} x ${base.sql}
          GROUP BY key
          ORDER BY ${GROUP_ORDER_BY}
          LIMIT @limit`,
      )
      .all({ ...params, limit }) as GroupRow[];

    const cellRows = this.db
      .prepare(
        `SELECT x.cell_id AS key,
                CASE WHEN x.cell_id = '' THEN 'Unassigned'
                     ELSE COALESCE(c.name, x.cell_id) END AS label,
                ${USAGE_AGGREGATE}
           FROM ${usageSource(includeDaily)} x
           LEFT JOIN cells c ON c.id = x.cell_id
           ${base.sql}
          GROUP BY key
          ORDER BY ${GROUP_ORDER_BY}
          LIMIT @limit`,
      )
      .all({ ...params, limit }) as GroupRow[];

    const requestWhere = this.where(filter, "x.request_id <> ''");
    const requestRows = this.db
      .prepare(
        `SELECT x.request_id AS key,
                COALESCE(NULLIF(r.title, ''), x.request_id) AS label,
                COALESCE(r.cell_id, '') AS cell_id,
                CASE WHEN r.cell_id IS NULL THEN 'Unassigned'
                     ELSE COALESCE(c.name, r.cell_id) END AS cell_label,
                ${USAGE_AGGREGATE}
           FROM ${usageSource(includeDaily)} x
           LEFT JOIN requests r ON r.id = x.request_id
           LEFT JOIN cells c ON c.id = r.cell_id
           ${requestWhere.sql}
          GROUP BY key
          ORDER BY ${GROUP_ORDER_BY}
          LIMIT @limit`,
      )
      .all({ ...requestWhere.params, rawSince, limit }) as GroupRow[];

    return {
      range: { from: filter.from ?? null, to: filter.to ?? null },
      totals: totals(totalsRow),
      series: this.fillSeries(bucketRows.map(bucket), filter, bucketKey),
      byModel: modelRows.map(group),
      byCell: cellRows.map(group),
      byRequest: requestRows.map(group),
      coverage: { rolledThrough: includeDaily ? rawSince : null },
    };
  }

  /** Exclusive boundary between daily rollups and raw rows; 0 means none. */
  private rawSince(): number {
    const row = this.db
      .prepare('SELECT rolled_through AS value FROM usage_rollup_state WHERE id = 1')
      .get() as { value: number } | undefined;
    return Number(row?.value ?? 0);
  }

  private where(filter: UsageFilter, extra?: string): { sql: string; params: Record<string, unknown> } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.cellId !== undefined) {
      clauses.push('x.cell_id = @cellId');
      params['cellId'] = filter.cellId;
    }
    if (filter.requestId !== undefined) {
      clauses.push('x.request_id = @requestId');
      params['requestId'] = filter.requestId;
    }
    if (filter.from !== undefined) {
      clauses.push('x.period_end > @from');
      params['from'] = filter.from;
    }
    if (filter.to !== undefined) {
      clauses.push('x.period_start < @to');
      params['to'] = filter.to;
    }
    if (extra) clauses.push(extra);
    return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private fillSeries(
    rows: UsageBucketRow[],
    filter: UsageFilter,
    bucketKey: 'hour' | 'day',
  ): UsageBucketRow[] {
    if (filter.from === undefined || filter.to === undefined) return rows;
    if (filter.to <= filter.from) return rows;

    const bucketMs = USAGE_BUCKET_MS[bucketKey];
    const first = usageBucketStart(filter.from, bucketKey);
    const last = usageBucketStart(filter.to - 1, bucketKey);
    const count = Math.floor((last - first) / bucketMs) + 1;
    if (count <= 0 || count > MAX_SERIES_BUCKETS) return rows;

    const byStart = new Map(rows.map((row) => [row.bucketStart, row]));
    const filled: UsageBucketRow[] = [];
    for (let start = first; start <= last; start += bucketMs) {
      filled.push(
        byStart.get(start) ?? {
          bucketStart: start,
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          costUsd: null,
          estimatedCostUsd: null,
          totalCostUsd: null,
          reportedCostTurns: 0,
          estimatedCostTurns: 0,
          unpricedTurns: 0,
          unknownCostTurns: 0,
        },
      );
    }
    return filled;
  }
}
