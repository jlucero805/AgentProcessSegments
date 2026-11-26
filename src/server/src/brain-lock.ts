import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ErrorSink } from './logging/errors.js';

/**
 * Opt-in heartbeat that `scripts/migrate-paths.mjs` can read when the brain's
 * HTTP port is not reachable (a container, another host, or a non-Linux host).
 * The migration script treats a file younger than 60 s as live, so the 10 s
 * beat below leaves room for six missed ticks. Keep the two constants paired.
 */
export const BRAIN_LOCK_FILE = 'brain.lock';
export const BRAIN_LOCK_INTERVAL_MS = 10_000;

/** Narrow fs seam so tests can force a write failure without chmod (root ignores it). */
export interface BrainLockFs {
  mkdir(dataDir: string): void;
  write(file: string, body: string): void;
  rename(from: string, to: string): void;
  unlink(file: string): void;
}

const defaultFs: BrainLockFs = {
  mkdir: (dataDir) => mkdirSync(dataDir, { recursive: true, mode: 0o700 }),
  write: (file, body) => writeFileSync(file, body, { mode: 0o600 }),
  rename: renameSync,
  unlink: unlinkSync,
};

export interface BrainLockOptions {
  dataDir: string;
  port: number;
  host?: string;
  intervalMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  errors?: ErrorSink;
  fs?: BrainLockFs;
}

interface BrainLockBody {
  version: 1;
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  heartbeatAt: string;
}

/**
 * Writes `<dataDir>/brain.lock` at startup and refreshes it every 10 s with an
 * atomic temp-write + rename. The file is advisory: a write or unlink failure
 * is reported once per failure episode and never stops the brain.
 */
export class BrainLock {
  private readonly dataDir: string;
  private readonly port: number;
  private readonly host: string;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly errors?: ErrorSink;
  private readonly fs: BrainLockFs;

  private timer: NodeJS.Timeout | null = null;
  private startedAt = '';
  private failed = false;

  constructor(options: BrainLockOptions) {
    this.dataDir = options.dataDir;
    this.port = options.port;
    this.host = options.host ?? os.hostname();
    this.intervalMs =
      options.intervalMs && options.intervalMs > 0
        ? options.intervalMs
        : BRAIN_LOCK_INTERVAL_MS;
    this.clock = options.now ?? (() => Date.now());
    this.errors = options.errors;
    this.fs = options.fs ?? defaultFs;
  }

  private get target(): string {
    return path.join(this.dataDir, BRAIN_LOCK_FILE);
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.timestamp();
    this.beat();
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.fs.unlink(this.target);
      this.failed = false;
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    }
  }

  private timestamp(): string {
    return new Date(this.clock()).toISOString();
  }

  private beat(): void {
    const body: BrainLockBody = {
      version: 1,
      pid: process.pid,
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
      heartbeatAt: this.timestamp(),
    };
    const temp = path.join(this.dataDir, `.${BRAIN_LOCK_FILE}.${process.pid}.tmp`);
    try {
      this.fs.mkdir(this.dataDir);
      this.fs.write(temp, `${JSON.stringify(body, null, 2)}\n`);
      this.fs.rename(temp, this.target);
      this.failed = false;
    } catch (error) {
      this.cleanup(temp);
      this.report(error);
    }
  }

  private cleanup(temp: string): void {
    try {
      this.fs.unlink(temp);
    } catch {
      // A missing or unremovable temp file must not mask the write failure.
    }
  }

  /** Log only the first failure of an episode; success clears the flag. */
  private report(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.errors?.error('brain.lock', error, { path: this.target });
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
