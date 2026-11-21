import type { CellRepository } from '../cells/repository.js';
import type { SettingsStore } from '../settings.js';
import type { MasterService } from './service.js';
import type { MasterResult, MasterStatus } from './types.js';

interface TimerState {
  intervalMs: number;
  nextRunAt: number;
  timer: NodeJS.Timeout;
}

const REFRESH_MS = 30_000;
const ALL_KEY = '__all__';

/**
 * One timer per cell plus one for unassigned work. Intervals come from the cell
 * (`masterIntervalMinutes`) or fall back to the global scheduler interval. A periodic
 * refresh picks up cells created or deleted through another client.
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
      if (master.includeUnassigned) {
        desired.set('', {
          intervalMs: master.intervalMinutes * 60_000,
          run: () => this.service.runUnassigned(),
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
        const current = this.timers.get(key);
        if (current) current.nextRunAt = Date.now() + intervalMs;
        void this.runKey(key, run).catch((error: unknown) => {
          console.error(`master cycle failed for ${key || 'unassigned'}:`, error);
        });
      }, intervalMs);
      timer.unref?.();
      this.timers.set(key, { intervalMs, nextRunAt, timer });
    }
  }

  async runNow(cellId?: string | null): Promise<MasterResult> {
    if (cellId === undefined) return this.runKey(ALL_KEY, () => this.service.runOnce());
    const key = cellId ?? '';
    return this.runKey(key, () =>
      cellId === null ? this.service.runUnassigned() : this.service.runCell(cellId),
    );
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

  statusFor(cellId: string | null): MasterStatus {
    const master = this.settings.get().master;
    const cell = cellId === null ? null : this.cells.get(cellId);
    const key = cellId ?? '';
    const timer = this.timers.get(key);
    const last = this.service.lastFor(cellId);
    return {
      enabled: master.enabled && (cellId === null || cell?.masterEnabled === true),
      intervalMinutes: cell?.masterIntervalMinutes ?? master.intervalMinutes,
      running: this.active.has(key),
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
