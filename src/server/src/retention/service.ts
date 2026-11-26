import type { Db } from '../db.js';
import { budgetPeriod } from '../domain/budget.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';
import { deleteInBatches } from './batches.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 1000;

// Follow-up rows are the permanent dedupe key for `FOLLOW-UP:` titles
// (invariant 16). They grow with created follow-ups, not scheduler cycles, so
// they stay out of the purge.
const MASTER_EVENTS_DELETE_SQL = `
  DELETE FROM master_events
  WHERE id IN (
    SELECT id FROM master_events
    WHERE created_at < ? AND action <> 'followup'
    ORDER BY created_at
    LIMIT ?
  )
`;

// The newest report per cell is always kept: `SummaryRepository.latest()` drives
// the scorecard drawer and the scheduler's due-ness, so pruning it would blank a
// dormant cell's scorecard and queue an immediate regeneration. The subquery
// matches `latest()`'s ordering (`created_at DESC, id DESC`).
const CELL_SUMMARIES_DELETE_SQL = `
  DELETE FROM cell_summaries
  WHERE id IN (
    SELECT s.id FROM cell_summaries s
    WHERE s.created_at < ?
      AND s.id <> (
        SELECT l.id FROM cell_summaries l
        WHERE l.cell_id = s.cell_id
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 1
      )
    ORDER BY s.created_at
    LIMIT ?
  )
`;

// Budget alerts and their outbox are keyed to the current UTC period: a
// delivery row is the idempotency record for an alert, and an acknowledged
// alert suppresses a lower-severity one. The cutoff is capped at the period
// start so no current-month row is pruned even with a short window.
const BUDGET_ALERT_DELIVERIES_DELETE_SQL = `
  DELETE FROM budget_alert_deliveries
  WHERE id IN (
    SELECT id FROM budget_alert_deliveries
    WHERE created_at < ?
      AND status IN ('delivered', 'failed', 'skipped')
    ORDER BY created_at
    LIMIT ?
  )
`;

// Unacknowledged alerts belong to budget reconciliation, which removes them
// when the budget changes or the period rolls over. Retention only bounds the
// acknowledged history. Deleting an alert leaves its snapshotted delivery
// history in place: terminal rows are pruned by the delivery pass, and pending
// rows whose alert is gone are skipped by the notifier drain.
const BUDGET_ALERTS_DELETE_SQL = `
  DELETE FROM budget_alerts
  WHERE id IN (
    SELECT id FROM budget_alerts
    WHERE created_at < ?
      AND acknowledged_at IS NOT NULL
    ORDER BY created_at
    LIMIT ?
  )
`;

export interface TablePruneResult {
  deleted: number;
  /** Null when retention is disabled, so there is no cutoff to report. */
  cutoff: number | null;
}

export interface RetentionRunResult {
  masterEvents: TablePruneResult;
  cellSummaries: TablePruneResult;
  budgetAlertDeliveries: TablePruneResult;
  budgetAlerts: TablePruneResult;
}

export interface DataRetentionOptions {
  db: Db;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  errors?: ErrorSink;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  intervalMs?: number;
  batchSize?: number;
}

type PruneTable =
  | 'master_events'
  | 'cell_summaries'
  | 'budget_alert_deliveries'
  | 'budget_alerts';

/**
 * Deletes raw `master_events` rows, old `cell_summaries` reports, terminal
 * budget-alert deliveries, and acknowledged budget alerts outside their
 * configured retention windows. Runs once at startup, hourly after that, and
 * again whenever settings change. Each table prunes independently: one failure
 * is reported and retried on the next tick without blocking the other tables.
 */
export class DataRetention {
  private readonly db: Db;
  private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>;
  private readonly errors?: ErrorSink;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<RetentionRunResult> | null = null;
  private stopping = false;

  constructor(options: DataRetentionOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.errors = options.errors;
    this.clock = options.now ?? (() => Date.now());
    this.intervalMs =
      options.intervalMs && options.intervalMs > 0 ? options.intervalMs : HOUR_MS;
    this.batchSize =
      options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.unsubscribe = this.settings.onChange(() => {
      void this.runOnce();
    });
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * One prune pass. A concurrent call joins the in-flight pass rather than
   * starting a second one. Never rejects: failures are reported and retried on
   * the next tick.
   */
  runOnce(now = this.clock()): Promise<RetentionRunResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.prune(now).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async prune(now: number): Promise<RetentionRunResult> {
    const retention = this.settings.get().retention;
    const masterEvents = await this.pruneTable(
      now,
      'master_events',
      retention.masterEventsDays,
      MASTER_EVENTS_DELETE_SQL,
    );
    const cellSummaries = await this.pruneTable(
      now,
      'cell_summaries',
      retention.cellSummariesDays,
      CELL_SUMMARIES_DELETE_SQL,
    );
    const budgetCutoff = budgetPeriod(now).start;
    const budgetAlertDeliveries = await this.pruneTable(
      now,
      'budget_alert_deliveries',
      retention.budgetAlertsDays,
      BUDGET_ALERT_DELIVERIES_DELETE_SQL,
      budgetCutoff,
    );
    const budgetAlerts = await this.pruneTable(
      now,
      'budget_alerts',
      retention.budgetAlertsDays,
      BUDGET_ALERTS_DELETE_SQL,
      budgetCutoff,
    );
    return { masterEvents, cellSummaries, budgetAlertDeliveries, budgetAlerts };
  }

  private async pruneTable(
    now: number,
    table: PruneTable,
    days: number,
    sql: string,
    maxCutoff = Number.POSITIVE_INFINITY,
  ): Promise<TablePruneResult> {
    if (days <= 0) return { deleted: 0, cutoff: null };

    // `maxCutoff` caps the age window at the current UTC period start for the
    // budget tables, so the current month is never pruned.
    const cutoff = Math.min(now - days * DAY_MS, maxCutoff);
    let deleted = 0;
    try {
      const statement = this.db.prepare(sql);
      // `runBatch` accumulates locally so a failure mid-drain still reports the
      // batches that committed.
      await deleteInBatches({
        runBatch: () => {
          const changes = Number(statement.run(cutoff, this.batchSize).changes);
          deleted += changes;
          return changes;
        },
        batchSize: this.batchSize,
        shouldStop: () => this.stopping,
      });
      return { deleted, cutoff };
    } catch (error) {
      this.errors?.error('retention.prune', error, { table, cutoff, deleted });
      return { deleted, cutoff };
    }
  }
}
