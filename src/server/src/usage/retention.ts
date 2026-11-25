import type { Db } from '../db.js';
import type { ErrorSink } from '../logging/errors.js';
import { deleteInBatches } from '../retention/batches.js';
import type { SettingsStore } from '../settings.js';
import { recordUsagePruneState } from './prune-state.js';
import { UsageRollups } from './rollups.js';
import { USAGE_BUCKET_MS, usageBucketStart } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = USAGE_BUCKET_MS.day;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_ROLLUP_CHUNK_DAYS = 31;

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
  /** Exclusive boundary between daily rollups and raw rows; null when none. */
  rolledThrough: number | null;
}

export interface UsageRetentionOptions {
  db: Db;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  errors?: ErrorSink;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  intervalMs?: number;
  batchSize?: number;
  /** Injectable rollup store for tests; defaults to one backed by `db`. */
  rollups?: Pick<UsageRollups, 'watermark' | 'rollupThrough'>;
  /** Days covered by one rollup transaction; defaults to 31. */
  rollupChunkDays?: number;
}

/**
 * Rolls old raw `usage_events` rows into daily aggregates, then deletes them.
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
  private readonly rollups: Pick<UsageRollups, 'watermark' | 'rollupThrough'>;
  private readonly rollupChunkDays: number;

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
    this.rollups = options.rollups ?? new UsageRollups(options.db);
    this.rollupChunkDays =
      options.rollupChunkDays && options.rollupChunkDays > 0
        ? Math.max(1, Math.floor(options.rollupChunkDays))
        : DEFAULT_ROLLUP_CHUNK_DAYS;
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
   * One retention pass. A concurrent call joins the in-flight pass rather than
   * starting a second one. Never rejects: failures are reported and retried on
   * the next tick.
   */
  runOnce(now = this.clock()): Promise<UsagePruneResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.prune(now)
      .then((result) => {
        this.record(now, result);
        return result;
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  /**
   * Persist the pass summary for the dashboard. Bookkeeping must never turn a
   * completed prune into a rejected `runOnce` or block the next tick.
   */
  private record(now: number, result: UsagePruneResult): void {
    try {
      recordUsagePruneState(this.db, { ranAt: now, deletedRows: result.deleted });
    } catch (error) {
      this.errors?.error('usage.prune_state', error, {
        ranAt: now,
        deletedRows: result.deleted,
      });
    }
  }

  private async prune(now: number): Promise<UsagePruneResult> {
    const days = this.settings.get().usage.retentionDays;
    if (days <= 0) return { deleted: 0, cutoff: null, rolledThrough: null };

    // Day alignment keeps every rolled-up day complete and non-overlapping.
    const cutoff = usageBucketStart(now - days * DAY_MS, 'day');
    let watermark = 0;

    try {
      if (!this.hasUsageEvents()) {
        return { deleted: 0, cutoff, rolledThrough: null };
      }

      watermark = this.rollups.watermark();
      while (watermark < cutoff) {
        const chunk = this.rollups.rollupThrough(cutoff, {
          maxDays: this.rollupChunkDays,
        });
        if (chunk.done) {
          watermark = Math.max(watermark, chunk.to);
          break;
        }
        if (chunk.to <= watermark) {
          throw new Error('usage rollup made no progress');
        }
        watermark = chunk.to;
        // Let requests and timers run between bounded rollup transactions.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.stopping) {
          return { deleted: 0, cutoff, rolledThrough: watermark || null };
        }
      }
    } catch (error) {
      this.errors?.error('usage.rollup', error, {
        cutoff,
        rolledThrough: watermark || null,
      });
      return { deleted: 0, cutoff, rolledThrough: watermark || null };
    }

    let deleted = 0;
    try {
      const statement = this.db.prepare(DELETE_SQL);
      deleted = await deleteInBatches({
        runBatch: () => Number(statement.run(watermark, this.batchSize).changes),
        batchSize: this.batchSize,
        shouldStop: () => this.stopping,
      });
      return { deleted, cutoff, rolledThrough: watermark || null };
    } catch (error) {
      this.errors?.error('usage.prune', error, {
        cutoff,
        deleted,
        rolledThrough: watermark || null,
      });
      return { deleted, cutoff, rolledThrough: watermark || null };
    }
  }

  private hasUsageEvents(): boolean {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'")
      .get();
    return Boolean(table);
  }
}
