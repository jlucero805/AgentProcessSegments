import type { Db } from '../db.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 1000;

const DELETE_SQL = `
  DELETE FROM usage_events
  WHERE id IN (
    SELECT id FROM usage_events
    WHERE created_at < ?
    ORDER BY created_at
    LIMIT ?
  )
`;

export interface UsagePruneResult {
  deleted: number;
  /** Null when retention is disabled, so there is no cutoff to report. */
  cutoff: number | null;
}

export interface UsageRetentionOptions {
  db: Db;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  errors?: ErrorSink;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  intervalMs?: number;
  batchSize?: number;
}

/**
 * Deletes raw `usage_events` rows older than the configured retention window.
 * Runs once at startup, hourly after that, and again whenever settings change.
 *
 * The usage ledger is owned by the usage-tracking change. Until that table
 * exists this job is a silent no-op, so retention can ship ahead of the
 * dashboard without logging a failure every hour.
 */
export class UsageRetention {
  private readonly db: Db;
  private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>;
  private readonly errors?: ErrorSink;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<UsagePruneResult> | null = null;
  private stopping = false;

  constructor(options: UsageRetentionOptions) {
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
  runOnce(now = this.clock()): Promise<UsagePruneResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.prune(now).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async prune(now: number): Promise<UsagePruneResult> {
    const days = this.settings.get().usage.retentionDays;
    if (days <= 0) return { deleted: 0, cutoff: null };

    const cutoff = now - days * DAY_MS;
    let deleted = 0;
    try {
      const table = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'",
        )
        .get();
      if (!table) return { deleted: 0, cutoff };

      const statement = this.db.prepare(DELETE_SQL);
      for (;;) {
        const changes = Number(statement.run(cutoff, this.batchSize).changes);
        deleted += changes;
        if (changes < this.batchSize) break;
        // Let other requests and timers run between batches: better-sqlite3 is
        // synchronous and one unbounded delete would block the brain.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.stopping) break;
      }
      return { deleted, cutoff };
    } catch (error) {
      this.errors?.error('usage.prune', error, { cutoff, deleted });
      return { deleted, cutoff };
    }
  }
}
