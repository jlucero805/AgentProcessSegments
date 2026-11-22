import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
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
  known_cost_turns: number;
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

const AGGREGATE_SELECT = `
  COUNT(*) AS turns,
  COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
  SUM(u.cost_usd) AS cost_usd,
  COUNT(u.cost_usd) AS known_cost_turns
`;

/** Keep an accidental all-time hourly query from building a huge array. */
const MAX_SERIES_BUCKETS = 10_000;

function totals(row: AggregateRow | undefined): UsageTotals {
  const turns = Number(row?.turns ?? 0);
  const known = Number(row?.known_cost_turns ?? 0);
  const tokens = {
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
    reasoningTokens: Number(row?.reasoning_tokens ?? 0),
  };
  return {
    turns,
    ...tokens,
    totalTokens: totalTokens(tokens),
    costUsd: known > 0 ? Number(row?.cost_usd ?? 0) : null,
    unknownCostTurns: Math.max(0, turns - known),
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

  query(filter: UsageFilter): UsageResponse {
    const bucketKey = filter.bucket ?? 'day';
    const limit = filter.limit ?? 20;
    const base = this.where(filter);
    const params = { ...base.params };

    const totalsRow = this.db
      .prepare(`SELECT ${AGGREGATE_SELECT} FROM usage_events u ${base.sql}`)
      .get(params) as AggregateRow | undefined;

    const bucketRows = this.db
      .prepare(
        `SELECT (u.created_at - (u.created_at % @bucketMs)) AS bucket_start, ${AGGREGATE_SELECT}
           FROM usage_events u ${base.sql}
          GROUP BY bucket_start
          ORDER BY bucket_start`,
      )
      .all({ ...params, bucketMs: USAGE_BUCKET_MS[bucketKey] }) as BucketRow[];

    const modelRows = this.db
      .prepare(
        `SELECT COALESCE(u.model, '') AS key,
                COALESCE(NULLIF(u.model, ''), 'Unknown model') AS label,
                ${AGGREGATE_SELECT}
           FROM usage_events u ${base.sql}
          GROUP BY key
          ORDER BY cost_usd IS NULL, cost_usd DESC, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens DESC, key
          LIMIT @limit`,
      )
      .all({ ...params, limit }) as GroupRow[];

    const cellRows = this.db
      .prepare(
        `SELECT COALESCE(u.cell_id, '') AS key,
                COALESCE(c.name, u.cell_id, 'Unassigned') AS label,
                ${AGGREGATE_SELECT}
           FROM usage_events u
           LEFT JOIN cells c ON c.id = u.cell_id
           ${base.sql}
          GROUP BY key
          ORDER BY cost_usd IS NULL, cost_usd DESC, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens DESC, key
          LIMIT @limit`,
      )
      .all({ ...params, limit }) as GroupRow[];

    const requestWhere = this.where(filter, 'u.request_id IS NOT NULL');
    const requestRows = this.db
      .prepare(
        `SELECT u.request_id AS key,
                COALESCE(NULLIF(r.title, ''), u.request_id) AS label,
                COALESCE(r.cell_id, '') AS cell_id,
                COALESCE(c.name, r.cell_id, 'Unassigned') AS cell_label,
                ${AGGREGATE_SELECT}
           FROM usage_events u
           LEFT JOIN requests r ON r.id = u.request_id
           LEFT JOIN cells c ON c.id = r.cell_id
           ${requestWhere.sql}
          GROUP BY key
          ORDER BY cost_usd IS NULL, cost_usd DESC, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens DESC, key
          LIMIT @limit`,
      )
      .all({ ...requestWhere.params, limit }) as GroupRow[];

    return {
      range: { from: filter.from ?? null, to: filter.to ?? null },
      totals: totals(totalsRow),
      series: this.fillSeries(bucketRows.map(bucket), filter, bucketKey),
      byModel: modelRows.map(group),
      byCell: cellRows.map(group),
      byRequest: requestRows.map(group),
    };
  }

  private where(filter: UsageFilter, extra?: string): { sql: string; params: Record<string, unknown> } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.cellId !== undefined) {
      clauses.push('u.cell_id = @cellId');
      params['cellId'] = filter.cellId;
    }
    if (filter.requestId !== undefined) {
      clauses.push('u.request_id = @requestId');
      params['requestId'] = filter.requestId;
    }
    if (filter.from !== undefined) {
      clauses.push('u.created_at >= @from');
      params['from'] = filter.from;
    }
    if (filter.to !== undefined) {
      clauses.push('u.created_at < @to');
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
          unknownCostTurns: 0,
        },
      );
    }
    return filled;
  }
}
