import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Summary, SummaryStats } from './types.js';

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
  offset?: number | undefined;
}

interface SummaryCountRow {
  total: number;
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
    const offset = Math.max(options.offset ?? 0, 0);
    const rows =
      options.cellId === undefined
        ? (this.db
            .prepare(
              'SELECT * FROM cell_summaries ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
            )
            .all(limit, offset) as SummaryRow[])
        : (this.db
            .prepare(
              'SELECT * FROM cell_summaries WHERE cell_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
            )
            .all(options.cellId, limit, offset) as SummaryRow[]);
    return rows.map(toSummary);
  }

  count(options: Pick<SummaryListOptions, 'cellId'> = {}): number {
    const row =
      options.cellId === undefined
        ? (this.db.prepare('SELECT COUNT(*) AS total FROM cell_summaries').get() as
            | SummaryCountRow
            | undefined)
        : (this.db
            .prepare('SELECT COUNT(*) AS total FROM cell_summaries WHERE cell_id = ?')
            .get(options.cellId) as SummaryCountRow | undefined);
    return row?.total ?? 0;
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
