import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(repoRoot, 'deploy/cutover-vps.sh');

interface Fixture {
  root: string;
  home: string;
  oldClone: string;
  newClone: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function createEnv(home: string, bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    NODE_PATH: path.join(repoRoot, 'node_modules'),
  };
  for (const key of [
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'SBOX_DB',
    'SBOX_DATA_DIR',
    'SBOX_CONFIG',
    'SBOX_PROCESS',
    'SBOX_ERROR_LOG',
    'APS_DB',
    'APS_DATA_DIR',
    'APS_CONFIG',
    'APS_PROCESS',
    'APS_ERROR_LOG',
  ]) {
    delete env[key];
  }
  return env;
}

function writeSystemctlMock(bin: string, activeUnits: string[] = []): void {
  const activeCases = activeUnits.map((unit) => `  *is-active*${unit}*) echo active; exit 0 ;;`);
  writeExecutable(
    path.join(bin, 'systemctl'),
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *show-environment*) exit 0 ;;',
      ...activeCases,
      '  *is-active*) exit 3 ;;',
      '  *is-enabled*) exit 1 ;;',
      '  *show*) echo inactive; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
  );
}

function initCommit(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture'],
    { cwd: dir },
  );
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-cutover-test-'));
  const home = path.join(root, 'home');
  const oldClone = path.join(root, 'oldclone');
  const newClone = path.join(root, 'newclone');
  const bin = path.join(root, 'bin');

  mkdirSync(path.join(home, '.sandbox-harness', 'requests'), { recursive: true });
  mkdirSync(path.join(home, '.config', 'sandbox-harness'), { recursive: true });
  mkdirSync(path.join(home, '.local', 'state', 'sandbox-harness'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(oldClone, { recursive: true });

  writeFileSync(
    path.join(home, '.config', 'sandbox-harness', 'config.json'),
    JSON.stringify({ master: { enabled: true } }),
  );
  writeFileSync(
    path.join(home, '.config', 'sandbox-harness', 'process.json'),
    JSON.stringify({ version: 1, segments: [] }),
  );
  writeFileSync(path.join(home, '.local', 'state', 'sandbox-harness', 'errors.log'), '');

  const db = new Database(path.join(oldClone, 'sandbox-harness.sqlite'));
  db.exec('CREATE TABLE requests (id TEXT PRIMARY KEY)');
  db.close();

  mkdirSync(path.join(oldClone, 'deploy'), { recursive: true });
  mkdirSync(path.join(oldClone, 'scripts'), { recursive: true });
  cpSync(
    path.join(repoRoot, 'deploy/agent-process-segments.service'),
    path.join(oldClone, 'deploy/agent-process-segments.service'),
  );
  cpSync(
    path.join(repoRoot, 'scripts/migrate-paths.mjs'),
    path.join(oldClone, 'scripts/migrate-paths.mjs'),
  );
  writeFileSync(path.join(oldClone, '.gitignore'), 'node_modules/\n');
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(oldClone, 'node_modules'), 'dir');

  initCommit(oldClone);
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  mkdirSync(path.join(unitDir, 'sandbox-harness.service.d'), { recursive: true });
  writeFileSync(
    path.join(unitDir, 'sandbox-harness.service'),
    [
      '[Unit]',
      'Description=Sandbox Harness brain',
      '',
      '[Service]',
      'WorkingDirectory=%h/sandbox-harness',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(unitDir, 'sandbox-harness.service.d', 'harness.conf'),
    [
      '[Service]',
      'Environment=SBOX_HARNESS=opencode',
      `Environment=SBOX_HARNESS_BIN=${path.join(bin, 'opencode')}`,
      '',
    ].join('\n'),
  );

  writeExecutable(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
  writeSystemctlMock(bin);
  writeExecutable(path.join(bin, 'curl'), '#!/bin/sh\nexit 22\n');

  return {
    root,
    home,
    oldClone,
    newClone,
    bin,
    env: createEnv(home, bin),
  };
}

function createMigratedFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-cutover-test-'));
  const home = path.join(root, 'home');
  const oldClone = path.join(root, 'oldclone');
  const newClone = path.join(root, 'newclone');
  const bin = path.join(root, 'bin');

  mkdirSync(path.join(home, '.agent-process-segments', 'requests'), { recursive: true });
  mkdirSync(path.join(home, '.config', 'agent-process-segments'), { recursive: true });
  mkdirSync(path.join(home, '.local', 'state', 'agent-process-segments'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(newClone, { recursive: true });

  writeFileSync(
    path.join(home, '.config', 'agent-process-segments', 'config.json'),
    JSON.stringify({ master: { enabled: true } }),
  );
  writeFileSync(
    path.join(home, '.config', 'agent-process-segments', 'process.json'),
    JSON.stringify({ version: 1, segments: [] }),
  );
  writeFileSync(path.join(home, '.local', 'state', 'agent-process-segments', 'errors.log'), '');

  const db = new Database(path.join(newClone, 'agent-process-segments.sqlite'));
  db.exec('CREATE TABLE requests (id TEXT PRIMARY KEY)');
  db.close();

  mkdirSync(path.join(newClone, 'deploy'), { recursive: true });
  mkdirSync(path.join(newClone, 'scripts'), { recursive: true });
  cpSync(
    path.join(repoRoot, 'deploy/agent-process-segments.service'),
    path.join(newClone, 'deploy/agent-process-segments.service'),
  );
  cpSync(
    path.join(repoRoot, 'scripts/migrate-paths.mjs'),
    path.join(newClone, 'scripts/migrate-paths.mjs'),
  );
  writeFileSync(path.join(newClone, '.gitignore'), 'node_modules/\n');
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(newClone, 'node_modules'), 'dir');
  initCommit(newClone);

  writeExecutable(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
  writeSystemctlMock(bin, ['agent-process-segments']);
  writeExecutable(path.join(bin, 'curl'), '#!/bin/sh\nexit 22\n');

  return {
    root,
    home,
    oldClone,
    newClone,
    bin,
    env: createEnv(home, bin),
  };
}

describe('deploy/cutover-vps.sh', () => {
  it('prints a complete plan without changing the fixture', () => {
    const fixture = createFixture();
    const before = readdirSync(path.join(fixture.home, '.sandbox-harness', 'requests'));
    const result = spawnSync(
      'bash',
      [
        script,
        '--dry-run',
        '--home',
        fixture.home,
        '--old-clone',
        fixture.oldClone,
        '--new-clone',
        fixture.newClone,
      ],
      { encoding: 'utf8', env: fixture.env },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain('would pause master');
    expect(output).toContain('would move the clone');
    expect(output).toContain('would move data directory');
    expect(output).toContain('would repair registered git worktrees');
    expect(output).toContain('would install agent-process-segments');
    expect(output).toContain('dry run complete; nothing was changed');
    expect(existsSync(fixture.newClone)).toBe(false);
    expect(existsSync(path.join(fixture.home, '.agent-process-segments'))).toBe(false);
    expect(existsSync(path.join(fixture.home, '.config', 'agent-process-segments'))).toBe(false);
    expect(readdirSync(path.join(fixture.home, '.sandbox-harness', 'requests'))).toEqual(before);
  });

  it('refuses to split when both the old and new data directories exist', () => {
    const fixture = createFixture();
    mkdirSync(path.join(fixture.home, '.agent-process-segments'), { recursive: true });
    const result = spawnSync(
      'bash',
      [
        script,
        '--dry-run',
        '--home',
        fixture.home,
        '--old-clone',
        fixture.oldClone,
        '--new-clone',
        fixture.newClone,
      ],
      { encoding: 'utf8', env: fixture.env },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('exists at both');
    expect(existsSync(path.join(fixture.home, '.sandbox-harness'))).toBe(true);
  });

  it('exits 0 without changes when the host is already migrated', () => {
    const fixture = createMigratedFixture();
    const config = path.join(fixture.home, '.config', 'agent-process-segments', 'config.json');
    const configBefore = readFileSync(config, 'utf8');
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.newClone,
      encoding: 'utf8',
    }).trim();

    const result = spawnSync(
      'bash',
      [
        script,
        '--home',
        fixture.home,
        '--old-clone',
        fixture.oldClone,
        '--new-clone',
        fixture.newClone,
      ],
      { encoding: 'utf8', env: fixture.env },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain('already migrated');
    expect(output).not.toContain('Refusing to run a live cutover');
    expect(existsSync(fixture.oldClone)).toBe(false);
    expect(existsSync(path.join(fixture.home, '.sandbox-harness'))).toBe(false);
    expect(readFileSync(config, 'utf8')).toBe(configBefore);
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture.newClone,
        encoding: 'utf8',
      }).trim(),
    ).toBe(headBefore);
  });

  it('refuses when the new unit is active but legacy paths remain', () => {
    const fixture = createFixture();
    writeSystemctlMock(fixture.bin, ['agent-process-segments']);
    const result = spawnSync(
      'bash',
      [
        script,
        '--dry-run',
        '--home',
        fixture.home,
        '--old-clone',
        fixture.oldClone,
        '--new-clone',
        fixture.newClone,
      ],
      { encoding: 'utf8', env: fixture.env },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('both sandbox-harness and agent-process-segments are active');
    expect(existsSync(fixture.oldClone)).toBe(true);
  });

  it('shows usage for --help', () => {
    const result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: deploy/cutover-vps.sh');
    expect(result.stdout).toContain('--detach');
    expect(result.stdout).toContain('--allow-busy');
  });
});
