import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/migrate-paths.mjs', import.meta.url));

interface RunOptions {
  active?: string[];
  systemctl?: boolean;
}

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-migrate-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'repo');
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const emptyBin = path.join(root, 'empty-bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(emptyBin, { recursive: true });
  writeSystemctl(bin);
  return { root, home, cwd, configHome, stateHome, bin, emptyBin };
}

function writeSystemctl(bin: string): void {
  const file = path.join(bin, 'systemctl');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      'scope=system',
      'if [ "$1" = "--user" ]; then scope=user; shift; fi',
      'for last; do :; done',
      'for entry in $SYSTEMCTL_ACTIVE; do',
      '  if [ "$entry" = "$scope:$last" ]; then exit 0; fi',
      'done',
      'exit 3',
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
}

function run(
  paths: ReturnType<typeof workspace>,
  args: string[] = [],
  options: RunOptions = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, '--home', paths.home, '--cwd', paths.cwd, ...args], {
    cwd: paths.root,
    env: {
      PATH: options.systemctl === false ? paths.emptyBin : paths.bin,
      HOME: paths.home,
      XDG_CONFIG_HOME: paths.configHome,
      XDG_STATE_HOME: paths.stateHome,
      SYSTEMCTL_ACTIVE: (options.active ?? []).join(' '),
    },
    encoding: 'utf8',
  });
}

function write(file: string, body = 'x'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function seedLegacy(paths: ReturnType<typeof workspace>) {
  const data = path.join(paths.home, '.sandbox-harness');
  const config = path.join(paths.configHome, 'sandbox-harness');
  const state = path.join(paths.stateHome, 'sandbox-harness');
  write(path.join(data, 'requests', 'req-1', 'session.json'), '{"sessionId":"s1"}');
  write(path.join(config, 'config.json'), '{"master":{}}');
  write(path.join(config, 'process.json'), '{"version":1}');
  write(path.join(state, 'errors.log'), '{"source":"old"}\n');
  const db = path.join(paths.cwd, 'sandbox-harness.sqlite');
  write(db, 'db');
  write(`${db}-wal`, 'wal');
  write(`${db}-shm`, 'shm');
  return { data, config, state, db };
}

describe('migrate-paths script', () => {
  it('reports planned moves without changing anything in dry-run mode', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('would move data directory');
    expect(result.stdout).toContain('would move config directory');
    expect(result.stdout).toContain('would move state directory');
    expect(result.stdout).toContain('would move database');
    expect(result.stdout).toContain('would move database-wal');
    expect(result.stdout).toContain('would move database-shm');
    expect(result.stdout).toContain('dry run: no files were changed');
    expect(existsSync(legacy.data)).toBe(true);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
  });

  it('moves every default location, including SQLite sidecars', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('migration complete');
    expect(existsSync(legacy.data)).toBe(false);
    expect(existsSync(legacy.config)).toBe(false);
    expect(existsSync(legacy.state)).toBe(false);
    expect(existsSync(legacy.db)).toBe(false);
    expect(
      readFileSync(
        path.join(paths.home, '.agent-process-segments', 'requests', 'req-1', 'session.json'),
        'utf8',
      ),
    ).toContain('s1');
    expect(
      readFileSync(path.join(paths.configHome, 'agent-process-segments', 'config.json'), 'utf8'),
    ).toContain('master');
    expect(
      readFileSync(path.join(paths.stateHome, 'agent-process-segments', 'errors.log'), 'utf8'),
    ).toContain('old');
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-wal'), 'utf8')).toBe(
      'wal',
    );
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-shm'), 'utf8')).toBe(
      'shm',
    );
  });

  it('never overwrites an existing destination', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);
    write(path.join(paths.home, '.agent-process-segments', 'keep.txt'), 'new');

    const result = run(paths);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('skip data directory');
    expect(existsSync(path.join(legacy.data, 'requests', 'req-1', 'session.json'))).toBe(true);
    expect(
      readFileSync(path.join(paths.home, '.agent-process-segments', 'keep.txt'), 'utf8'),
    ).toBe('new');
  });

  it('is a no-op on a second run', () => {
    const paths = workspace();
    seedLegacy(paths);
    expect(run(paths).status).toBe(0);

    const result = run(paths);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to migrate');
  });

  it('refuses to move while the renamed brain unit is active', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, [], { active: ['user:agent-process-segments.service'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent-process-segments.service');
    expect(result.stderr).toContain('--allow-running');
    expect(result.stderr).toContain('systemctl --user stop agent-process-segments.service');
    expect(existsSync(legacy.data)).toBe(true);
    expect(existsSync(legacy.config)).toBe(true);
    expect(existsSync(legacy.state)).toBe(true);
    expect(existsSync(legacy.db)).toBe(true);
    expect(existsSync(`${legacy.db}-wal`)).toBe(true);
    expect(existsSync(`${legacy.db}-shm`)).toBe(true);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
    expect(existsSync(path.join(paths.cwd, 'agent-process-segments.sqlite'))).toBe(false);
  });

  it('refuses to move while the legacy system unit is active', () => {
    const paths = workspace();
    seedLegacy(paths);

    const result = run(paths, [], { active: ['system:sandbox-harness.service'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sandbox-harness.service (system)');
    expect(result.stderr).toContain('sudo systemctl stop sandbox-harness.service');
  });

  it('names both units when both are active', () => {
    const paths = workspace();
    seedLegacy(paths);

    const result = run(paths, [], {
      active: ['user:agent-process-segments.service', 'user:sandbox-harness.service'],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent-process-segments.service (user)');
    expect(result.stderr).toContain('sandbox-harness.service (user)');
  });

  it('warns but still previews in dry-run mode while a unit is active', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--dry-run'], {
      active: ['user:agent-process-segments.service'],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('a real run would refuse');
    expect(result.stdout).toContain('would move data directory');
    expect(result.stdout).toContain('dry run: no files were changed');
    expect(existsSync(legacy.data)).toBe(true);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(false);
  });

  it('warns and previews with --allow-running in dry-run mode', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--dry-run', '--allow-running'], {
      active: ['user:agent-process-segments.service'],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('would move files under a live brain');
    expect(result.stdout).toContain('would move data directory');
    expect(result.stdout).toContain('dry run: no files were changed');
    expect(existsSync(legacy.data)).toBe(true);
  });

  it('moves with --allow-running and warns about corruption', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, ['--allow-running'], {
      active: ['user:agent-process-segments.service'],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('can corrupt the database');
    expect(result.stdout).toContain('migration complete');
    expect(existsSync(legacy.data)).toBe(false);
    expect(existsSync(path.join(paths.home, '.agent-process-segments'))).toBe(true);
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-wal'), 'utf8')).toBe(
      'wal',
    );
    expect(readFileSync(path.join(paths.cwd, 'agent-process-segments.sqlite-shm'), 'utf8')).toBe(
      'shm',
    );
  });

  it('still reports nothing to migrate when a unit is active but there is no legacy data', () => {
    const paths = workspace();

    const result = run(paths, [], { active: ['user:agent-process-segments.service'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to migrate');
    expect(result.stderr).not.toContain('refusing to migrate');
  });

  it('proceeds with a note when systemctl is unavailable', () => {
    const paths = workspace();
    const legacy = seedLegacy(paths);

    const result = run(paths, [], { systemctl: false });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not query systemd');
    expect(result.stdout).toContain('migration complete');
    expect(existsSync(legacy.data)).toBe(false);
  });

  it('documents --allow-running in --help', () => {
    const paths = workspace();

    const result = run(paths, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--allow-running');
    expect(result.stdout).toContain('unsafe');
  });
});
