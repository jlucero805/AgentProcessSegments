import type { Db } from '../db.js';
import type { UsagePruneSummary } from './types.js';

const READ_SQL = `
  SELECT last_run_at AS ranAt, last_deleted_rows AS deletedRows
  FROM usage_prune_state
  WHERE id = 1
`;

const RECORD_SQL = `
  INSERT INTO usage_prune_state (id, last_run_at, last_deleted_rows)
  VALUES (1, @ranAt, @deletedRows)
  ON CONFLICT(id) DO UPDATE SET
    last_run_at = excluded.last_run_at,
    last_deleted_rows = excluded.last_deleted_rows
`;

/** Most recent completed retention pass, or null before the first one. */
export function readUsagePruneState(db: Db): UsagePruneSummary | null {
  const row = db.prepare(READ_SQL).get() as
    | { ranAt: number; deletedRows: number }
    | undefined;
  if (!row) return null;
  return { ranAt: Number(row.ranAt), deletedRows: Number(row.deletedRows) };
}

/** Overwrites the singleton summary with the pass that just completed. */
export function recordUsagePruneState(db: Db, summary: UsagePruneSummary): void {
  db.prepare(RECORD_SQL).run({
    ranAt: summary.ranAt,
    deletedRows: summary.deletedRows,
  });
}
