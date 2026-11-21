import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';

export type MasterAction = 'cycle' | 'prod' | 'review' | 'skip';

export interface MasterEvent {
  id: string;
  cellId: string | null;
  requestId: string | null;
  action: MasterAction;
  detail: string;
  createdAt: number;
}

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

  lastProdAt(requestId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT MAX(created_at) AS at FROM master_events WHERE request_id = ? AND action = 'prod'",
      )
      .get(requestId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }
}
