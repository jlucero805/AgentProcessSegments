import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Summary, SummaryFeedPage, SummaryStats } from './types.js';

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
  /** Exclusive upper bound on the `(created_at, id)` keyset cursor. */
  before?: number | undefined;
  /** Tie-breaker for `before`; both cursor fields must be supplied together. */
  beforeId?: string | undefined;
}

/** The flat cross-cell feed has no cell filter. */
export type SummaryFeedOptions = Omit<SummaryListOptions, 'cellId'>;

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

  /**
   * Run the shared list query with an explicit limit. The limit is not clamped
   * here so `feed()` can fetch one probe row even at the public 50-row cap.
   */
  private query(options: SummaryListOptions, limit: number): SummaryRow[] {
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
    if (options.before !== undefined && options.beforeId !== undefined) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(options.before, options.before, options.beforeId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT * FROM cell_summaries${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as SummaryRow[];
  }

  list(options: SummaryListOptions = {}): Summary[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    return this.query(options, limit).map(toSummary);
  }

  /**
   * One page of the flat cross-cell feed, newest first, with the cursor for the
   * next page. Fetches one probe row to compute `hasMore` without returning it.
   */
  feed(options: SummaryFeedOptions = {}): SummaryFeedPage {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);
    const rows = this.query(options, limit + 1);
    const reports = rows.slice(0, limit).map(toSummary);
    const last = reports[reports.length - 1];
    const hasMore = rows.length > limit;
    return {
      reports,
      hasMore,
      nextCursor: hasMore && last ? { before: last.createdAt, beforeId: last.id } : null,
    };
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
