import { chmodSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';
import { PermissionRepair } from '../src/maintenance/permission-repair.js';

const posixIt = it.skipIf(process.platform === 'win32');

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

function dir(target: string, mode = 0o755): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, mode);
}

describe('PermissionRepair root policy', () => {
  it('reports a missing root for every symlink policy', () => {
    const root = path.join(tmpDir('permission-repair-missing'), 'root');

    for (const symlinks of ['refuse', 'skip'] as const) {
      const scan = new PermissionRepair({ apply: true });

      expect(scan.root(root, { symlinks })).toBe('missing');
      const result = scan.result(true);
      expect(result.rootMissing).toBe(true);
      expect(result.entries).toEqual([]);
      expect(result.tightened).toBe(0);
      expect(result.private).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    }
  });

  posixIt('refuses a symlinked root by default without chmodding it', () => {
    const base = tmpDir('permission-repair-refuse');
    const outside = path.join(base, 'outside');
    dir(outside);
    const root = path.join(base, 'root');
    symlinkSync(outside, root, 'dir');

    let calls = 0;
    const scan = new PermissionRepair({
      apply: true,
      chmod: () => {
        calls += 1;
      },
    });

    expect(scan.root(root)).toBe('failed');
    const result = scan.result(false);
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

  posixIt('skips a symlinked root when configured', () => {
    const base = tmpDir('permission-repair-skip');
    const outside = path.join(base, 'outside');
    dir(outside);
    const root = path.join(base, 'root');
    symlinkSync(outside, root, 'dir');

    const scan = new PermissionRepair({ apply: true });
    expect(scan.root(root, { symlinks: 'skip' })).toBe('ok');

    const result = scan.result(false);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries).toEqual([
      {
        path: root,
        kind: 'dir',
        mode: null,
        target: 0o700,
        action: 'skip',
        detail: 'symlink',
      },
    ]);
    expect(modeOf(outside)).toBe(0o755);
  });
});

describe('PermissionRepair child policy', () => {
  it('distinguishes a silent missing child from a vanished skip', () => {
    const root = path.join(tmpDir('permission-repair-child'), 'root');
    dir(root, 0o700);
    const missing = path.join(root, 'gone');

    const silent = new PermissionRepair({ apply: true });
    expect(silent.dir(missing)).toBe(false);
    expect(silent.result(false).entries).toEqual([]);

    const skipped = new PermissionRepair({ apply: true });
    expect(skipped.dir(missing, { missing: 'skip' })).toBe(false);
    expect(skipped.result(false).entries).toEqual([
      {
        path: missing,
        kind: 'dir',
        mode: null,
        target: 0o700,
        action: 'skip',
        detail: 'vanished',
      },
    ]);
  });
});
