import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dir, file, modeOf, silenceConsole } from './repair-fixtures.js';
import { tmpDir } from './tmp.js';
import { formatMode } from '../src/maintenance/permission-repair.js';
import { repairPermissions } from '../src/maintenance/repair-permissions.js';
import { main, parseArgs, usage } from '../src/maintenance/repair-permissions-cli.js';

const posixIt = it.skipIf(process.platform === 'win32');

interface Fixture {
  data: string;
  requests: string;
}

function workspace(): Fixture {
  const data = tmpDir('repair');
  const requests = path.join(data, 'requests');
  dir(requests);
  dir(path.join(data, 'plugins'));
  file(path.join(data, 'db.sqlite'));
  return { data, requests };
}

function session(requests: string, id: string): string {
  const target = path.join(requests, id);
  dir(target);
  dir(path.join(target, 'cwd'));
  dir(path.join(target, 'cwd', 'repo'));
  file(path.join(target, 'cwd', 'repo', 'README.md'), 0o644, 'readme\n');
  dir(path.join(target, 'cwd', 'repo', 'src'));
  dir(path.join(target, 'opencode'));
  file(path.join(target, 'opencode', 'opencode.json'));
  file(path.join(target, 'session.json'), 0o644, '{"sessionId":"s"}');
  file(path.join(target, 'transcript.json'), 0o644, '[]');
  file(path.join(target, 'mcp-config.json'), 0o644, '{}');
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('repair-permissions args', () => {
  it('defaults to a dry run and parses every flag', () => {
    expect(parseArgs([])).toEqual({ apply: false, dataDir: null, help: false });
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--apply', '--dry-run']).apply).toBe(false);
    expect(parseArgs(['--dry-run', '--apply']).apply).toBe(true);
    expect(parseArgs(['--data-dir', 'relative']).dataDir).toBe(path.resolve('relative'));
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects unknown or incomplete arguments and documents the command', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument: --nope');
    expect(() => parseArgs(['--data-dir'])).toThrow('--data-dir needs a directory');
    expect(() => parseArgs(['--data-dir', '--apply'])).toThrow(
      '--data-dir needs a directory',
    );
    expect(usage()).toContain('--apply');
    expect(usage()).toContain('--data-dir DIR');
    expect(usage()).toContain('never recurses into cwd/');
  });

  it('renders modes as four octal digits', () => {
    expect(formatMode(0o700)).toBe('0700');
    expect(formatMode(0o755)).toBe('0755');
    expect(formatMode(0o600)).toBe('0600');
  });
});

describe('repair-permissions dry run', () => {
  posixIt('reports pending changes without touching any mode', () => {
    const fixture = workspace();
    const first = session(fixture.requests, 'a');
    const second = session(fixture.requests, 'b');
    const reserved = session(fixture.requests, '__master__:cell');

    const result = repairPermissions(fixture.data, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.tightened).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    expect(result.entries.some((entry) => entry.action === 'tighten')).toBe(true);
    for (const target of [fixture.requests, first, second, reserved]) {
      expect(modeOf(target)).toBe(0o755);
    }
    expect(modeOf(path.join(first, 'session.json'))).toBe(0o644);
    expect(modeOf(path.join(first, 'transcript.json'))).toBe(0o644);
    expect(modeOf(path.join(first, 'cwd'))).toBe(0o755);
    expect(modeOf(path.join(first, 'opencode'))).toBe(0o755);
    expect(modeOf(path.join(first, 'opencode', 'opencode.json'))).toBe(0o644);
  });

  it('prints a preview and exits 0', () => {
    const fixture = workspace();
    session(fixture.requests, 'a');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    expect(main(['--data-dir', fixture.data])).toBe(0);
    expect(lines.some((line) => line.includes('would chmod 0700'))).toBe(true);
    expect(lines.some((line) => line.includes('pending'))).toBe(true);
    expect(lines.some((line) => line.includes('Re-run with --apply'))).toBe(true);
  });
});

describe('repair-permissions apply', () => {
  posixIt('applies the exact owner-only modes to every known artifact', () => {
    const fixture = workspace();
    const first = session(fixture.requests, 'a');
    const second = session(fixture.requests, 'b');
    const master = session(fixture.requests, '__master__:cell');
    const setup = session(fixture.requests, '__setup__:draft');
    const summary = session(fixture.requests, '__summary__:cell');
    silenceConsole();

    expect(main(['--data-dir', fixture.data, '--apply'])).toBe(0);

    expect(modeOf(fixture.requests)).toBe(0o700);
    for (const target of [first, second, master, setup, summary]) {
      expect(modeOf(target)).toBe(0o700);
      expect(modeOf(path.join(target, 'cwd'))).toBe(0o700);
      expect(modeOf(path.join(target, 'opencode'))).toBe(0o700);
      expect(modeOf(path.join(target, 'session.json'))).toBe(0o600);
      expect(modeOf(path.join(target, 'transcript.json'))).toBe(0o600);
      expect(modeOf(path.join(target, 'mcp-config.json'))).toBe(0o600);
      expect(modeOf(path.join(target, 'opencode', 'opencode.json'))).toBe(0o600);
    }

    // The command must not recurse into cwd/ or touch siblings.
    expect(modeOf(path.join(first, 'cwd', 'repo', 'README.md'))).toBe(0o644);
    expect(modeOf(path.join(first, 'cwd', 'repo', 'src'))).toBe(0o755);
    expect(modeOf(path.join(fixture.data, 'plugins'))).toBe(0o755);
    expect(modeOf(path.join(fixture.data, 'db.sqlite'))).toBe(0o644);
  });

  posixIt('normalizes a looser mode to the exact owner-only mode', () => {
    const fixture = workspace();
    const target = session(fixture.requests, 'a');
    chmodSync(target, 0o750);
    chmodSync(path.join(target, 'session.json'), 0o640);
    silenceConsole();

    expect(main(['--data-dir', fixture.data, '--apply'])).toBe(0);

    expect(modeOf(target)).toBe(0o700);
    expect(modeOf(path.join(target, 'session.json'))).toBe(0o600);
  });

  posixIt('is idempotent and does not chmod already-private entries', () => {
    const fixture = workspace();
    session(fixture.requests, 'a');
    silenceConsole();
    expect(main(['--data-dir', fixture.data, '--apply'])).toBe(0);

    let calls = 0;
    const result = repairPermissions(fixture.data, {
      apply: true,
      chmod: () => {
        calls += 1;
      },
    });

    expect(result.tightened).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls).toBe(0);
  });

  posixIt('skips symlinked files and session directories without following them', () => {
    const fixture = workspace();
    const target = session(fixture.requests, 'a');
    const outsideFile = path.join(fixture.data, 'outside.json');
    file(outsideFile);
    unlinkSync(path.join(target, 'session.json'));
    symlinkSync(outsideFile, path.join(target, 'session.json'));

    const outsideDir = path.join(fixture.data, 'outside-dir');
    dir(outsideDir);
    symlinkSync(outsideDir, path.join(fixture.requests, 'b'));

    const result = repairPermissions(fixture.data, { apply: true });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(modeOf(outsideFile)).toBe(0o644);
    expect(modeOf(outsideDir)).toBe(0o755);
    expect(modeOf(target)).toBe(0o700);
  });
});

describe('repair-permissions edge cases', () => {
  it('reports a missing requests tree as nothing to repair', () => {
    const data = tmpDir('repair-missing');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const result = repairPermissions(data, { apply: false });

    expect(result.rootMissing).toBe(true);
    expect(result.entries).toEqual([]);
    expect(main(['--data-dir', data])).toBe(0);
    expect(lines.some((line) => line.includes('nothing to repair'))).toBe(true);
    expect(existsSync(path.join(data, 'requests'))).toBe(false);
  });

  it('fails when requests is not a directory', () => {
    const data = tmpDir('repair-file');
    file(path.join(data, 'requests'));
    silenceConsole();

    const result = repairPermissions(data, { apply: false });

    expect(result.rootMissing).toBe(false);
    expect(result.failed).toBe(1);
    expect(main(['--data-dir', data])).toBe(1);
  });

  posixIt('refuses a symlinked requests root without chmodding or descending', () => {
    const data = tmpDir('repair-symlink-root');
    const outside = path.join(data, 'outside');
    dir(outside);
    const requests = path.join(data, 'requests');
    symlinkSync(outside, requests, 'dir');

    const dry = repairPermissions(data, { apply: false });
    expect(dry.rootMissing).toBe(false);
    expect(dry.failed).toBe(1);
    expect(dry.tightened).toBe(0);
    expect(dry.entries).toEqual([
      {
        path: requests,
        kind: 'dir',
        mode: null,
        target: 0o700,
        action: 'error',
        detail: 'is a symbolic link',
      },
    ]);
    expect(modeOf(outside)).toBe(0o755);

    let calls = 0;
    const applied = repairPermissions(data, {
      apply: true,
      chmod: () => {
        calls += 1;
      },
    });
    expect(applied.failed).toBe(1);
    expect(calls).toBe(0);
    expect(modeOf(outside)).toBe(0o755);
    expect(lstatSync(requests).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);

    const errors: string[] = [];
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    expect(main(['--data-dir', data, '--apply'])).toBe(1);
    expect(errors.some((line) => line.includes('is a symbolic link'))).toBe(true);
    expect(lines.some((line) => line.includes('1 error(s)'))).toBe(true);
    expect(modeOf(outside)).toBe(0o755);
  });

  posixIt('continues after a chmod failure and exits 1', () => {
    const fixture = workspace();
    const first = session(fixture.requests, 'a');
    const second = session(fixture.requests, 'b');
    const denied = path.join(first, 'session.json');
    const chmod = (target: string, mode: number): void => {
      if (target === denied) throw new Error('EACCES: permission denied');
      chmodSync(target, mode);
    };

    const result = repairPermissions(fixture.data, { apply: true, chmod });

    expect(result.failed).toBe(1);
    expect(modeOf(denied)).toBe(0o644);
    expect(modeOf(path.join(second, 'session.json'))).toBe(0o600);
    silenceConsole();
    expect(main(['--data-dir', fixture.data, '--apply'], { chmod })).toBe(1);
  });

  posixIt('treats a vanished entry as a skip, not a failure', () => {
    const fixture = workspace();
    session(fixture.requests, 'a');
    const chmod = (): void => {
      const error = new Error('gone') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    };

    const result = repairPermissions(fixture.data, { apply: true, chmod });

    expect(result.failed).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    silenceConsole();
    expect(main(['--data-dir', fixture.data, '--apply'], { chmod })).toBe(0);
  });
});

describe('repair-permissions shared engine', () => {
  const maintenanceDir = path.resolve(
    fileURLToPath(new URL('../src/maintenance/', import.meta.url)),
  );

  function source(file: string): string {
    return readFileSync(path.join(maintenanceDir, file), 'utf8');
  }

  it('keeps chmod and the repair CLI core in the shared modules', () => {
    const files = readdirSync(maintenanceDir).filter((file) => file.endsWith('.ts'));
    const chmodOwners = files.filter(
      (file) => file !== 'permission-repair.ts' && source(file).includes('chmodSync'),
    );
    expect(chmodOwners).toEqual([]);

    for (const engine of [
      'repair-permissions.ts',
      'repair-upgrade-permissions.ts',
      'repair-run-permissions.ts',
    ]) {
      expect(source(engine)).toContain('new PermissionRepair(');
    }

    for (const cli of [
      'repair-permissions-cli.ts',
      'repair-upgrade-permissions-cli.ts',
      'repair-run-permissions-cli.ts',
    ]) {
      expect(source(cli)).toContain("from './repair-cli.js'");
    }
  });
});
