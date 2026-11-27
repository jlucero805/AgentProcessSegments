import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Summary, SummaryGroup, SummaryGroupOptions, SummaryStats } from './types.js';

interface SummaryRow {
  id: string;
  cell_id: string;
  window_start: number;
  window_end: number;
  window_minutes: number;
  content: string;
  stats_json: string;
  created_at: number;
}

export interface SummaryInput {
  cellId: string;
  windowStart: number;
  windowEnd: number;
  windowMinutes: number;
  content: string;
  stats: SummaryStats;
}

export interface SummaryListOptions {
  cellId?: string | undefined;
  limit?: number | undefined;
  /** Inclusive lower bound on `created_at` (epoch ms). */
  since?: number | undefined;
  /** Inclusive upper bound on `created_at` (epoch ms). */
  until?: number | undefined;
  /** Exclusive upper bound on the `(created_at, id)` keyset cursor. */
  before?: number | undefined;
  /** Tie-breaker for `before`; both cursor fields must be supplied together. */
  beforeId?: string | undefined;
}

function toSummary(row: SummaryRow): Summary {
  return {
    id: row.id,
    cellId: row.cell_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    windowMinutes: row.window_minutes,
    content: row.content,
    stats: JSON.parse(row.stats_json) as SummaryStats,
    createdAt: row.created_at,
  };
}

export class SummaryRepository {
  constructor(private readonly db: Db) {}

  record(input: SummaryInput): Summary {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO cell_summaries
           (id, cell_id, window_start, window_end, window_minutes, content, stats_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.cellId,
        input.windowStart,
        input.windowEnd,
        input.windowMinutes,
        input.content,
        JSON.stringify(input.stats),
        createdAt,
      );
    return { id, ...input, createdAt };
  }

  list(options: SummaryListOptions = {}): Summary[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.cellId !== undefined) {
      clauses.push('cell_id = ?');
      params.push(options.cellId);
    }
    if (options.since !== undefined) {
      clauses.push('created_at >= ?');
      params.push(options.since);
    }
    if (options.until !== undefined) {
      clauses.push('created_at <= ?');
      params.push(options.until);
    }
    if (options.before !== undefined && options.beforeId !== undefined) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(options.before, options.before, options.beforeId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM cell_summaries${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as SummaryRow[];
    return rows.map(toSummary);
  }

  /**
   * The newest reports per cell, for the Scorecards page's all-cells view.
   * One probe row beyond `limit` tells each group whether older reports exist;
   * the probe is trimmed before returning. Groups follow their newest report.
   */
  grouped(options: SummaryGroupOptions = {}): SummaryGroup[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.since !== undefined) {
      clauses.push('created_at >= ?');
      params.push(options.since);
    }
    if (options.until !== undefined) {
      clauses.push('created_at <= ?');
      params.push(options.until);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY cell_id ORDER BY created_at DESC, id DESC
           ) AS row_number
           FROM cell_summaries${where}
         )
         WHERE row_number <= ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...params, limit + 1) as Array<SummaryRow & { row_number: number }>;

    const byCell = new Map<string, Summary[]>();
    for (const row of rows) {
      const summary = toSummary(row);
      const reports = byCell.get(row.cell_id);
      if (reports) reports.push(summary);
      else byCell.set(row.cell_id, [summary]);
    }
    return Array.from(byCell, ([cellId, reports]) => ({
      cellId,
      reports: reports.slice(0, limit),
      hasMore: reports.length > limit,
    }));
  }

  latest(cellId: string): Summary | null {
    const row = this.db
      .prepare(
        'SELECT * FROM cell_summaries WHERE cell_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(cellId) as SummaryRow | undefined;
    return row ? toSummary(row) : null;
  }
}
