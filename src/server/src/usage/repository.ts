import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { readUsagePruneState } from './prune-state.js';
import {
  SEGMENT_IDS,
  SEGMENT_LABELS,
  type SegmentId,
} from '../process/definition.js';
import {
  GROUP_ORDER_BY,
  USAGE_AGGREGATE,
  usageSource,
} from './sql.js';
import {
  RequestSegmentRepository,
  type SegmentDuration,
} from './segments.js';
import {
  USAGE_BUCKET_MS,
  totalTokens,
  usageBucketStart,
  type UsageBucketRow,
  type UsageCellSegmentGroup,
  type UsageCoverage,
  type UsageEventInput,
  type UsageFilter,
  type UsageGroup,
  type UsagePruneSummary,
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

interface CellSegmentRow extends AggregateRow {
  cell_id: string;
  cell_label: string;
  segment: string;
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

function toSegment(value: string): SegmentId | null {
  return (SEGMENT_IDS as readonly string[]).includes(value)
    ? (value as SegmentId)
    : null;
}

function segmentOrder(segment: SegmentId | null): number {
  return segment === null ? SEGMENT_IDS.length : SEGMENT_IDS.indexOf(segment);
}

/**
 * Usage rows and cycle-time rows are independent ledgers: a segment can hold a
 * request with no turns, and master/kb/setup spend has no segment. Merge both
 * so the table never hides a row just because one side is empty.
 */
function mergeCellSegments(
  rows: CellSegmentRow[],
  durations: SegmentDuration[],
): UsageCellSegmentGroup[] {
  const byKey = new Map<string, UsageCellSegmentGroup>();
  const labelByCell = new Map<string, string>();

  for (const row of rows) {
    const cellId = row.cell_id ?? '';
    const cellLabel = row.cell_label ?? 'Unassigned';
    labelByCell.set(cellId, cellLabel);
    const segment = toSegment(row.segment);
    byKey.set(`${cellId}\u0000${row.segment}`, {
      key: `${cellId}:${row.segment}`,
      label: segment === null ? 'Unattributed' : SEGMENT_LABELS[segment],
      cellId,
      cellLabel,
      segment,
      wallMs: 0,
      activeMs: 0,
      ...totals(row),
    });
  }

  for (const duration of durations) {
    const key = `${duration.cellId}\u0000${duration.segment}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.wallMs = duration.wallMs;
      existing.activeMs = duration.activeMs;
      continue;
    }
    const cellLabel =
      labelByCell.get(duration.cellId) ?? (duration.cellId || 'Unassigned');
    byKey.set(key, {
      key: `${duration.cellId}:${duration.segment}`,
      label: SEGMENT_LABELS[duration.segment],
      cellId: duration.cellId,
      cellLabel,
      segment: duration.segment,
      wallMs: duration.wallMs,
      activeMs: duration.activeMs,
      ...totals(undefined),
    });
  }

  return [...byKey.values()].sort((a, b) => {
    if ((a.totalCostUsd === null) !== (b.totalCostUsd === null)) {
      return a.totalCostUsd === null ? 1 : -1;
    }
    const cost = (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0);
    if (cost !== 0) return cost;
    if (a.totalTokens !== b.totalTokens) return b.totalTokens - a.totalTokens;
    const cell = a.cellLabel.localeCompare(b.cellLabel);
    if (cell !== 0) return cell;
    return segmentOrder(a.segment) - segmentOrder(b.segment);
  });
}

/**
 * Query output before the HTTP boundary attaches coverage that comes from
 * outside a single query: the settings-derived retention window and the
 * persisted last-retention-pass summary. Lets the repository stay free of the
 * settings store while `UsageResponse` exposes the full contract to the SPA.
 */
export type UsageQueryResult = Omit<UsageResponse, 'coverage'> & {
  coverage: Pick<UsageCoverage, 'rolledThrough'>;
};

/**
 * Owns every usage query. The filters arrive already validated from the HTTP
 * boundary; this class trusts its arguments and never writes outside a record.
 *
 * Queries read from a normalized union of raw `usage_events` at or after the
 * rollup watermark and `usage_daily` rows before it, so pruning never removes
 * history from the dashboard.
 */
export class UsageRepository {
  /** Cycle-time ledger, exposed so the engine can record active turns. */
  readonly segments: RequestSegmentRepository;

  constructor(private readonly db: Db) {
    this.segments = new RequestSegmentRepository(db);
  }

  record(input: UsageEventInput): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (
           id, turn_id, session_id, scope, cell_id, request_id, model, effort,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, cost_usd, segment, created_at
         ) VALUES (
           @id, @turnId, @sessionId, @scope, @cellId, @requestId, @model, @effort,
           @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
           @reasoningTokens, @costUsd, @segment, @createdAt
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
        segment: input.segment ?? null,
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

  query(filter: UsageFilter): UsageQueryResult {
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

    const cellSegmentRows = this.db
      .prepare(
        `SELECT x.cell_id AS cell_id,
                CASE WHEN x.cell_id = '' THEN 'Unassigned'
                     ELSE COALESCE(c.name, x.cell_id) END AS cell_label,
                x.segment AS segment,
                x.cell_id || ':' || x.segment AS key,
                ${USAGE_AGGREGATE}
           FROM ${usageSource(includeDaily)} x
           LEFT JOIN cells c ON c.id = x.cell_id
           ${base.sql}
          GROUP BY x.cell_id, x.segment
          ORDER BY ${GROUP_ORDER_BY}`,
      )
      .all(params) as CellSegmentRow[];

    return {
      range: { from: filter.from ?? null, to: filter.to ?? null },
      totals: totals(totalsRow),
      series: this.fillSeries(bucketRows.map(bucket), filter, bucketKey),
      byModel: modelRows.map(group),
      byCell: cellRows.map(group),
      byRequest: requestRows.map(group),
      byCellSegment: mergeCellSegments(
        cellSegmentRows,
        this.segments.durations(filter),
      ),
      coverage: { rolledThrough: includeDaily ? rawSince : null },
    };
  }

  /** Most recent completed retention pass, or null before the first one. */
  lastPrune(): UsagePruneSummary | null {
    return readUsagePruneState(this.db);
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
