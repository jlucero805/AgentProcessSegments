import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type {
  DeliveryChannel,
  DeliveryFormat,
  DeliveryStatus,
} from '../domain/budget.js';
import type { NotificationEventKind } from '../domain/notifications.js';

export interface EventDeliveryRecord {
  id: string;
  dedupeKey: string;
  kind: NotificationEventKind;
  cellId: string | null;
  channel: DeliveryChannel;
  format: DeliveryFormat;
  destinationHash: string;
  payloadJson: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

export interface EventDeliveryInput {
  dedupeKey: string;
  kind: NotificationEventKind;
  cellId: string | null;
  channel: DeliveryChannel;
  format: DeliveryFormat;
  destinationHash: string;
  payloadJson: string;
  now: number;
}

export interface EventDeliveryStatusSummary {
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

export interface EventHistoryFilter {
  kind?: NotificationEventKind;
  channel?: DeliveryChannel;
  status?: DeliveryStatus;
  /** Inclusive created-at lower bound in epoch milliseconds. */
  from?: number;
  /** Exclusive created-at upper bound in epoch milliseconds. */
  to?: number;
  limit: number;
  offset: number;
}

/** Fixed SQL fragments; every value stays a bound parameter. */
function historyWhere(filter: EventHistoryFilter): {
  sql: string;
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.channel !== undefined) {
    clauses.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('created_at < ?');
    params.push(filter.to);
  }
  return {
    sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

interface EventDeliveryRow {
  id: string;
  dedupe_key: string;
  kind: NotificationEventKind;
  cell_id: string | null;
  channel: string;
  format: DeliveryFormat;
  destination_hash: string;
  payload_json: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

function toRecord(row: EventDeliveryRow): EventDeliveryRecord {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    cellId: row.cell_id,
    channel: row.channel as DeliveryChannel,
    format: row.format,
    destinationHash: row.destination_hash,
    payloadJson: row.payload_json,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Durable operational-event deliveries. A row is the idempotency record for one
 * event signature and channel; the payload is self-contained so a delivered or
 * pruned request cannot change what is sent.
 */
export class NotificationEventDeliveryRepository {
  constructor(private readonly db: Db) {}

  enqueue(input: EventDeliveryInput): EventDeliveryRecord {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_event_deliveries
           (id, dedupe_key, kind, cell_id, channel, format, destination_hash, payload_json,
            status, attempts, next_attempt_at, last_error, created_at, updated_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        randomUUID(),
        input.dedupeKey,
        input.kind,
        input.cellId,
        input.channel,
        input.format,
        input.destinationHash,
        input.payloadJson,
        input.now,
        input.now,
        input.now,
      );
    return this.getForDedupe(input.dedupeKey, input.channel);
  }

  get(id: string): EventDeliveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM notification_event_deliveries WHERE id = ?')
      .get(id) as EventDeliveryRow | undefined;
    return row ? toRecord(row) : null;
  }

  getForDedupe(dedupeKey: string, channel: DeliveryChannel): EventDeliveryRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM notification_event_deliveries
          WHERE dedupe_key = ? AND channel = ?
          LIMIT 1`,
      )
      .get(dedupeKey, channel) as EventDeliveryRow;
    return toRecord(row);
  }

  listDue(
    channel: DeliveryChannel,
    destinationHash: string,
    now: number,
    limit: number,
  ): EventDeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_event_deliveries
          WHERE status = 'pending'
            AND channel = ?
            AND next_attempt_at <= ?
            AND destination_hash = ?
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT ?`,
      )
      .all(channel, now, destinationHash, limit) as EventDeliveryRow[];
    return rows.map(toRecord);
  }

  listFiltered(filter: EventHistoryFilter): EventDeliveryRecord[] {
    const where = historyWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_event_deliveries${where.sql}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...where.params, filter.limit, filter.offset) as EventDeliveryRow[];
    return rows.map(toRecord);
  }

  countFiltered(filter: EventHistoryFilter): number {
    const where = historyWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM notification_event_deliveries${where.sql}`)
      .get(...where.params) as { total: number };
    return row.total;
  }

  /**
   * Put one failed or skipped event row back in the queue under the current
   * destination. Returns null when the row is not in a resendable state.
   */
  resetForResend(
    id: string,
    input: { format: DeliveryFormat; destinationHash: string; now: number },
  ): EventDeliveryRecord | null {
    const result = this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'pending',
                attempts = 0,
                next_attempt_at = ?,
                updated_at = ?,
                delivered_at = NULL,
                format = ?,
                destination_hash = ?
          WHERE id = ? AND status IN ('failed', 'skipped')`,
      )
      .run(input.now, input.now, input.format, input.destinationHash, id);
    return result.changes > 0 ? this.get(id) : null;
  }

  markDelivering(id: string, now: number): EventDeliveryRecord | null {
    this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'delivering',
                attempts = attempts + 1,
                updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(now, id);
    return this.get(id);
  }

  markDelivered(id: string, now: number): void {
    this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'delivered',
                last_error = NULL,
                delivered_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, id);
  }

  markRetry(id: string, now: number, nextAttemptAt: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'pending',
                next_attempt_at = ?,
                last_error = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(nextAttemptAt, reason, now, id);
  }

  markFailed(id: string, now: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'failed',
                last_error = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(reason, now, id);
  }

  markSkipped(id: string, now: number): void {
    this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'skipped',
                updated_at = ?
          WHERE id = ?`,
      )
      .run(now, id);
  }

  skipPending(channel: DeliveryChannel, now: number): number {
    return this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending' AND channel = ?`,
      )
      .run(now, channel).changes;
  }

  skipKindChannel(
    kind: NotificationEventKind,
    channel: DeliveryChannel,
    now: number,
  ): number {
    return this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending' AND kind = ? AND channel = ?`,
      )
      .run(now, kind, channel).changes;
  }

  /**
   * Skip pending rows whose cell is outside the current allowlist. A pair with
   * no routes keeps unrestricted behavior and should not call this method.
   */
  skipUnrouted(
    kind: NotificationEventKind,
    channel: DeliveryChannel,
    allowedCellIds: readonly string[],
    now: number,
  ): number {
    if (allowedCellIds.length === 0) {
      return this.skipKindChannel(kind, channel, now);
    }
    const placeholders = allowedCellIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending' AND kind = ? AND channel = ?
            AND (cell_id IS NULL OR cell_id NOT IN (${placeholders}))`,
      )
      .run(now, kind, channel, ...allowedCellIds).changes;
  }

  skipStaleDestination(
    channel: DeliveryChannel,
    destinationHash: string,
    now: number,
  ): number {
    return this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending' AND channel = ? AND destination_hash <> ?`,
      )
      .run(now, channel, destinationHash).changes;
  }

  /** Crash recovery: a row left mid-send is retried on the next start. */
  resetStale(now: number): number {
    return this.db
      .prepare(
        `UPDATE notification_event_deliveries
            SET status = 'pending', next_attempt_at = ?, updated_at = ?
          WHERE status = 'delivering'`,
      )
      .run(now, now).changes;
  }

  pruneBefore(cutoff: number): number {
    return this.db
      .prepare('DELETE FROM notification_event_deliveries WHERE created_at < ?')
      .run(cutoff).changes;
  }

  /** Summary for one event kind, or for every event when omitted. */
  status(kind?: NotificationEventKind): EventDeliveryStatusSummary {
    const where = kind === undefined ? '' : ' WHERE kind = ?';
    const params = kind === undefined ? [] : [kind];
    const counts = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN ('pending', 'delivering') THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM notification_event_deliveries${where}`,
      )
      .get(...params) as { pending: number; failed: number };
    const latest = this.db
      .prepare(
        `SELECT * FROM notification_event_deliveries${where}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`,
      )
      .get(...params) as EventDeliveryRow | undefined;
    return {
      pending: counts.pending,
      failed: counts.failed,
      lastDeliveryAt: latest?.updated_at ?? null,
      lastDeliveryStatus: latest?.status ?? null,
      lastError: latest?.last_error ?? null,
    };
  }
}
