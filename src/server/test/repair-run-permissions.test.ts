import {
  chmodSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpDir } from './tmp.js';
import { repairRunPermissions } from '../src/maintenance/repair-run-permissions.js';
import { main, parseArgs, usage } from '../src/maintenance/repair-run-permissions-cli.js';

const posixIt = it.skipIf(process.platform === 'win32');

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

function dir(target: string, mode = 0o755): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, mode);
}

function file(target: string, mode = 0o644, body = '{}'): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  chmodSync(target, mode);
}

interface Fixture {
  root: string;
  runs: string;
  upgrades: string;
  loose: string;
  privateRun: string;
  emptyRun: string;
  manualRun: string;
  outside: string;
  notes: string;
  upgradeRun: string;
}

function workspace(): Fixture {
  const root = tmpDir('repair-runs');
  chmodSync(root, 0o755);

  const upgrades = path.join(root, 'upgrades');
  dir(upgrades);
  const upgradeRun = path.join(upgrades, '20260101T000000Z');
  dir(upgradeRun);
  file(path.join(upgradeRun, 'db-backup.sqlite'), 0o644, 'sqlite-bytes\n');

  const runs = path.join(root, 'runs');
  dir(runs);

  const loose = path.join(runs, '20260101T000000Z');
  dir(loose);
  file(path.join(loose, 'cutover.log'), 0o644, 'log\n');
  file(path.join(loose, 'config-before.json'), 0o644, '{"before":true}\n');
  file(path.join(loose, 'config-after.json'), 0o644, '{"after":true}\n');
  file(path.join(loose, 'errors.log.before'), 0o644, 'errors\n');
  file(path.join(loose, 'state'), 0o644, 'success\n');
  file(path.join(loose, 'dist', 'server', 'app.js'), 0o644, '// built\n');
  file(path.join(loose, 'backup', 'systemd', 'unit'), 0o644, '[Unit]\n');

  const privateRun = path.join(runs, '20260102T000000Z');
  dir(privateRun, 0o700);
  file(path.join(privateRun, 'cutover.log'), 0o644, 'private log\n');

  const emptyRun = path.join(runs, '20260103T000000Z');
  dir(emptyRun);

  const manualRun = path.join(runs, 'manual-backup');
  dir(manualRun);

  const outside = path.join(root, 'outside-run');
  dir(outside);
  symlinkSync(outside, path.join(runs, 'linked-run'), 'dir');
  const notes = path.join(runs, 'notes.txt');
  file(notes);
  symlinkSync(loose, path.join(root, 'latest'), 'dir');

  return { root, runs, upgrades, loose, privateRun, emptyRun, manualRun, outside, notes, upgradeRun };
}

function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('repair-run-permissions args', () => {
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
    expect(usage()).toContain('runs');
    expect(usage()).toContain('root');
    expect(usage()).toContain('upgrades/');
    expect(usage()).toContain('never follows symlinks');
    expect(usage()).toContain('one level deep');
  });
});

describe('repair-run-permissions preview', () => {
  posixIt('reports pending changes without touching any mode', () => {
    const fixture = workspace();

    const result = repairRunPermissions(fixture.root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.runsMissing).toBe(false);
    expect(result.tightened).toBe(5);
    expect(result.private).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);

    expect(modeOf(fixture.root)).toBe(0o755);
    expect(modeOf(fixture.runs)).toBe(0o755);
    expect(modeOf(fixture.loose)).toBe(0o755);
    expect(modeOf(fixture.privateRun)).toBe(0o700);
    expect(modeOf(fixture.emptyRun)).toBe(0o755);
    expect(modeOf(fixture.manualRun)).toBe(0o755);
    expect(modeOf(path.join(fixture.loose, 'cutover.log'))).toBe(0o644);
    expect(modeOf(path.join(fixture.loose, 'dist'))).toBe(0o755);
    expect(modeOf(path.join(fixture.loose, 'backup', 'systemd'))).toBe(0o755);
  });

  posixIt('prints a preview and exits 0', () => {
    const fixture = workspace();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    expect(main(['--root', fixture.root])).toBe(0);
    expect(lines.some((line) => line.includes('would chmod 0700'))).toBe(true);
    expect(
      lines.some(
        (line) => line.includes('would chmod 0700') && line.includes(fixture.root),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes('pending'))).toBe(true);
    expect(lines.some((line) => line.includes('Re-run with --apply'))).toBe(true);
  });
});

describe('repair-run-permissions apply', () => {
  posixIt('applies owner-only modes without touching files, ancestors, or upgrades', () => {
    const fixture = workspace();
    silenceConsole();

    expect(main(['--root', fixture.root, '--apply'])).toBe(0);

    expect(modeOf(fixture.root)).toBe(0o700);
    expect(modeOf(fixture.runs)).toBe(0o700);
    expect(modeOf(fixture.loose)).toBe(0o700);
    expect(modeOf(fixture.privateRun)).toBe(0o700);
    expect(modeOf(fixture.emptyRun)).toBe(0o700);
    expect(modeOf(fixture.manualRun)).toBe(0o700);

    // Directory-level protection is the guarantee; run contents keep their modes.
    expect(modeOf(path.join(fixture.loose, 'cutover.log'))).toBe(0o644);
    expect(modeOf(path.join(fixture.loose, 'config-before.json'))).toBe(0o644);
    expect(modeOf(path.join(fixture.loose, 'state'))).toBe(0o644);
    expect(modeOf(path.join(fixture.loose, 'dist'))).toBe(0o755);
    expect(modeOf(path.join(fixture.loose, 'dist', 'server'))).toBe(0o755);
    expect(modeOf(path.join(fixture.loose, 'dist', 'server', 'app.js'))).toBe(0o644);
    expect(modeOf(path.join(fixture.loose, 'backup'))).toBe(0o755);
    expect(modeOf(path.join(fixture.loose, 'backup', 'systemd'))).toBe(0o755);
    expect(modeOf(path.join(fixture.loose, 'backup', 'systemd', 'unit'))).toBe(0o644);
    expect(modeOf(fixture.notes)).toBe(0o644);

    // The latest symlink and the upgrade tree stay out of scope.
    expect(modeOf(fixture.upgrades)).toBe(0o755);
    expect(modeOf(fixture.upgradeRun)).toBe(0o755);
    expect(modeOf(path.join(fixture.upgradeRun, 'db-backup.sqlite'))).toBe(0o644);
    expect(existsSync(path.join(fixture.root, 'latest'))).toBe(true);
    expect(readlinkSync(path.join(fixture.root, 'latest'))).toBe(fixture.loose);
    expect(modeOf(fixture.outside)).toBe(0o755);
  });

  posixIt('is idempotent and does not chmod already-private entries', () => {
    const fixture = workspace();
    silenceConsole();
    expect(main(['--root', fixture.root, '--apply'])).toBe(0);

    let calls = 0;
    const result = repairRunPermissions(fixture.root, {
      apply: true,
      chmod: () => {
        calls += 1;
      },
    });

    expect(result.tightened).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.private).toBe(6);
    expect(result.skipped).toBe(2);
    expect(calls).toBe(0);
  });

  posixIt('skips symlinked run directories without following them', () => {
    const fixture = workspace();
    silenceConsole();

    const result = repairRunPermissions(fixture.root, { apply: true });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(modeOf(fixture.outside)).toBe(0o755);
    expect(modeOf(fixture.root)).toBe(0o700);
    expect(modeOf(fixture.runs)).toBe(0o700);
  });

  posixIt('continues after a chmod failure and exits 1', () => {
    const fixture = workspace();
    const denied = fixture.loose;
    const chmod = (target: string, mode: number): void => {
      if (target === denied) throw new Error('EACCES: permission denied');
      chmodSync(target, mode);
    };

    const result = repairRunPermissions(fixture.root, { apply: true, chmod });

    expect(result.failed).toBe(1);
    expect(modeOf(denied)).toBe(0o755);
    expect(modeOf(fixture.root)).toBe(0o700);
    expect(modeOf(fixture.runs)).toBe(0o700);
    expect(modeOf(fixture.privateRun)).toBe(0o700);
    expect(modeOf(fixture.emptyRun)).toBe(0o700);
    expect(modeOf(fixture.manualRun)).toBe(0o700);

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

    const result = repairRunPermissions(fixture.root, { apply: true, chmod });

    expect(result.failed).toBe(0);
    expect(result.tightened).toBe(0);
    expect(result.private).toBe(1);
    expect(result.skipped).toBe(7);
    expect(modeOf(fixture.root)).toBe(0o755);
    expect(modeOf(fixture.loose)).toBe(0o755);

    silenceConsole();
    expect(main(['--root', fixture.root, '--apply'], { chmod })).toBe(0);
  });
});

describe('repair-run-permissions edge cases', () => {
  it('repairs a loose root when runs is missing and never creates it', () => {
    const root = tmpDir('repair-runs-missing');
    chmodSync(root, 0o755);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const result = repairRunPermissions(root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.runsMissing).toBe(true);
    expect(result.tightened).toBe(1);
    expect(result.private).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ path: root, action: 'tighten' });
    expect(modeOf(root)).toBe(0o755);
    expect(main(['--root', root])).toBe(0);
    expect(lines.some((line) => line.includes('runs directory not found'))).toBe(true);
    expect(
      lines.some((line) => line.includes('would chmod 0700') && line.includes(root)),
    ).toBe(true);
    expect(existsSync(path.join(root, 'runs'))).toBe(false);

    silenceConsole();
    expect(main(['--root', root, '--apply'])).toBe(0);
    expect(modeOf(root)).toBe(0o700);
    expect(existsSync(path.join(root, 'runs'))).toBe(false);
  });

  it('does not create a missing root', () => {
    const root = path.join(tmpDir('repair-runs-absent'), 'absent');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const result = repairRunPermissions(root, { apply: true });

    expect(result.rootMissing).toBe(true);
    expect(result.runsMissing).toBe(true);
    expect(result.entries).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(main(['--root', root, '--apply'])).toBe(0);
    expect(lines.some((line) => line.includes('nothing to tighten'))).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('fails when the root is not a directory', () => {
    const root = path.join(tmpDir('repair-runs-root-file'), 'root');
    file(root);
    silenceConsole();

    const result = repairRunPermissions(root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.entries[0]?.detail).toBe('not a directory');
    expect(main(['--root', root])).toBe(1);
  });

  posixIt('skips a symlinked root without following it', () => {
    const base = tmpDir('repair-runs-root-link');
    const target = path.join(base, 'target');
    const runs = path.join(target, 'runs');
    const run = path.join(runs, '20260101T000000Z');
    dir(target, 0o755);
    dir(runs, 0o755);
    dir(run, 0o755);
    const link = path.join(base, 'root');
    symlinkSync(target, link, 'dir');
    silenceConsole();

    const result = repairRunPermissions(link, { apply: true });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]).toMatchObject({
      path: link,
      action: 'skip',
      detail: 'symlink',
    });
    expect(readlinkSync(link)).toBe(target);
    expect(modeOf(target)).toBe(0o755);
    expect(modeOf(runs)).toBe(0o700);
    expect(modeOf(run)).toBe(0o700);
    expect(main(['--root', link, '--apply'])).toBe(0);
  });

  it('refuses the filesystem root', () => {
    const chmodCalls: Array<[string, number]> = [];
    const chmod = (target: string, mode: number): void => {
      chmodCalls.push([target, mode]);
    };
    silenceConsole();

    const result = repairRunPermissions('/', { apply: true, chmod });

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.entries[0]?.detail).toContain('filesystem root');
    expect(chmodCalls).toEqual([]);
    expect(main(['--root', '/'], { chmod })).toBe(1);
    expect(chmodCalls).toEqual([]);
  });

  it('fails when runs is not a directory', () => {
    const root = tmpDir('repair-runs-file');
    file(path.join(root, 'runs'));
    silenceConsole();

    const result = repairRunPermissions(root, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.runsMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(main(['--root', root])).toBe(1);
  });

  posixIt('refuses a symlinked runs directory without following it', () => {
    const root = tmpDir('repair-runs-link');
    const outside = path.join(root, 'outside');
    dir(outside, 0o755);
    symlinkSync(outside, path.join(root, 'runs'), 'dir');
    silenceConsole();

    const result = repairRunPermissions(root, { apply: true });

    expect(result.rootMissing).toBe(false);
    expect(result.runsMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(modeOf(outside)).toBe(0o755);
    expect(main(['--root', root, '--apply'])).toBe(1);
  });
});

describe('repair-run-permissions root repair', () => {
  posixIt('continues after a root chmod failure and exits 1', () => {
    const fixture = workspace();
    const chmod = (target: string, mode: number): void => {
      if (target === fixture.root) throw new Error('EACCES: permission denied');
      chmodSync(target, mode);
    };

    const result = repairRunPermissions(fixture.root, { apply: true, chmod });

    expect(result.failed).toBe(1);
    expect(modeOf(fixture.root)).toBe(0o755);
    expect(modeOf(fixture.runs)).toBe(0o700);
    expect(modeOf(fixture.loose)).toBe(0o700);

    silenceConsole();
    expect(main(['--root', fixture.root, '--apply'], { chmod })).toBe(1);
  });

  posixIt('treats a vanished root as a skip, not a failure', () => {
    const fixture = workspace();
    const chmod = (target: string, mode: number): void => {
      if (target === fixture.root) {
        const error = new Error('gone') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      chmodSync(target, mode);
    };

    const result = repairRunPermissions(fixture.root, { apply: true, chmod });

    expect(result.failed).toBe(0);
    expect(result.tightened).toBe(4);
    expect(result.private).toBe(1);
    expect(result.skipped).toBe(3);
    expect(modeOf(fixture.root)).toBe(0o755);
    expect(modeOf(fixture.runs)).toBe(0o700);

    silenceConsole();
    expect(main(['--root', fixture.root, '--apply'], { chmod })).toBe(0);
  });
});
