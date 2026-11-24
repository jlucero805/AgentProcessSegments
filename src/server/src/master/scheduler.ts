import type { CellRepository } from '../cells/repository.js';
import type { MasterErrorNotification } from '../domain/notifications.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';
import { SpendCapError } from '../usage/spend-cap.js';
import type { MasterService } from './service.js';
import type { MasterResult, MasterStatus } from './types.js';

interface TimerState {
  intervalMs: number;
  nextRunAt: number;
  timer: NodeJS.Timeout;
}

const REFRESH_MS = 30_000;

/**
 * One timer per cell with its master enabled. Intervals come from the cell
 * (`masterIntervalMinutes`) or fall back to the global scheduler interval. A periodic
 * refresh picks up cells created or deleted through another client. Unassigned
 * requests have no master and never get a timer. A cell's timer and manual Run now
 * share one key, so a tick during an active cycle is skipped and retried next interval.
 */
export class MasterScheduler {
  private readonly timers = new Map<string, TimerState>();
  private readonly active = new Map<string, Promise<MasterResult>>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(
    private readonly service: MasterService,
    private readonly settings: SettingsStore,
    private readonly cells: CellRepository,
    private readonly errors?: ErrorSink,
    private readonly onError?: (event: MasterErrorNotification) => void,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.settings.onChange(() => this.refresh());
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
    this.refreshTimer.unref?.();
    this.refresh();
  }

  stop(): void {
    this.started = false;
    for (const state of this.timers.values()) clearInterval(state.timer);
    this.timers.clear();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Reconcile timers after a cell or scheduler-policy change. */
  refresh(): void {
    if (!this.started) return;
    const master = this.settings.get().master;
    const desired = new Map<string, { intervalMs: number; run: () => Promise<MasterResult> }>();

    if (master.enabled) {
      for (const cell of this.cells.list()) {
        if (!cell.masterEnabled) continue;
        const minutes = cell.masterIntervalMinutes ?? master.intervalMinutes;
        desired.set(cell.id, {
          intervalMs: minutes * 60_000,
          run: () => this.service.runCell(cell.id),
        });
      }
    }

    for (const [key, state] of this.timers) {
      if (desired.has(key)) continue;
      clearInterval(state.timer);
      this.timers.delete(key);
    }

    for (const [key, { intervalMs, run }] of desired) {
      const existing = this.timers.get(key);
      if (existing && existing.intervalMs === intervalMs) continue;
      if (existing) clearInterval(existing.timer);
      const nextRunAt = Date.now() + intervalMs;
      const timer = setInterval(() => {
        // Advance the cadence before running. When this tick lands during an
        // active cycle for the same cell, `runKey` returns that run instead of
        // starting another one, so the tick is dropped and the cell tries again
        // on the next interval.
        const current = this.timers.get(key);
        if (current) current.nextRunAt = Date.now() + intervalMs;
        void this.runKey(key, run).catch((error: unknown) => {
          this.errors?.error('master.cycle', error, { cellId: key });
          try {
            this.onError?.({
              source: 'master.cycle',
              cellId: key,
              requestId: null,
              segment: null,
              occurredAt: Date.now(),
            });
          } catch (callbackError) {
            this.errors?.error('notifications.event', callbackError, {
              kind: 'master.error',
              cellId: key,
              source: 'master.cycle',
            });
          }
        });
      }, intervalMs);
      timer.unref?.();
      this.timers.set(key, { intervalMs, nextRunAt, timer });
    }
  }

  async runNow(cellId: string): Promise<MasterResult> {
    const pause = this.service.pauseFor(cellId);
    if (pause) throw new SpendCapError(pause);
    return this.runKey(cellId, () => this.service.runCell(cellId));
  }

  status(): MasterStatus {
    const master = this.settings.get().master;
    const nextRunAt =
      [...this.timers.values()].map((state) => state.nextRunAt).sort((a, b) => a - b)[0] ?? null;
    return {
      enabled: master.enabled,
      intervalMinutes: master.intervalMinutes,
      running: this.active.size > 0,
      nextRunAt,
      lastRunAt: this.service.lastRunAt,
      lastResult: this.service.lastResult,
    };
  }

  statusFor(cellId: string): MasterStatus {
    const master = this.settings.get().master;
    const cell = this.cells.get(cellId);
    const timer = this.timers.get(cellId);
    const last = this.service.lastFor(cellId);
    return {
      enabled: master.enabled && cell?.masterEnabled === true,
      intervalMinutes: cell?.masterIntervalMinutes ?? master.intervalMinutes,
      running: this.active.has(cellId),
      nextRunAt: timer?.nextRunAt ?? null,
      lastRunAt: last?.at ?? null,
      lastResult: last?.result ?? null,
    };
  }

  private runKey(key: string, run: () => Promise<MasterResult>): Promise<MasterResult> {
    const existing = this.active.get(key);
    if (existing) return existing;
    const pending = run().finally(() => this.active.delete(key));
    this.active.set(key, pending);
    return pending;
  }
}
