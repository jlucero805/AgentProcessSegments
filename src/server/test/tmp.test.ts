import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpDir, tmpRoot } from './tmp.js';

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const testDir = path.join(repo, 'src', 'server', 'test');
const sweeper = path.join(repo, 'scripts', 'clean-test-tmp.mjs');

function runSweeper(tmpDirPath: string, ...args: string[]): string {
  return execFileSync(process.execPath, [sweeper, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmpDirPath },
  });
}

describe('test temp dirs', () => {
  it('creates fixtures under one per-file root', () => {
    const first = tmpDir('guard-first');
    const second = tmpDir('guard-first');

    expect(path.dirname(first)).toBe(tmpRoot());
    expect(path.dirname(second)).toBe(tmpRoot());
    expect(path.basename(tmpRoot())).toMatch(/^sbox-tests-/);
    expect(first).not.toBe(second);
    expect(path.basename(first)).toMatch(/^guard-first-/);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it('keeps temp-dir creation out of individual test files', () => {
    const needles = ['mkdtemp', ['os', 'tmpdir('].join('.')];
    const files = readdirSync(testDir).filter(
      (name) => name.endsWith('.ts') && name !== 'tmp.ts' && name !== 'tmp.test.ts',
    );

    for (const name of files) {
      const source = readFileSync(path.join(testDir, name), 'utf8');
      for (const needle of needles) {
        expect(source, `${name} should use tmpDir() from test/tmp.ts`).not.toContain(needle);
      }
    }
  });

  it('sweeps stale mkdtemp dirs only, and only with --apply', () => {
    const fixture = tmpDir('sweeper');
    const candidate = path.join(fixture, 'aps-test-AAAAAA');
    mkdirSync(candidate);
    writeFileSync(path.join(candidate, 'payload.txt'), 'inside\n');

    const file = path.join(fixture, 'sbox-test-BBBBBB');
    writeFileSync(file, 'not a directory\n');
    const unrelated = path.join(fixture, 'keep-me');
    mkdirSync(unrelated);

    const target = path.join(fixture, 'target');
    mkdirSync(target);
    const link = path.join(fixture, 'sbox-test-CCCCCC');
    let linked = false;
    try {
      symlinkSync(target, link);
      linked = true;
    } catch {
      // Some filesystems do not allow symlinks for the test user.
    }

    const dryRun = runSweeper(fixture, '--older-than', '0');
    expect(dryRun).toContain(candidate);
    expect(dryRun).toContain('would remove 1');
    expect(existsSync(candidate)).toBe(true);

    const applied = runSweeper(fixture, '--older-than', '0', '--apply');
    expect(applied).toContain('removed 1');
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    if (linked) {
      expect(existsSync(link)).toBe(true);
      expect(existsSync(target)).toBe(true);
    }

    expect(runSweeper(fixture, '--older-than', '0')).toContain('nothing to prune');
  });
});
