import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type {
  BudgetScope,
  BudgetThreshold,
  DeliveryChannel,
  DeliveryFormat,
  DeliveryStatus,
} from '../domain/budget.js';

export const WEBHOOK_CHANNEL = 'webhook';

export interface DeliveryRecord {
  id: string;
  alertId: string;
  channel: DeliveryChannel;
  destinationId: string;
  format: DeliveryFormat;
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
  /** Defaults to the webhook channel so older callers keep their shape. */
  channel?: DeliveryChannel;
  /** Defaults to the channel, which is the identity webhook and email rows use. */
  destinationId?: string;
  format: DeliveryFormat;
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
  destination_id: string;
  format: DeliveryFormat;
  destination_hash: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

/** The alert fields joined into a delivery-history row. */
export interface DeliveryAlertRecord {
  scope: BudgetScope;
  scopeId: string;
  threshold: BudgetThreshold;
  alertAtPercent: number;
  budgetUsd: number;
  spendUsd: number;
  unknownCostTurns: number;
  periodStart: number;
  createdAt: number;
  acknowledgedAt: number | null;
}

export interface DeliveryHistoryRecord {
  delivery: DeliveryRecord;
  alert: DeliveryAlertRecord;
}

export interface DeliveryHistoryFilter {
  channel?: DeliveryChannel;
  status?: DeliveryStatus;
  alertId?: string;
  /** Inclusive created-at lower bound in epoch milliseconds. */
  from?: number;
  /** Exclusive created-at upper bound in epoch milliseconds. */
  to?: number;
  limit: number;
  offset: number;
}

interface DeliveryHistoryRow extends DeliveryRow {
  scope: BudgetScope;
  scope_id: string;
  threshold: BudgetThreshold;
  alert_at_percent: number;
  budget_usd: number;
  spend_usd: number;
  unknown_cost_turns: number;
  alert_period_start: number;
  alert_created_at: number;
  acknowledged_at: number | null;
}

/** Fixed SQL fragments; every value stays a bound parameter. */
function historyWhere(filter: DeliveryHistoryFilter): {
  sql: string;
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.channel !== undefined) {
    clauses.push('d.channel = ?');
    params.push(filter.channel);
  }
  if (filter.status !== undefined) {
    clauses.push('d.status = ?');
    params.push(filter.status);
  }
  if (filter.alertId !== undefined) {
    clauses.push('d.alert_id = ?');
    params.push(filter.alertId);
  }
  if (filter.from !== undefined) {
    clauses.push('d.created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('d.created_at < ?');
    params.push(filter.to);
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
}

function toRecord(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    alertId: row.alert_id,
    channel: row.channel as DeliveryChannel,
    destinationId: row.destination_id,
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
 * Durable alert deliveries. A row is the idempotency record for one alert and
 * destination, and its destination hash keeps a config change from sending an
 * old alert with new credentials.
 */
export class BudgetAlertDeliveryRepository {
  constructor(private readonly db: Db) {}

  enqueue(input: DeliveryInput): DeliveryRecord {
    const channel = input.channel ?? WEBHOOK_CHANNEL;
    const destinationId = input.destinationId ?? channel;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO budget_alert_deliveries
           (id, alert_id, channel, destination_id, format, destination_hash, status, attempts,
            next_attempt_at, last_error, created_at, updated_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        randomUUID(),
        input.alertId,
        channel,
        destinationId,
        input.format,
        input.destinationHash,
        input.now,
        input.now,
        input.now,
      );
    return this.getForAlert(input.alertId, destinationId);
  }

  get(id: string): DeliveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM budget_alert_deliveries WHERE id = ?')
      .get(id) as DeliveryRow | undefined;
    return row ? toRecord(row) : null;
  }

  getForAlert(
    alertId: string,
    destinationId: string = WEBHOOK_CHANNEL,
  ): DeliveryRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM budget_alert_deliveries
          WHERE alert_id = ? AND destination_id = ?
          LIMIT 1`,
      )
      .get(alertId, destinationId) as DeliveryRow;
    return toRecord(row);
  }

  /** Newest first, joined to the alert for the audit view. */
  listFiltered(filter: DeliveryHistoryFilter): DeliveryHistoryRecord[] {
    const where = historyWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT d.*, a.scope, a.scope_id, a.threshold, a.alert_at_percent, a.budget_usd,
                a.spend_usd, a.unknown_cost_turns,
                a.period_start AS alert_period_start,
                a.created_at AS alert_created_at,
                a.acknowledged_at
           FROM budget_alert_deliveries d
           JOIN budget_alerts a ON a.id = d.alert_id
          WHERE 1 = 1${where.sql}
          ORDER BY d.created_at DESC, d.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...where.params, filter.limit, filter.offset) as DeliveryHistoryRow[];
    return rows.map((row) => ({
      delivery: toRecord(row),
      alert: {
        scope: row.scope,
        scopeId: row.scope_id,
        threshold: row.threshold,
        alertAtPercent: row.alert_at_percent,
        budgetUsd: row.budget_usd,
        spendUsd: row.spend_usd,
        unknownCostTurns: row.unknown_cost_turns,
        periodStart: row.alert_period_start,
        createdAt: row.alert_created_at,
        acknowledgedAt: row.acknowledged_at,
      },
    }));
  }

  countFiltered(filter: DeliveryHistoryFilter): number {
    const where = historyWhere(filter);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total
           FROM budget_alert_deliveries d
           JOIN budget_alerts a ON a.id = d.alert_id
          WHERE 1 = 1${where.sql}`,
      )
      .get(...where.params) as { total: number };
    return row.total;
  }

  /**
   * Put one failed or skipped row back in the queue under the current
   * destination. Returns null when the row is not in a resendable state.
   */
  resetForResend(
    id: string,
    input: { format: DeliveryFormat; destinationHash: string; now: number },
  ): DeliveryRecord | null {
    const result = this.db
      .prepare(
        `UPDATE budget_alert_deliveries
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

  listDue(
    channel: DeliveryChannel,
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
            AND d.channel = ?
            AND d.next_attempt_at <= ?
            AND d.destination_hash = ?
            AND a.acknowledged_at IS NULL
            AND a.period_start = ?
          ORDER BY d.next_attempt_at ASC, d.created_at ASC
          LIMIT ?`,
      )
      .all(channel, now, destinationHash, periodStart, limit) as DeliveryRow[];
    return rows.map(toRecord);
  }

  /** Due rows for a provider that routes per destination, without a hash filter. */
  listDueForChannel(
    channel: DeliveryChannel,
    periodStart: number,
    now: number,
    limit: number,
  ): DeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM budget_alert_deliveries d
           JOIN budget_alerts a ON a.id = d.alert_id
          WHERE d.status = 'pending'
            AND d.channel = ?
            AND d.next_attempt_at <= ?
            AND a.acknowledged_at IS NULL
            AND a.period_start = ?
          ORDER BY d.next_attempt_at ASC, d.created_at ASC
          LIMIT ?`,
      )
      .all(channel, now, periodStart, limit) as DeliveryRow[];
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

  skipPending(channel: DeliveryChannel, now: number): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending' AND channel = ?`,
      )
      .run(now, channel).changes;
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

  skipStaleDestination(channel: DeliveryChannel, destinationHash: string, now: number): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending' AND channel = ? AND destination_hash <> ?`,
      )
      .run(now, channel, destinationHash).changes;
  }

  skipStaleDestinationFor(
    channel: DeliveryChannel,
    destinationId: string,
    destinationHash: string,
    now: number,
  ): number {
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending'
            AND channel = ?
            AND destination_id = ?
            AND destination_hash <> ?`,
      )
      .run(now, channel, destinationId, destinationHash).changes;
  }

  skipDestinationsNotIn(
    channel: DeliveryChannel,
    destinationIds: string[],
    now: number,
  ): number {
    if (destinationIds.length === 0) return this.skipPending(channel, now);
    const placeholders = destinationIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `UPDATE budget_alert_deliveries
            SET status = 'skipped', updated_at = ?
          WHERE status = 'pending'
            AND channel = ?
            AND destination_id NOT IN (${placeholders})`,
      )
      .run(now, channel, ...destinationIds).changes;
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

  /** Summary for one channel, one destination, or every channel when omitted. */
  status(channel?: DeliveryChannel, destinationId?: string): DeliveryStatusSummary {
    const clauses: string[] = [];
    const params: string[] = [];
    if (channel !== undefined) {
      clauses.push('channel = ?');
      params.push(channel);
    }
    if (destinationId !== undefined) {
      clauses.push('destination_id = ?');
      params.push(destinationId);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const counts = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN ('pending', 'delivering') THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM budget_alert_deliveries${where}`,
      )
      .get(...params) as { pending: number; failed: number };
    const latest = this.db
      .prepare(
        `SELECT * FROM budget_alert_deliveries${where}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`,
      )
      .get(...params) as DeliveryRow | undefined;
    return {
      pending: counts.pending,
      failed: counts.failed,
      lastDeliveryAt: latest?.updated_at ?? null,
      lastDeliveryStatus: latest?.status ?? null,
      lastError: latest?.last_error ?? null,
    };
  }
}
