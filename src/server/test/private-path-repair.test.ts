import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpDir } from './tmp.js';
import {
  repairPrivateTree,
  type RepairPolicy,
} from '../src/maintenance/private-path-repair.js';

const mockState = vi.hoisted(() => ({ vanishPath: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((target: string) => {
    if (mockState.vanishPath !== null && target === mockState.vanishPath) {
      const error = new Error('gone') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return actual.lstatSync(target);
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync };
});

const posixIt = it.skipIf(process.platform === 'win32');

afterEach(() => {
  mockState.vanishPath = null;
});

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

function dir(target: string, mode = 0o755): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, mode);
}

const CHILD_POLICY: RepairPolicy['child'] = { kind: 'dir', missing: 'silent' };

describe('private-path repair policy seam', () => {
  it('reports a missing root without creating it', () => {
    const root = path.join(tmpDir('private-path-missing'), 'root');

    for (const rootSymlinks of ['follow', 'reject'] as const) {
      const result = repairPrivateTree(
        root,
        { rootSymlinks, child: CHILD_POLICY },
        { apply: true },
      );

      expect(result.rootMissing).toBe(true);
      expect(result.entries).toEqual([]);
      expect(result.tightened).toBe(0);
      expect(result.private).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(existsSync(root)).toBe(false);
    }
  });

  posixIt('rejects a symlinked root when the policy says reject', () => {
    const base = tmpDir('private-path-reject');
    const outside = path.join(base, 'outside');
    dir(outside);
    const root = path.join(base, 'root');
    symlinkSync(outside, root, 'dir');

    let calls = 0;
    const result = repairPrivateTree(
      root,
      { rootSymlinks: 'reject', child: CHILD_POLICY },
      {
        apply: true,
        chmod: () => {
          calls += 1;
        },
      },
    );

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.entries).toEqual([
      {
        path: root,
        kind: 'dir',
        mode: null,
        target: 0o700,
        action: 'error',
        detail: 'is a symbolic link',
      },
    ]);
    expect(calls).toBe(0);
    expect(modeOf(outside)).toBe(0o755);
  });

  posixIt('follows a symlinked root when the policy says follow', () => {
    const base = tmpDir('private-path-follow');
    const outside = path.join(base, 'outside');
    dir(outside);
    const root = path.join(base, 'root');
    symlinkSync(outside, root, 'dir');

    // D121 preserves D74's statSync root behavior; this test guards the seam
    // until follow-up e182d9b9-2bb9-4829-8cdd-0e445c7932e6 changes it.
    const result = repairPrivateTree(
      root,
      { rootSymlinks: 'follow', child: CHILD_POLICY },
      { apply: true },
    );

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(0);
    expect(result.tightened).toBe(1);
    expect(result.entries).toMatchObject([
      { path: root, kind: 'dir', action: 'tighten', target: 0o700 },
    ]);
    expect(modeOf(outside)).toBe(0o700);
  });

  it('applies the silent and skip policies to a vanished direct child', () => {
    const root = path.join(tmpDir('private-path-child'), 'root');
    dir(root, 0o700);
    const missing = path.join(root, 'gone');
    dir(missing);
    mockState.vanishPath = missing;

    const silent = repairPrivateTree(
      root,
      { rootSymlinks: 'reject', child: { kind: 'dir', missing: 'silent' } },
      { apply: true },
    );
    expect(silent.entries).toEqual([
      { path: root, kind: 'dir', mode: 0o700, target: 0o700, action: 'private' },
    ]);
    expect(silent.private).toBe(1);
    expect(silent.skipped).toBe(0);

    const skipped = repairPrivateTree(
      root,
      { rootSymlinks: 'reject', child: { kind: 'dir', missing: 'skip' } },
      { apply: true },
    );
    expect(skipped.entries).toEqual([
      { path: root, kind: 'dir', mode: 0o700, target: 0o700, action: 'private' },
      {
        path: missing,
        kind: 'dir',
        mode: null,
        target: 0o700,
        action: 'skip',
        detail: 'vanished',
      },
    ]);
    expect(skipped.skipped).toBe(1);
  });
});
