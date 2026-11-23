import type { Db } from '../db.js';
import { ESTIMATE_SQL, PRICE_JOIN } from './sql.js';
import { USAGE_BUCKET_MS, usageBucketStart } from './types.js';

const DAY_MS = USAGE_BUCKET_MS.day;
const DEFAULT_CHUNK_DAYS = 31;

const DELETE_DAILY = `
  DELETE FROM usage_daily
   WHERE day_start >= @from AND day_start < @to
`;

/**
 * One row per UTC day and grouping dimension. Estimates are computed here with
 * the same price lookup raw queries use, then frozen once the raw rows are
 * pruned.
 */
const INSERT_DAILY = `
  INSERT INTO usage_daily (
    day_start, scope, cell_id, request_id, model, turns,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, reported_cost_usd, reported_cost_turns,
    estimated_cost_usd, estimated_cost_turns
  )
  SELECT
    (u.created_at - (u.created_at % @dayMs)) AS day_start,
    u.scope,
    COALESCE(u.cell_id, ''),
    COALESCE(u.request_id, ''),
    COALESCE(u.model, ''),
    COUNT(*),
    COALESCE(SUM(u.input_tokens), 0),
    COALESCE(SUM(u.output_tokens), 0),
    COALESCE(SUM(u.cache_read_tokens), 0),
    COALESCE(SUM(u.cache_write_tokens), 0),
    COALESCE(SUM(u.reasoning_tokens), 0),
    SUM(u.cost_usd),
    COUNT(u.cost_usd),
    SUM(${ESTIMATE_SQL}),
    COUNT(${ESTIMATE_SQL})
  FROM usage_events u
  ${PRICE_JOIN}
  WHERE u.created_at >= @from AND u.created_at < @to
  GROUP BY day_start, u.scope, COALESCE(u.cell_id, ''),
           COALESCE(u.request_id, ''), COALESCE(u.model, '')
`;

const UPSERT_STATE = `
  INSERT INTO usage_rollup_state (id, rolled_through)
  VALUES (1, @to)
  ON CONFLICT(id) DO UPDATE SET rolled_through = excluded.rolled_through
`;

export interface UsageRollupChunk {
  from: number;
  to: number;
  rows: number;
  done: boolean;
}

export interface UsageRollupOptions {
  /** Upper bound on days covered by one transaction. */
  maxDays?: number;
}

/**
 * Builds durable UTC-day aggregates from `usage_events` before retention
 * deletes the raw rows. Each call covers a bounded chunk so a large backlog
 * cannot monopolize the synchronous SQLite handle.
 */
export class UsageRollups {
  constructor(private readonly db: Db) {}

  /** Exclusive boundary: raw rows at or after this are not in `usage_daily`. */
  watermark(): number {
    const row = this.db
      .prepare('SELECT rolled_through AS value FROM usage_rollup_state WHERE id = 1')
      .get() as { value: number } | undefined;
    return Number(row?.value ?? 0);
  }

  /** Earliest raw UTC day at or before `before`, or null when none exists. */
  earliestRawDay(before: number): number | null {
    const row = this.db
      .prepare('SELECT MIN(created_at) AS value FROM usage_events WHERE created_at < @before')
      .get({ before }) as { value: number | null } | undefined;
    if (row?.value === null || row?.value === undefined) return null;
    return usageBucketStart(Number(row.value), 'day');
  }

  /**
   * Roll up at most `maxDays` UTC days starting at the watermark. The first run
   * starts at the earliest raw day instead of epoch 0 so an old database does
   * not produce thousands of empty chunks.
   */
  rollupThrough(through: number, options: UsageRollupOptions = {}): UsageRollupChunk {
    if (!Number.isInteger(through) || through % DAY_MS !== 0) {
      throw new Error('usage rollup boundary must be UTC-day aligned');
    }

    const current = this.watermark();
    if (through <= current) {
      return { from: current, to: current, rows: 0, done: true };
    }
    if (!this.hasUsageEvents()) {
      return { from: current, to: current, rows: 0, done: true };
    }

    const start = current > 0 ? current : this.earliestRawDay(through);
    if (start === null) {
      return { from: current, to: current, rows: 0, done: true };
    }

    const maxDays =
      options.maxDays !== undefined && options.maxDays > 0
        ? Math.max(1, Math.floor(options.maxDays))
        : DEFAULT_CHUNK_DAYS;
    const from = Math.max(current, start);
    const to = Math.min(from + maxDays * DAY_MS, through);
    if (to <= from) {
      return { from, to, rows: 0, done: true };
    }

    const rows = this.db.transaction(() => {
      this.db.prepare(DELETE_DAILY).run({ from, to });
      const inserted = this.db.prepare(INSERT_DAILY).run({ from, to, dayMs: DAY_MS });
      this.db.prepare(UPSERT_STATE).run({ to });
      return Number(inserted.changes);
    })();

    return { from, to, rows, done: to >= through };
  }

  private hasUsageEvents(): boolean {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'")
      .get();
    return Boolean(table);
  }
}
