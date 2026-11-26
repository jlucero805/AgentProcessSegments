import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { SegmentId } from '../process/definition.js';

export interface SegmentTimeFilter {
  cellId?: string | undefined;
  requestId?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
}

export interface SegmentDuration {
  cellId: string;
  segment: SegmentId;
  /** Wall-clock time spent in the segment, including waiting. */
  wallMs: number;
  /** Time covered by agent turns running in the segment. */
  activeMs: number;
}

export interface SegmentTurnInput {
  turnId: string;
  requestId: string;
  cellId: string | null;
  segment: SegmentId;
  startedAt: number;
  endedAt: number;
}

interface VisitRow {
  id: string;
  cell_id: string | null;
  segment: SegmentId;
  entered_at: number;
}

interface DurationRow {
  cell_id: string;
  segment: SegmentId;
  wall_ms: number;
}

interface ActiveRow {
  cell_id: string;
  segment: SegmentId;
  active_ms: number;
}

/**
 * Durable cycle-time ledger for process segments. A visit is one continuous
 * stay in a segment; revisits produce a second row, so queries sum every pass.
 * Turns are separate because an intake turn runs after the request has already
 * moved into Plan: cost and active time belong to the segment that ran it.
 */
export class RequestSegmentRepository {
  constructor(private readonly db: Db) {}

  private openVisit(requestId: string): VisitRow | null {
    const row = this.db
      .prepare(
        `SELECT id, cell_id, segment, entered_at
           FROM request_segment_visits
          WHERE request_id = ? AND exited_at IS NULL
          ORDER BY entered_at DESC
          LIMIT 1`,
      )
      .get(requestId) as
      | { id: string; cell_id: string | null; segment: SegmentId; entered_at: number }
      | undefined;
    return row ?? null;
  }

  /** Close the open visit and start another, or no-op when already there. */
  enter(
    requestId: string,
    cellId: string | null,
    segment: SegmentId,
    at = Date.now(),
  ): void {
    const open = this.openVisit(requestId);
    if (open?.segment === segment && (open.cell_id ?? null) === (cellId ?? null)) {
      return;
    }
    this.db.transaction(() => {
      this.closeVisit(open, at);
      this.insertVisit(requestId, cellId, segment, at);
    })();
  }

  /** A cell move splits the same segment between the old and new cell. */
  moveCell(requestId: string, cellId: string | null, at = Date.now()): void {
    const open = this.openVisit(requestId);
    if (!open || (open.cell_id ?? null) === (cellId ?? null)) return;
    this.db.transaction(() => {
      this.closeVisit(open, at);
      this.insertVisit(requestId, cellId, open.segment, at);
    })();
  }

  /** Close the open visit without starting another (terminal states). */
  close(requestId: string, at = Date.now()): void {
    const open = this.openVisit(requestId);
    if (!open) return;
    this.closeVisit(open, at);
  }

  recordTurn(input: SegmentTurnInput): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO request_segment_turns
           (turn_id, request_id, cell_id, segment, started_at, ended_at)
         VALUES (@turnId, @requestId, @cellId, @segment, @startedAt, @endedAt)`,
      )
      .run({
        turnId: input.turnId,
        requestId: input.requestId,
        cellId: input.cellId,
        segment: input.segment,
        startedAt: input.startedAt,
        endedAt: Math.max(input.startedAt, input.endedAt),
      });
  }

  /**
   * Wall and active time per cell and segment, clipped to the filter window so
   * a range never reports time outside it.
   */
  durations(filter: SegmentTimeFilter = {}): SegmentDuration[] {
    const from = filter.from ?? 0;
    const to = filter.to ?? Date.now();
    if (to <= from) return [];

    const wallClauses = ['entered_at < @to', '(exited_at IS NULL OR exited_at > @from)'];
    const activeClauses = ['started_at < @to', 'ended_at > @from'];
    const params: Record<string, unknown> = { from, to, now: Date.now() };
    if (filter.cellId !== undefined) {
      wallClauses.push('cell_id = @cellId');
      activeClauses.push('cell_id = @cellId');
      params['cellId'] = filter.cellId;
    }
    if (filter.requestId !== undefined) {
      wallClauses.push('request_id = @requestId');
      activeClauses.push('request_id = @requestId');
      params['requestId'] = filter.requestId;
    }

    const wall = this.db
      .prepare(
        `SELECT COALESCE(cell_id, '') AS cell_id,
                segment,
                SUM(MAX(0, MIN(COALESCE(exited_at, @now), @to) - MAX(entered_at, @from)))
                  AS wall_ms
           FROM request_segment_visits
          WHERE ${wallClauses.join(' AND ')}
          GROUP BY cell_id, segment`,
      )
      .all(params) as DurationRow[];

    const active = this.db
      .prepare(
        `SELECT COALESCE(cell_id, '') AS cell_id,
                segment,
                SUM(MAX(0, MIN(ended_at, @to) - MAX(started_at, @from))) AS active_ms
           FROM request_segment_turns
          WHERE ${activeClauses.join(' AND ')}
          GROUP BY cell_id, segment`,
      )
      .all(params) as ActiveRow[];

    const byKey = new Map<string, SegmentDuration>();
    for (const row of wall) {
      byKey.set(`${row.cell_id}\u0000${row.segment}`, {
        cellId: row.cell_id,
        segment: row.segment,
        wallMs: Number(row.wall_ms ?? 0),
        activeMs: 0,
      });
    }
    for (const row of active) {
      const key = `${row.cell_id}\u0000${row.segment}`;
      const existing = byKey.get(key);
      if (existing) existing.activeMs = Number(row.active_ms ?? 0);
      else {
        byKey.set(key, {
          cellId: row.cell_id,
          segment: row.segment,
          wallMs: 0,
          activeMs: Number(row.active_ms ?? 0),
        });
      }
    }
    return [...byKey.values()];
  }

  private closeVisit(open: VisitRow | null, at: number): void {
    if (!open) return;
    this.db
      .prepare('UPDATE request_segment_visits SET exited_at = ? WHERE id = ?')
      .run(Math.max(open.entered_at, at), open.id);
  }

  private insertVisit(
    requestId: string,
    cellId: string | null,
    segment: SegmentId,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO request_segment_visits
           (id, request_id, cell_id, segment, entered_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), requestId, cellId, segment, at);
  }
}
