import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRAIN_LOCK_FILE,
  BRAIN_LOCK_INTERVAL_MS,
  BrainLock,
  type BrainLockFs,
} from '../src/brain-lock.js';
import type { ErrorSink } from '../src/logging/errors.js';

const NOW = Date.UTC(2026, 0, 31, 12);

afterEach(() => {
  vi.useRealTimers();
});

function read(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function fakeSink() {
  return { error: vi.fn() } satisfies ErrorSink;
}

describe('BrainLock', () => {
  it('creates the data dir and writes an atomic heartbeat with the configured identity', () => {
    const dataDir = path.join(tmpDir('brain-lock'), 'missing', 'data');
    const lock = new BrainLock({
      dataDir,
      port: 7391,
      host: 'brain-host',
      now: () => NOW,
    });

    try {
      lock.start();

      const file = path.join(dataDir, BRAIN_LOCK_FILE);
      expect(existsSync(dataDir)).toBe(true);
      expect(read(file)).toEqual({
        version: 1,
        pid: process.pid,
        host: 'brain-host',
        port: 7391,
        startedAt: new Date(NOW).toISOString(),
        heartbeatAt: new Date(NOW).toISOString(),
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(dataDir, `.${BRAIN_LOCK_FILE}.${process.pid}.tmp`))).toBe(
        false,
      );
    } finally {
      lock.stop();
    }
  });

  it('refreshes heartbeatAt on the interval and keeps startedAt fixed', () => {
    vi.useFakeTimers();
    let now = NOW;
    const dataDir = tmpDir('brain-lock');
    const lock = new BrainLock({
      dataDir,
      port: 7000,
      host: 'brain-host',
      intervalMs: BRAIN_LOCK_INTERVAL_MS,
      now: () => now,
    });
    const file = path.join(dataDir, BRAIN_LOCK_FILE);

    try {
      lock.start();
      const first = read(file);

      now += BRAIN_LOCK_INTERVAL_MS;
      vi.advanceTimersByTime(BRAIN_LOCK_INTERVAL_MS);
      const second = read(file);

      expect(second.startedAt).toBe(first.startedAt);
      expect(second.heartbeatAt).toBe(new Date(now).toISOString());
      expect(second.heartbeatAt).not.toBe(first.heartbeatAt);
    } finally {
      lock.stop();
    }
  });

  it('removes the file on stop and tolerates a repeated stop', () => {
    const dataDir = tmpDir('brain-lock');
    const lock = new BrainLock({ dataDir, port: 7391, host: 'brain-host' });

    lock.start();
    const file = path.join(dataDir, BRAIN_LOCK_FILE);
    expect(existsSync(file)).toBe(true);

    lock.stop();
    expect(existsSync(file)).toBe(false);
    expect(() => lock.stop()).not.toThrow();
  });

  it('logs only the first failure of an episode and logs again after a recovery', () => {
    vi.useFakeTimers();
    const errors = fakeSink();
    let fail = true;
    const fs: BrainLockFs = {
      mkdir: () => {},
      write: () => {
        if (fail) throw new Error('ENOSPC');
      },
      rename: () => {},
      unlink: () => {},
    };
    const lock = new BrainLock({
      dataDir: '/virtual/data',
      port: 7391,
      host: 'brain-host',
      intervalMs: 1000,
      errors,
      fs,
    });

    lock.start();
    expect(errors.error).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(errors.error).toHaveBeenCalledTimes(1);

    fail = false;
    vi.advanceTimersByTime(1000);
    fail = true;
    vi.advanceTimersByTime(1000);
    expect(errors.error).toHaveBeenCalledTimes(2);
    expect(errors.error).toHaveBeenLastCalledWith(
      'brain.lock',
      expect.any(Error),
      { path: path.join('/virtual/data', BRAIN_LOCK_FILE) },
    );

    lock.stop();
  });

  it('reports a forced write failure without throwing', () => {
    const root = tmpDir('brain-lock');
    const blocker = path.join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const errors = fakeSink();
    const dataDir = path.join(blocker, 'data');
    const lock = new BrainLock({ dataDir, port: 7391, host: 'brain-host', errors });

    expect(() => lock.start()).not.toThrow();
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith('brain.lock', expect.any(Error), {
      path: path.join(dataDir, BRAIN_LOCK_FILE),
    });

    lock.stop();
  });

  it('reports a removal failure without throwing', () => {
    const errors = fakeSink();
    const fs: BrainLockFs = {
      mkdir: () => {},
      write: () => {},
      rename: () => {},
      unlink: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    };
    const lock = new BrainLock({
      dataDir: '/virtual/data',
      port: 7391,
      host: 'brain-host',
      errors,
      fs,
    });

    lock.start();
    expect(() => lock.stop()).not.toThrow();
    expect(errors.error).toHaveBeenCalledWith('brain.lock', expect.any(Error), {
      path: path.join('/virtual/data', BRAIN_LOCK_FILE),
    });
  });
});
