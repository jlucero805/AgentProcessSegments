import type { Db } from '../db.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';
import { deleteInBatches } from './batches.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 1000;

// Follow-up rows are the permanent dedupe key for `FOLLOW-UP:` titles
// (invariant 16). They grow with created follow-ups, not scheduler cycles, so
// they stay out of the purge.
const DELETE_SQL = `
  DELETE FROM master_events
  WHERE id IN (
    SELECT id FROM master_events
    WHERE created_at < ? AND action <> 'followup'
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

/**
 * Deletes raw `master_events` rows older than the configured retention window.
 * Runs once at startup, hourly after that, and again whenever settings change.
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
    const days = this.settings.get().retention.masterEventsDays;
    if (days <= 0) return { masterEvents: { deleted: 0, cutoff: null } };

    const cutoff = now - days * DAY_MS;
    let deleted = 0;
    try {
      const statement = this.db.prepare(DELETE_SQL);
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
      return { masterEvents: { deleted, cutoff } };
    } catch (error) {
      this.errors?.error('retention.prune', error, {
        table: 'master_events',
        cutoff,
        deleted,
      });
      return { masterEvents: { deleted, cutoff } };
    }
  }
}
