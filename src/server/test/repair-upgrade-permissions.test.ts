import {
  chmodSync,
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dir, file, modeOf, silenceConsole } from './repair-fixtures.js';
import { tmpDir } from './tmp.js';
import {
  repairUpgradePermissions,
} from '../src/maintenance/repair-upgrade-permissions.js';
import { main, parseArgs, usage } from '../src/maintenance/repair-upgrade-permissions-cli.js';

const posixIt = it.skipIf(process.platform === 'win32');

interface Fixture {
  root: string;
  upgrades: string;
  runs: string;
  loose: string;
  privateRun: string;
  withoutSnapshot: string;
  cutoverRun: string;
}

function run(
  upgrades: string,
  name: string,
  dirMode: number,
  snapshotMode: number,
): string {
  const target = path.join(upgrades, name);
  dir(target, dirMode);
  file(path.join(target, 'db-backup.sqlite'), snapshotMode, 'sqlite-bytes\n');
  file(path.join(target, 'upgrade.log'), 0o644, 'log\n');
  return target;
}

function workspace(): Fixture {
  const root = tmpDir('repair-upgrades');
  chmodSync(root, 0o755);
  const upgrades = path.join(root, 'upgrades');
  dir(upgrades);
  const runs = path.join(root, 'runs');
  dir(runs);

  const loose = run(upgrades, '20260101T000000Z', 0o755, 0o644);
  const privateRun = run(upgrades, '20260102T000000Z', 0o700, 0o600);
  const withoutSnapshot = path.join(upgrades, '20260103T000000Z');
  dir(withoutSnapshot);
  symlinkSync(loose, path.join(upgrades, 'latest'), 'dir');
  file(path.join(upgrades, 'notes.txt'));

  const cutoverRun = path.join(runs, '20260101T000000Z');
  dir(cutoverRun);
  file(path.join(cutoverRun, 'cutover.log'));

  return { root, upgrades, runs, loose, privateRun, withoutSnapshot, cutoverRun };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('repair-upgrade-permissions args', () => {
  it('defaults to a preview and parses every flag', () => {
    const defaults = parseArgs([]);
    expect(defaults.apply).toBe(false);
    expect(defaults.root).toBe(path.join(os.homedir(), '.aps-cutover'));
    expect(defaults.help).toBe(false);

    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--apply', '--dry-run']).apply).toBe(false);
    expect(parseArgs(['--dry-run', '--apply']).apply).toBe(true);
    expect(parseArgs(['--root', 'relative']).root).toBe(path.resolve('relative'));
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects unknown or incomplete arguments and documents the command', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument: --nope');
    expect(() => parseArgs(['--root'])).toThrow('--root needs a directory');
    expect(() => parseArgs(['--root', '--apply'])).toThrow('--root needs a directory');

    expect(usage()).toContain('--apply');
    expect(usage()).toContain('--dry-run');
    expect(usage()).toContain('--root DIR');
    expect(usage()).toContain('follows symlinks');
  });
});

describe('repair-upgrade-permissions preview', () => {
  posixIt('reports pending changes without touching any mode', () => {
    const fixture = workspace();

    const result = repairUpgradePermissions(fixture.root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.upgradesMissing).toBe(false);
    expect(result.tightened).toBe(5);
    expect(result.private).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);

    expect(modeOf(fixture.root)).toBe(0o755);
    expect(modeOf(fixture.upgrades)).toBe(0o755);
    expect(modeOf(fixture.loose)).toBe(0o755);
    expect(modeOf(fixture.privateRun)).toBe(0o700);
    expect(modeOf(fixture.withoutSnapshot)).toBe(0o755);
    expect(modeOf(path.join(fixture.loose, 'db-backup.sqlite'))).toBe(0o644);
    expect(modeOf(path.join(fixture.privateRun, 'db-backup.sqlite'))).toBe(0o600);
  });

  posixIt('prints a preview and exits 0', () => {
    const fixture = workspace();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    expect(main(['--root', fixture.root])).toBe(0);
    expect(lines.some((line) => line.includes('would chmod 0700'))).toBe(true);
    expect(lines.some((line) => line.includes('would chmod 0600'))).toBe(true);
    expect(lines.some((line) => line.includes('pending'))).toBe(true);
    expect(lines.some((line) => line.includes('Re-run with --apply'))).toBe(true);
  });
});

describe('repair-upgrade-permissions apply', () => {
  posixIt('applies owner-only modes without touching runs or unrelated files', () => {
    const fixture = workspace();
    silenceConsole();

    expect(main(['--root', fixture.root, '--apply'])).toBe(0);

    expect(modeOf(fixture.root)).toBe(0o700);
    expect(modeOf(fixture.upgrades)).toBe(0o700);
    expect(modeOf(fixture.loose)).toBe(0o700);
    expect(modeOf(fixture.privateRun)).toBe(0o700);
    expect(modeOf(fixture.withoutSnapshot)).toBe(0o700);
    expect(modeOf(path.join(fixture.loose, 'db-backup.sqlite'))).toBe(0o600);
    expect(modeOf(path.join(fixture.privateRun, 'db-backup.sqlite'))).toBe(0o600);

    // Directory-level protection is the guarantee; other files keep their modes.
    expect(modeOf(path.join(fixture.loose, 'upgrade.log'))).toBe(0o644);
    expect(modeOf(path.join(fixture.upgrades, 'notes.txt'))).toBe(0o644);
    expect(readFileSync(path.join(fixture.loose, 'db-backup.sqlite'), 'utf8')).toBe(
      'sqlite-bytes\n',
    );
    expect(realpathSync(path.join(fixture.upgrades, 'latest'))).toBe(realpathSync(fixture.loose));

    // The cutover runs tree, its files, and the latest symlink are out of scope.
    expect(modeOf(fixture.runs)).toBe(0o755);
    expect(modeOf(fixture.cutoverRun)).toBe(0o755);
    expect(modeOf(path.join(fixture.cutoverRun, 'cutover.log'))).toBe(0o644);
  });

  posixIt('is idempotent and does not chmod already-private entries', () => {
    const fixture = workspace();
    silenceConsole();
    expect(main(['--root', fixture.root, '--apply'])).toBe(0);

    let calls = 0;
    const result = repairUpgradePermissions(fixture.root, {
      apply: true,
      chmod: () => {
        calls += 1;
      },
    });

    expect(result.tightened).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.private).toBe(7);
    expect(calls).toBe(0);
  });

  posixIt('skips symlinked run directories and snapshots without following them', () => {
    const fixture = workspace();
    const outsideFile = path.join(fixture.root, 'outside.sqlite');
    file(outsideFile, 0o644, 'outside\n');
    unlinkSync(path.join(fixture.loose, 'db-backup.sqlite'));
    symlinkSync(outsideFile, path.join(fixture.loose, 'db-backup.sqlite'));

    const outsideDir = path.join(fixture.root, 'outside-run');
    dir(outsideDir, 0o755);
    symlinkSync(outsideDir, path.join(fixture.upgrades, 'linked-run'));

    const result = repairUpgradePermissions(fixture.root, { apply: true });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(modeOf(outsideFile)).toBe(0o644);
    expect(modeOf(outsideDir)).toBe(0o755);
    expect(modeOf(fixture.loose)).toBe(0o700);
  });

  posixIt('continues after a chmod failure and exits 1', () => {
    const fixture = workspace();
    const denied = path.join(fixture.loose, 'db-backup.sqlite');
    const chmod = (target: string, mode: number): void => {
      if (target === denied) throw new Error('EACCES: permission denied');
      chmodSync(target, mode);
    };

    const result = repairUpgradePermissions(fixture.root, { apply: true, chmod });

    expect(result.failed).toBe(1);
    expect(modeOf(denied)).toBe(0o644);
    expect(modeOf(fixture.loose)).toBe(0o700);
    expect(modeOf(path.join(fixture.privateRun, 'db-backup.sqlite'))).toBe(0o600);

    silenceConsole();
    expect(main(['--root', fixture.root, '--apply'], { chmod })).toBe(1);
  });

  posixIt('treats a vanished entry as a skip, not a failure', () => {
    const fixture = workspace();
    const chmod = (): void => {
      const error = new Error('gone') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    };

    const result = repairUpgradePermissions(fixture.root, { apply: true, chmod });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(4);
    expect(modeOf(fixture.loose)).toBe(0o755);

    silenceConsole();
    expect(main(['--root', fixture.root, '--apply'], { chmod })).toBe(0);
  });
});

describe('repair-upgrade-permissions edge cases', () => {
  it('repairs a loose root when upgrades is missing and never creates it', () => {
    const root = tmpDir('repair-upgrades-missing');
    chmodSync(root, 0o755);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const result = repairUpgradePermissions(root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.upgradesMissing).toBe(true);
    expect(result.tightened).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ path: root, action: 'tighten' });
    expect(main(['--root', root])).toBe(0);
    expect(lines.some((line) => line.includes('upgrades directory not found'))).toBe(true);
    expect(
      lines.some((line) => line.includes('would chmod 0700') && line.includes(root)),
    ).toBe(true);
    expect(existsSync(path.join(root, 'upgrades'))).toBe(false);

    silenceConsole();
    expect(main(['--root', root, '--apply'])).toBe(0);
    expect(modeOf(root)).toBe(0o700);
    expect(existsSync(path.join(root, 'upgrades'))).toBe(false);
  });

  it('reports a missing cutover root as nothing to tighten', () => {
    const root = path.join(tmpDir('repair-upgrades-absent'), 'absent');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const result = repairUpgradePermissions(root, { apply: true });

    expect(result.rootMissing).toBe(true);
    expect(result.upgradesMissing).toBe(true);
    expect(result.entries).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(main(['--root', root, '--apply'])).toBe(0);
    expect(lines.some((line) => line.includes('nothing to tighten'))).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('fails when the cutover root is not a directory', () => {
    const root = path.join(tmpDir('repair-upgrades-root-file'), 'root');
    file(root);
    silenceConsole();

    const result = repairUpgradePermissions(root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.entries[0]?.detail).toBe('not a directory');
    expect(main(['--root', root])).toBe(1);
  });

  posixIt('skips a symlinked root without following it', () => {
    const base = tmpDir('repair-upgrades-root-link');
    const target = path.join(base, 'target');
    const upgrades = path.join(target, 'upgrades');
    const run = path.join(upgrades, '20260101T000000Z');
    dir(target, 0o755);
    dir(upgrades, 0o755);
    dir(run, 0o755);
    const link = path.join(base, 'root');
    symlinkSync(target, link, 'dir');
    silenceConsole();

    const result = repairUpgradePermissions(link, { apply: true });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]).toMatchObject({ path: link, action: 'skip', detail: 'symlink' });
    expect(readlinkSync(link)).toBe(target);
    expect(modeOf(target)).toBe(0o755);
    expect(modeOf(upgrades)).toBe(0o700);
    expect(modeOf(run)).toBe(0o700);
    expect(main(['--root', link, '--apply'])).toBe(0);
  });

  it('refuses the filesystem root', () => {
    const chmodCalls: Array<[string, number]> = [];
    const chmod = (target: string, mode: number): void => {
      chmodCalls.push([target, mode]);
    };
    silenceConsole();

    const result = repairUpgradePermissions('/', { apply: true, chmod });

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.entries[0]?.detail).toContain('filesystem root');
    expect(chmodCalls).toEqual([]);
    expect(main(['--root', '/'], { chmod })).toBe(1);
    expect(chmodCalls).toEqual([]);
  });

  it('refuses the home directory as --root', () => {
    silenceConsole();
    const chmod = vi.fn();

    expect(main(['--root', os.homedir(), '--apply'], { chmod })).toBe(1);
    expect(chmod).not.toHaveBeenCalled();
  });

  it('fails when upgrades is not a directory', () => {
    const root = tmpDir('repair-upgrades-file');
    file(path.join(root, 'upgrades'));
    silenceConsole();

    const result = repairUpgradePermissions(root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(main(['--root', root])).toBe(1);
  });

  posixIt('refuses a symlinked upgrades directory without following it', () => {
    const root = tmpDir('repair-upgrades-link');
    const outside = path.join(root, 'outside');
    dir(outside, 0o755);
    symlinkSync(outside, path.join(root, 'upgrades'), 'dir');
    silenceConsole();

    const result = repairUpgradePermissions(root, { apply: true });

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(outside)).toBe(0o755);
    expect(main(['--root', root, '--apply'])).toBe(1);
  });
});
