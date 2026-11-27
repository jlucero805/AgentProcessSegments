import type { CellRepository } from '../cells/repository.js';
import type { SpendPause } from '../domain/budget.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';
import { errorMessage } from '../util/errors.js';
import { SpendCapError } from '../usage/spend-cap.js';
import type { SummaryRepository } from './repository.js';
import type { Summary, SummaryConfig, SummaryStatus } from './types.js';

const SCAN_MS = 30_000;
const MAX_FAILURE_BACKOFF_MS = 30 * 60_000;

export interface SummaryRunner {
  generate(cellId: string): Promise<Summary>;
}

export interface SummarySchedulerDeps {
  service: SummaryRunner;
  settings: SettingsStore;
  cells: CellRepository;
  summaries: SummaryRepository;
  errors?: ErrorSink;
  /** Optional hard-cap admission check for a cell. */
  spendCap?: (cellId: string) => SpendPause | null;
}

interface QueuedSummary {
  cellId: string;
  promise: Promise<Summary>;
  resolve: (summary: Summary) => void;
  reject: (error: unknown) => void;
}

interface FailureState {
  at: number;
  message: string;
}

/**
 * One scan for every cell. A summary is due when the cell has no report or its
 * latest report is older than the configured interval. Generations are serialized
 * and coalesced per cell, so a broken harness cannot start one turn per tick.
 */
export class SummaryScheduler {
  private started = false;
  private scanning = false;
  private draining = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly jobs = new Map<string, QueuedSummary>();
  private readonly order: string[] = [];
  private readonly failures = new Map<string, FailureState>();

  constructor(private readonly deps: SummarySchedulerDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.deps.settings.onChange(() => this.refresh());
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), SCAN_MS);
    this.scanTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Re-evaluate due cells after a policy or cell-list change. */
  refresh(): void {
    this.scan();
  }

  /** Generate now. Manual runs ignore the auto-enabled switch and failure backoff. */
  runNow(cellId: string): Promise<Summary> {
    this.deps.cells.require(cellId);
    const pause = this.deps.spendCap?.(cellId) ?? null;
    if (pause) throw new SpendCapError(pause);
    return this.enqueue(cellId);
  }

  statusFor(cellId: string): SummaryStatus {
    this.deps.cells.require(cellId);
    return this.cellStatus(
      cellId,
      this.deps.summaries.latest(cellId),
      this.deps.settings.get().summary,
    );
  }

  status(): SummaryStatus {
    const settings = this.deps.settings.get().summary;
    const cells = this.deps.cells.list();
    const latestByCell = new Map<string, Summary>();
    if (cells.length > 0) {
      for (const { summary } of this.deps.summaries.latestPerCell()) {
        latestByCell.set(summary.cellId, summary);
      }
    }
    const perCell = cells.map((cell) =>
      this.cellStatus(cell.id, latestByCell.get(cell.id) ?? null, settings),
    );
    const nextRuns = perCell
      .map((entry) => entry.nextRunAt)
      .filter((value): value is number => value !== null);
    const lastRuns = perCell
      .map((entry) => entry.lastRunAt)
      .filter((value): value is number => value !== null);
    return {
      enabled: settings.enabled,
      intervalMinutes: settings.intervalMinutes,
      windowMinutes: settings.windowMinutes,
      running: this.jobs.size > 0,
      nextRunAt: settings.enabled && nextRuns.length > 0 ? Math.min(...nextRuns) : null,
      lastRunAt: lastRuns.length > 0 ? Math.max(...lastRuns) : null,
      lastError: null,
    };
  }

  private cellStatus(
    cellId: string,
    latest: Summary | null,
    settings: SummaryConfig,
  ): SummaryStatus {
    const failure = this.failures.get(cellId);
    const intervalMs = settings.intervalMinutes * 60_000;
    const backoffUntil = failure
      ? failure.at + Math.min(intervalMs, MAX_FAILURE_BACKOFF_MS)
      : 0;
    const dueAt = latest ? latest.createdAt + intervalMs : Date.now();
    return {
      enabled: settings.enabled,
      intervalMinutes: settings.intervalMinutes,
      windowMinutes: settings.windowMinutes,
      running: this.jobs.has(cellId),
      nextRunAt: settings.enabled
        ? Math.max(dueAt, backoffUntil, Date.now())
        : null,
      lastRunAt: latest?.createdAt ?? null,
      lastError: failure?.message ?? null,
    };
  }

  private scan(): void {
    if (!this.started || this.scanning) return;
    const settings = this.deps.settings.get().summary;
    if (!settings.enabled) return;

    this.scanning = true;
    try {
      const now = Date.now();
      const intervalMs = settings.intervalMinutes * 60_000;
      const backoffMs = Math.min(intervalMs, MAX_FAILURE_BACKOFF_MS);
      const cells = this.deps.cells.list();
      const live = new Set(cells.map((cell) => cell.id));
      for (const cellId of this.failures.keys()) {
        if (!live.has(cellId)) this.failures.delete(cellId);
      }
      // One grouped read replaces a latest() point lookup per cell. Decisions
      // still follow the cell snapshot, so orphan summaries are ignored.
      const latestAt = new Map<string, number>();
      if (cells.length > 0) {
        for (const { summary } of this.deps.summaries.latestPerCell()) {
          latestAt.set(summary.cellId, summary.createdAt);
        }
      }

      for (const cell of cells) {
        if (this.jobs.has(cell.id)) continue;
        if (this.deps.spendCap?.(cell.id)) continue;
        const createdAt = latestAt.get(cell.id);
        const failure = this.failures.get(cell.id);
        const dueAt = createdAt !== undefined ? createdAt + intervalMs : 0;
        const retryAt = failure ? failure.at + backoffMs : 0;
        if (now < Math.max(dueAt, retryAt)) continue;
        void this.enqueue(cell.id).catch(() => {
          // The service records `summary.generate`; the next scan applies backoff.
        });
      }
    } finally {
      this.scanning = false;
    }
  }

  private enqueue(cellId: string): Promise<Summary> {
    const existing = this.jobs.get(cellId);
    if (existing) return existing.promise;

    let resolve!: (summary: Summary) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Summary>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.jobs.set(cellId, { cellId, promise, resolve, reject });
    this.order.push(cellId);
    void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.order.length > 0) {
        const cellId = this.order.shift();
        if (!cellId) continue;
        const job = this.jobs.get(cellId);
        if (!job) continue;

        try {
          const summary = await this.deps.service.generate(cellId);
          this.failures.delete(cellId);
          job.resolve(summary);
        } catch (error) {
          // A hard-cap pause is not a generation failure: no backoff and no
          // lastError. The next due scan after resume runs normally.
          if (!(error instanceof SpendCapError)) {
            this.failures.set(cellId, { at: Date.now(), message: errorMessage(error) });
          }
          job.reject(error);
        } finally {
          this.jobs.delete(cellId);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
