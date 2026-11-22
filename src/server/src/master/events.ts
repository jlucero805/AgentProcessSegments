import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { MasterAction, MasterEvent } from './types.js';

interface MasterEventRow {
  id: string;
  cell_id: string | null;
  request_id: string | null;
  action: MasterAction;
  detail: string;
  created_at: number;
}

export interface MasterEventInput {
  cellId: string | null;
  requestId: string | null;
  action: MasterAction;
  detail: string;
}

export interface ActivityWindow {
  counts: Record<MasterAction, number>;
  followUpTitles: string[];
  skipReasons: string[];
}

const MASTER_ACTIONS: readonly MasterAction[] = [
  'cycle',
  'start',
  'prod',
  'review',
  'advance',
  'followup',
  'skip',
];

function toEvent(row: MasterEventRow): MasterEvent {
  return {
    id: row.id,
    cellId: row.cell_id,
    requestId: row.request_id,
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export class MasterEventRepository {
  constructor(private readonly db: Db) {}

  record(input: MasterEventInput): MasterEvent {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO master_events (id, cell_id, request_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.cellId, input.requestId, input.action, input.detail, now);
    return { id, ...input, createdAt: now };
  }

  list(options: { cellId?: string | undefined; limit?: number } = {}): MasterEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows =
      options.cellId === undefined
        ? (this.db
            .prepare('SELECT * FROM master_events ORDER BY created_at DESC LIMIT ?')
            .all(limit) as MasterEventRow[])
        : (this.db
            .prepare(
              'SELECT * FROM master_events WHERE cell_id = ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(options.cellId, limit) as MasterEventRow[]);
    return rows.map(toEvent);
  }

  /** Counts and capped details for one cell inside `[since, until)`. */
  activityWindow(cellId: string, since: number, until: number): ActivityWindow {
    const counts = Object.fromEntries(MASTER_ACTIONS.map((action) => [action, 0])) as Record<
      MasterAction,
      number
    >;
    const rows = this.db
      .prepare(
        `SELECT action, COUNT(*) AS count
           FROM master_events
          WHERE cell_id = ? AND created_at >= ? AND created_at < ?
          GROUP BY action`,
      )
      .all(cellId, since, until) as Array<{ action: MasterAction; count: number }>;
    for (const row of rows) counts[row.action] = row.count;

    const detail = (action: MasterAction, limit: number): string[] =>
      (
        this.db
          .prepare(
            `SELECT detail FROM master_events
              WHERE cell_id = ? AND action = ? AND created_at >= ? AND created_at < ?
              ORDER BY created_at DESC LIMIT ?`,
          )
          .all(cellId, action, since, until, limit) as Array<{ detail: string }>
      ).map((row) => row.detail);

    return {
      counts,
      followUpTitles: detail('followup', 20),
      skipReasons: detail('skip', 10),
    };
  }

  lastTurnAt(requestId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT MAX(created_at) AS at FROM master_events WHERE request_id = ? AND action IN ('start', 'prod')",
      )
      .get(requestId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  hasEvent(requestId: string, action: MasterAction, detail: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS found FROM master_events WHERE request_id = ? AND action = ? AND detail = ? LIMIT 1',
      )
      .get(requestId, action, detail) as { found: number } | undefined;
    return row !== undefined;
  }
}
