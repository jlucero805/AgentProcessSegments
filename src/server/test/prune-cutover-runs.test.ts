import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './tmp.js';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = fileURLToPath(new URL('../../../scripts/prune-cutover-runs.mjs', import.meta.url));

interface Workspace {
  root: string;
  runs: string;
}

function workspace(kind: 'cutover' | 'upgrade' = 'cutover'): Workspace {
  const root = tmpDir(`prune-${kind}`);
  const runs = path.join(root, kind === 'upgrade' ? 'upgrades' : 'runs');
  mkdirSync(runs, { recursive: true });
  return { root, runs };
}

function makeRun(
  runs: string,
  name: string,
  options: { state?: string | null; ageDays?: number } = {},
): string {
  const dir = path.join(runs, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'cutover.log'), 'log\n');
  if (options.state !== null) {
    writeFileSync(path.join(dir, 'state'), `${options.state ?? 'success'}\n`);
  }
  setAge(dir, options.ageDays ?? 0);
  return dir;
}

function setAge(dir: string, days: number): void {
  const seconds = Date.now() / 1000 - days * 86_400;
  utimesSync(dir, seconds, seconds);
}

function list(dir: string): string[] {
  return readdirSync(dir).sort();
}

function run(root: string, args: string[] = [], kind: 'cutover' | 'upgrade' = 'cutover') {
  const kindArgs = kind === 'upgrade' ? ['--kind', 'upgrade'] : [];
  return spawnSync(process.execPath, [script, '--root', root, ...kindArgs, ...args], {
    encoding: 'utf8',
  });
}

function names(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return `202601${day}T000000Z`;
  });
}

describe('prune-cutover-runs script', () => {
  it('maps npm run prune:upgrades to the upgrade layout', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['prune:upgrades']).toBe(
      'node scripts/prune-cutover-runs.mjs --kind upgrade',
    );
    expect(manifest.scripts?.['prune:cutover']).toBe('node scripts/prune-cutover-runs.mjs');
  });

  it('keeps the newest runs and removes the rest', () => {
    const { root, runs } = workspace();
    const dirs = names(12);
    for (const name of dirs) makeRun(runs, name, { state: 'success', ageDays: 40 });

    const result = run(root, ['--keep-runs', '10', '--keep-days', '0']);

    expect(result.status).toBe(0);
    expect(list(runs)).toEqual(dirs.slice(2));
    expect(result.stdout).toContain('2 run directories pruned');
  });

  it('keeps every run modified inside the age window', () => {
    const { root, runs } = workspace();
    const dirs = names(12);
    for (const name of dirs) makeRun(runs, name, { state: 'success' });

    let result = run(root, ['--keep-runs', '2', '--keep-days', '30']);
    expect(result.status).toBe(0);
    expect(list(runs)).toEqual(dirs);

    for (const name of dirs.slice(0, 9)) setAge(path.join(runs, name), 40);
    result = run(root, ['--keep-runs', '2', '--keep-days', '30']);
    expect(result.status).toBe(0);
    expect(list(runs)).toEqual(dirs.slice(9));
    expect(result.stdout).toContain('9 run directories pruned');
  });

  it('never removes the latest target or the only successful run', () => {
    const { root, runs } = workspace();
    const dirs = names(6);
    const [first, second, , , , sixth] = dirs;
    if (first === undefined || second === undefined || sixth === undefined) {
      throw new Error('expected six run directories');
    }
    makeRun(runs, first, { state: 'success', ageDays: 40 });
    for (const name of dirs.slice(1)) makeRun(runs, name, { state: 'failed', ageDays: 40 });
    symlinkSync(path.join(runs, second), path.join(root, 'latest'), 'dir');

    const result = run(root, ['--keep-runs', '1', '--keep-days', '0']);

    expect(result.status).toBe(0);
    expect(list(runs)).toEqual([first, second, sixth]);
    expect(result.stdout).toContain('(latest)');
    expect(result.stdout).toContain('(rollback point)');
  });

  it('keeps upgrade runs by the upgrade layout and terminal states', () => {
    const { root, runs } = workspace('upgrade');
    const dirs = names(6);
    const [first, second, third, fourth, fifth, sixth] = dirs;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined ||
      fifth === undefined ||
      sixth === undefined
    ) {
      throw new Error('expected six run directories');
    }

    makeRun(runs, first, { state: 'success', ageDays: 40 });
    makeRun(runs, second, { state: 'failed', ageDays: 40 });
    makeRun(runs, third, { state: 'rolled_back', ageDays: 2 });
    makeRun(runs, fourth, { state: 'launched', ageDays: 2 });
    makeRun(runs, fifth, { state: 'rolled_back', ageDays: 40 });
    makeRun(runs, sixth, { state: 'failed', ageDays: 40 });
    symlinkSync(path.join(runs, second), path.join(runs, 'latest'), 'dir');

    const result = run(
      root,
      ['--keep-runs', '1', '--keep-days', '0', '--incomplete-grace-days', '7'],
      'upgrade',
    );

    expect(result.status).toBe(0);
    expect(list(runs)).toEqual([first, second, fourth, sixth, 'latest']);
    expect(result.stdout).toContain('(latest)');
    expect(result.stdout).toContain('(rollback point)');
    expect(result.stdout).toContain('incomplete within 7d');
  });

  it('protects upgrades/latest and does not report it as a foreign entry', () => {
    const { root, runs } = workspace('upgrade');
    makeRun(runs, '20260101T000000Z', { state: 'success', ageDays: 40 });
    makeRun(runs, '20260102T000000Z', { state: 'failed', ageDays: 40 });
    symlinkSync(path.join(runs, '20260102T000000Z'), path.join(runs, 'latest'), 'dir');

    const result = run(
      root,
      ['--keep-runs', '0', '--keep-days', '0', '--incomplete-grace-days', '0'],
      'upgrade',
    );

    expect(result.status).toBe(0);
    expect(list(runs)).toEqual(['20260101T000000Z', '20260102T000000Z', 'latest']);
    expect(result.stdout).toContain('(latest)');
    expect(result.stdout).toContain('(rollback point)');
    expect(result.stdout).not.toContain('skip   latest');
  });

  it('scans only the upgrade directory for --kind upgrade', () => {
    const root = tmpDir('prune-upgrade-layout');
    const cutoverRuns = path.join(root, 'runs');
    const upgradeRuns = path.join(root, 'upgrades');
    mkdirSync(cutoverRuns, { recursive: true });
    mkdirSync(upgradeRuns, { recursive: true });
    makeRun(cutoverRuns, '20260101T000000Z', { state: 'failed', ageDays: 40 });
    makeRun(upgradeRuns, '20260102T000000Z', { state: 'failed', ageDays: 40 });

    const result = run(
      root,
      ['--keep-runs', '0', '--keep-days', '0', '--incomplete-grace-days', '0'],
      'upgrade',
    );

    expect(result.status).toBe(0);
    expect(list(cutoverRuns)).toEqual(['20260101T000000Z']);
    expect(list(upgradeRuns)).toEqual([]);
  });

  it('gives incomplete runs a grace window and then removes them', () => {
    const { root, runs } = workspace();
    const older = ['20250101T000000Z', '20250102T000000Z', '20250103T000000Z'];
    const [firstOlder, secondOlder, thirdOlder] = older;
    if (firstOlder === undefined || secondOlder === undefined || thirdOlder === undefined) {
      throw new Error('expected three older run directories');
    }
    makeRun(runs, firstOlder, { state: null, ageDays: 2 });
    makeRun(runs, secondOlder, { state: 'running', ageDays: 2 });
    makeRun(runs, thirdOlder, { state: 'launched', ageDays: 2 });
    const recent = ['20260110T000000Z', '20260111T000000Z', '20260112T000000Z'];
    for (const name of recent) makeRun(runs, name, { state: 'success' });

    let result = run(root, [
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
      '--incomplete-grace-days',
      '7',
    ]);
    expect(result.status).toBe(0);
    expect(list(runs)).toEqual([...older, recent[2]]);
    expect(result.stdout).toContain('incomplete within 7d');

    for (const name of older) setAge(path.join(runs, name), 8);
    result = run(root, [
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
      '--incomplete-grace-days',
      '7',
    ]);
    expect(result.status).toBe(0);
    expect(list(runs)).toEqual([recent[2]]);
  });

  it('ignores foreign entries and a dangling latest link', () => {
    const { root, runs } = workspace();
    makeRun(runs, '20260101T000000Z', { state: 'failed', ageDays: 40 });
    makeRun(runs, '20260102T000000Z', { state: 'failed', ageDays: 40 });
    writeFileSync(path.join(runs, 'README.txt'), 'x');
    mkdirSync(path.join(runs, 'not-a-timestamp'));
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, path.join(runs, '20260201T000000Z'), 'dir');
    symlinkSync(path.join(runs, '20269999T999999Z'), path.join(root, 'latest'), 'dir');

    const result = run(root, ['--keep-runs', '0', '--keep-days', '0', '--incomplete-grace-days', '0']);

    expect(result.status).toBe(0);
    expect(list(runs)).toEqual(['20260201T000000Z', 'README.txt', 'not-a-timestamp']);
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    expect(lstatSync(path.join(root, 'latest')).isSymbolicLink()).toBe(true);
    expect(result.stdout).toContain('2 run directories pruned');
    expect(result.stdout).toContain('skip   README.txt');
    expect(result.stderr).toContain('missing run directory');
  });

  it('changes nothing in dry-run mode', () => {
    const { root, runs } = workspace();
    const dirs = names(5);
    for (const name of dirs) makeRun(runs, name, { state: 'failed', ageDays: 40 });
    const beforeRuns = list(runs);
    const beforeRoot = list(root);

    const result = run(root, ['--keep-runs', '1', '--keep-days', '0', '--dry-run']);

    expect(result.status).toBe(0);
    expect(list(runs)).toEqual(beforeRuns);
    expect(list(root)).toEqual(beforeRoot);
    expect(result.stdout).toContain('prune  20260101T000000Z');
    expect(result.stdout).toContain('4 run directories pruned');
    expect(result.stdout).toContain('(dry run: nothing removed)');
  });

  it('reports usage errors and treats a missing root as empty', () => {
    const { root } = workspace();

    const help = run(root, ['--help']);
    expect(help.status).toBe(0);
    for (const flag of [
      '--dry-run',
      '--kind',
      '--root',
      '--keep-runs',
      '--keep-days',
      '--incomplete-grace-days',
    ]) {
      expect(help.stdout).toContain(flag);
    }

    for (const args of [
      ['--keep-runs', '-1'],
      ['--keep-days', 'abc'],
      ['--kind', 'bogus'],
      ['--bogus'],
    ]) {
      const result = run(root, args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Usage: node scripts/prune-cutover-runs.mjs');
    }

    const missing = path.join(tmpDir('prune-missing'), 'absent');
    const result = spawnSync(process.execPath, [script, '--root', missing], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to prune');
  });

  it('is idempotent across runs', () => {
    const { root, runs } = workspace();
    for (const name of names(8)) makeRun(runs, name, { state: 'failed', ageDays: 40 });

    const first = run(root, ['--keep-runs', '3', '--keep-days', '0']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('5 run directories pruned');
    const remaining = list(runs);

    const second = run(root, ['--keep-runs', '3', '--keep-days', '0']);
    expect(second.status).toBe(0);
    expect(list(runs)).toEqual(remaining);
    expect(second.stdout).toContain('0 run directories pruned');
  });
});
