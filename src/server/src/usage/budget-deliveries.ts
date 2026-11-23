import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type {
  DeliveryStatus,
  WebhookFormat,
} from '../domain/budget.js';

export const WEBHOOK_CHANNEL = 'webhook';

export interface DeliveryRecord {
  id: string;
  alertId: string;
  channel: string;
  format: WebhookFormat;
  destinationHash: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

export interface DeliveryInput {
  alertId: string;
  format: WebhookFormat;
  destinationHash: string;
  now: number;
}

export interface DeliveryStatusSummary {
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

interface DeliveryRow {
  id: string;
  alert_id: string;
  channel: string;
  format: WebhookFormat;
  destination_hash: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

function toRecord(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    alertId: row.alert_id,
    channel: row.channel,
    format: row.format,
    destinationHash: row.destination_hash,
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
 * Durable webhook deliveries. A row is the idempotency record for one alert and
 * channel, and its destination hash keeps a config change from sending an old
 * alert with new credentials.
 */
export class BudgetAlertDeliveryRepository {
  constructor(private readonly db: Db) {}

  enqueue(input: DeliveryInput): DeliveryRecord {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO budget_alert_deliveries
           (id, alert_id, channel, format, destination_hash, status, attempts,
            next_attempt_at, last_error, created_at, updated_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        randomUUID(),
        input.alertId,
        WEBHOOK_CHANNEL,
        input.format,
        input.destinationHash,
        input.now,
        input.now,
        input.now,
      );
    return this.getForAlert(input.alertId);
  }

  get(id: string): DeliveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM budget_alert_deliveries WHERE id = ?')
      .get(id) as DeliveryRow | undefined;
    return row ? toRecord(row) : null;
  }

  getForAlert(alertId: string): DeliveryRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM budget_alert_deliveries
          WHERE alert_id = ? AND channel = ?
          LIMIT 1`,
      )
      .get(alertId, WEBHOOK_CHANNEL) as DeliveryRow;
    return toRecord(row);
  }

  listDue(
    destinationHash: string,
    periodStart: number,
    now: number,
    limit: number,
  ): DeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM budget_alert_deliveries d
           JOIN budget_alerts a ON a.id = d.alert_id
          WHERE d.status = 'pending'
            AND d.next_attempt_at <= ?
            AND d.destination_hash = ?
            AND a.acknowledged_at IS NULL
            AND a.period_start = ?
          ORDER BY d.next_attempt_at ASC, d.created_at ASC
          LIMIT ?`,
      )
      .all(now, destinationHash, periodStart, limit) as DeliveryRow[];
    return rows.map(toRecord);
  }

  markDelivering(id: string, now: number): DeliveryRecord | null {
    this.db
      .prepare(
        `UPDATE budget_alert_deliveries
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
        `UPDATE budget_alert_deliveries
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
        `UPDATE budget_alert_deliveries
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
        `UPDATE budget_alert_deliveries
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
        `UPDATE budget_alert_deliveries
            SET status = 'skipped',
                updated_at = ?
          WHERE id = ?`,
      )
      .run(now, id);
  }

  skipPending(now: number): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending'`,
      )
      .run(now).changes;
  }

  skipAcknowledged(now: number): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending'
            AND alert_id IN (
              SELECT id FROM budget_alerts WHERE acknowledged_at IS NOT NULL
            )`,
      )
      .run(now).changes;
  }

  skipStaleDestination(destinationHash: string, now: number): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending' AND destination_hash <> ?`,
      )
      .run(now, destinationHash).changes;
  }

  skipBeforePeriod(periodStart: number, now: number): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending'
            AND alert_id IN (
              SELECT id FROM budget_alerts WHERE period_start < ?
            )`,
      )
      .run(now, periodStart).changes;
  }

  /** Crash recovery: a row left mid-send is retried on the next start. */
  resetStale(now: number): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'pending', next_attempt_at = ?, updated_at = ?
          WHERE status = 'delivering'`,
      )
      .run(now, now).changes;
  }

  pruneBefore(cutoff: number): number {
    return this.db
      .prepare('DELETE FROM budget_alert_deliveries WHERE created_at < ?')
      .run(cutoff).changes;
  }

  status(): DeliveryStatusSummary {
    const counts = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN ('pending', 'delivering') THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM budget_alert_deliveries`,
      )
      .get() as { pending: number; failed: number };
    const latest = this.db
      .prepare(
        `SELECT * FROM budget_alert_deliveries
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`,
      )
      .get() as DeliveryRow | undefined;
    return {
      pending: counts.pending,
      failed: counts.failed,
      lastDeliveryAt: latest?.updated_at ?? null,
      lastDeliveryStatus: latest?.status ?? null,
      lastError: latest?.last_error ?? null,
    };
  }
}
