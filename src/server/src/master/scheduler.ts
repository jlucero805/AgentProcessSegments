import type { SettingsStore } from '../settings.js';
import type { MasterService } from './service.js';
import type { MasterResult, MasterStatus } from './types.js';

/** Drives `MasterService.runOnce` on the configured cadence and on demand. */
export class MasterScheduler {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<MasterResult> | null = null;
  private nextRunAt: number | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly service: MasterService,
    private readonly settings: SettingsStore,
  ) {}

  start(): void {
    this.unsubscribe = this.settings.onChange(() => this.schedule());
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async runNow(): Promise<MasterResult> {
    return this.run();
  }

  status(): MasterStatus {
    const master = this.settings.get().master;
    return {
      enabled: master.enabled,
      intervalMinutes: master.intervalMinutes,
      running: this.active !== null,
      nextRunAt: this.nextRunAt,
      lastRunAt: this.service.lastRunAt,
      lastResult: this.service.lastResult,
    };
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;

    const master = this.settings.get().master;
    if (!master.enabled) return;

    const every = master.intervalMinutes * 60_000;
    this.nextRunAt = Date.now() + every;
    this.timer = setInterval(() => {
      this.nextRunAt = Date.now() + every;
      void this.run();
    }, every);
    this.timer.unref?.();
  }

  private run(): Promise<MasterResult> {
    if (this.active) return this.active;
    this.active = this.service.runOnce().finally(() => {
      this.active = null;
    });
    return this.active;
  }
}
