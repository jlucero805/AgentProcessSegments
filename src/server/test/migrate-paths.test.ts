import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/migrate-paths.mjs', import.meta.url));

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-migrate-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'repo');
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd, configHome, stateHome };
}

function run(
  paths: ReturnType<typeof workspace>,
  args: string[] = [],
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, '--home', paths.home, '--cwd', paths.cwd, ...args], {
    cwd: paths.root,
    env: {
      PATH: process.env.PATH,
      HOME: paths.home,
      XDG_CONFIG_HOME: paths.configHome,
      XDG_STATE_HOME: paths.stateHome,
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
});
