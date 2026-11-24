import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(repoRoot, 'deploy/cutover-vps.sh');
const TEST_TIMEOUT = 30_000;
const SCRIPT_TIMEOUT = 25_000;

interface Fixture {
  root: string;
  home: string;
  oldClone: string;
  newClone: string;
  bin: string;
  state: string;
  env: NodeJS.ProcessEnv;
}

interface FixtureOptions {
  oldActive?: boolean;
  newActive?: boolean;
  workingRequests?: boolean;
  failBuild?: boolean;
  failMv?: boolean;
  failNewEnable?: boolean;
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createEnv(home: string, bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    NODE_PATH: path.join(repoRoot, 'node_modules'),
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('APS_') || key.startsWith('SBOX_')) delete env[key];
    if (key === 'XDG_CONFIG_HOME' || key === 'XDG_STATE_HOME') delete env[key];
  }
  return env;
}

function markUnits(state: string, units: Array<'old' | 'new'>): void {
  for (const unit of units) {
    writeFileSync(path.join(state, `${unit}.active`), '');
    writeFileSync(path.join(state, `${unit}.enabled`), '');
  }
}

function writeSystemctlMock(bin: string, state: string): void {
  const statePath = shellQuote(state);
  writeExecutable(
    path.join(bin, 'systemctl'),
    [
      '#!/usr/bin/env bash',
      `state=${statePath}`,
      'printf \'%s\\n\' "$*" >> "$state/systemctl.log"',
      'unit=""',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    sandbox-harness|sandbox-harness.service) unit=old ;;',
      '    agent-process-segments|agent-process-segments.service) unit=new ;;',
      '  esac',
      'done',
      'case "$*" in',
      '  *show-environment*) exit 0 ;;',
      '  *" stop "*)',
      '    case "$unit" in old) rm -f "$state/old.active" ;; new) rm -f "$state/new.active" ;; esac',
      '    exit 0 ;;',
      '  *"disable "*)',
      '    case "$unit" in old) rm -f "$state/old.enabled" ;; new) rm -f "$state/new.enabled" ;; esac',
      '    exit 0 ;;',
      '  *" enable --now "*)',
      '    if [ "$unit" = new ] && [ -f "$state/fail-new-enable" ]; then exit 1; fi',
      '    touch "$state/$unit.active" "$state/$unit.enabled"',
      '    exit 0 ;;',
      '  *daemon-reload*) exit 0 ;;',
      '  *is-active*)',
      '    quiet=0',
      '    [[ "$*" == *--quiet* ]] && quiet=1',
      '    if [ "$unit" = old ] && [ -f "$state/old.active" ]; then',
      '      [ "$quiet" -eq 1 ] || echo active',
      '      exit 0',
      '    fi',
      '    if [ "$unit" = new ] && [ -f "$state/new.active" ]; then',
      '      [ "$quiet" -eq 1 ] || echo active',
      '      exit 0',
      '    fi',
      '    exit 3 ;;',
      '  *is-enabled*)',
      '    if [ "$unit" = old ] && [ -f "$state/old.enabled" ]; then exit 0; fi',
      '    if [ "$unit" = new ] && [ -f "$state/new.enabled" ]; then exit 0; fi',
      '    exit 1 ;;',
      '  *show*)',
      '    if [[ "$*" == *LoadState* ]]; then echo loaded; exit 0; fi',
      '    if [[ "$*" == *MainPID* ]]; then echo 0; exit 0; fi',
      '    exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
  );
}

function writeCurlMock(bin: string, state: string): void {
  const statePath = shellQuote(state);
  writeExecutable(
    path.join(bin, 'curl'),
    [
      '#!/usr/bin/env bash',
      `state=${statePath}`,
      'method=GET',
      'url=""',
      'body=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -X) method="$2"; shift 2 ;;',
      '    -d|--data|--data-raw) body="$2"; shift 2 ;;',
      '    -H|--max-time|-o|--output) shift 2 ;;',
      '    -*) shift ;;',
      '    *) url="$1"; shift ;;',
      '  esac',
      'done',
      'printf \'%s %s %s\\n\' "$method" "$url" "$body" >> "$state/curl.log"',
      'case "$url" in',
      '  */api/config)',
      '    if [ "$method" = PATCH ]; then',
      '      printf \'%s\\n\' "$body" >> "$state/config-patches.log"',
      '      exit 0',
      '    fi',
      '    printf \'%s\' \'{"master":{"enabled":true},"path":"mock"}\'',
      '    exit 0',
      '    ;;',
      '  */api/requests)',
      '    if [ -f "$state/requests-working" ]; then',
      '      printf \'%s\' \'[{"agentStatus":"working"}]\'',
      '    else',
      '      printf \'%s\' \'[]\'',
      '    fi',
      '    exit 0',
      '    ;;',
      '  */api/requests/*) printf \'%s\' \'{}\'; exit 0 ;;',
      '  */health)',
      '    if [ -f "$state/old.active" ] || [ -f "$state/new.active" ]; then',
      '      printf \'%s\' \'{"ok":true}\'',
      '      exit 0',
      '    fi',
      '    exit 7',
      '    ;;',
      '  *) exit 22 ;;',
      'esac',
      '',
    ].join('\n'),
  );
}

function writeNpmMock(bin: string, state: string): void {
  const statePath = shellQuote(state);
  writeExecutable(
    path.join(bin, 'npm'),
    [
      '#!/usr/bin/env bash',
      `state=${statePath}`,
      'if [ -f "$state/fail-build" ]; then',
      '  printf \'%s\\n\' failed-build > src/server/dist/marker.txt',
      '  printf \'%s\\n\' failed-build > src/web/dist/marker.txt',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
}

function writeMvMock(bin: string, state: string): void {
  const statePath = shellQuote(state);
  writeExecutable(
    path.join(bin, 'mv'),
    [
      '#!/usr/bin/env bash',
      `state=${statePath}`,
      'if [ -f "$state/fail-mv" ]; then',
      '  echo "simulated mv failure" >&2',
      '  exit 1',
      'fi',
      'exec /bin/mv "$@"',
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

function gitHead(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const root = tmpDir('cutover-test');
  const home = path.join(root, 'home');
  const oldClone = path.join(root, 'oldclone');
  const newClone = path.join(root, 'newclone');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'mock-state');

  mkdirSync(path.join(home, '.sandbox-harness', 'requests', 'req-1'), { recursive: true });
  mkdirSync(path.join(home, '.config', 'sandbox-harness'), { recursive: true });
  mkdirSync(path.join(home, '.local', 'state', 'sandbox-harness'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(oldClone, { recursive: true });
  mkdirSync(state, { recursive: true });

  writeFileSync(
    path.join(home, '.sandbox-harness', 'requests', 'req-1', 'transcript.json'),
    '{"fixture":"request"}\n',
  );
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
  db.prepare('INSERT INTO requests (id) VALUES (?)').run('req-1');
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
  writeFileSync(
    path.join(oldClone, '.gitignore'),
    'node_modules/\nsrc/server/dist/\nsrc/web/dist/\n*.sqlite*\n',
  );
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(oldClone, 'node_modules'), 'dir');

  initCommit(oldClone);
  execFileSync('git', ['init', '--bare', path.join(root, 'origin.git')], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', path.join(root, 'origin.git')], {
    cwd: oldClone,
  });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: oldClone, stdio: 'ignore' });

  mkdirSync(path.join(oldClone, 'src', 'server', 'dist'), { recursive: true });
  mkdirSync(path.join(oldClone, 'src', 'web', 'dist'), { recursive: true });
  writeFileSync(path.join(oldClone, 'src', 'server', 'dist', 'marker.txt'), 'prebuild-server\n');
  writeFileSync(path.join(oldClone, 'src', 'web', 'dist', 'marker.txt'), 'prebuild-web\n');

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
  writeSystemctlMock(bin, state);
  writeCurlMock(bin, state);
  writeNpmMock(bin, state);
  writeMvMock(bin, state);

  if (options.oldActive) markUnits(state, ['old']);
  if (options.newActive) markUnits(state, ['new']);
  if (options.workingRequests) writeFileSync(path.join(state, 'requests-working'), '');
  if (options.failBuild) writeFileSync(path.join(state, 'fail-build'), '');
  if (options.failMv) writeFileSync(path.join(state, 'fail-mv'), '');
  if (options.failNewEnable) writeFileSync(path.join(state, 'fail-new-enable'), '');

  return {
    root,
    home,
    oldClone,
    newClone,
    bin,
    state,
    env: createEnv(home, bin),
  };
}

function createMigratedFixture(): Fixture {
  const root = tmpDir('cutover-test');
  const home = path.join(root, 'home');
  const oldClone = path.join(root, 'oldclone');
  const newClone = path.join(root, 'newclone');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'mock-state');

  mkdirSync(path.join(home, '.agent-process-segments', 'requests', 'req-1'), { recursive: true });
  mkdirSync(path.join(home, '.config', 'agent-process-segments'), { recursive: true });
  mkdirSync(path.join(home, '.local', 'state', 'agent-process-segments'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(newClone, { recursive: true });
  mkdirSync(state, { recursive: true });

  writeFileSync(
    path.join(home, '.agent-process-segments', 'requests', 'req-1', 'transcript.json'),
    '{"fixture":"request"}\n',
  );
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
  db.prepare('INSERT INTO requests (id) VALUES (?)').run('req-1');
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
  writeFileSync(
    path.join(newClone, '.gitignore'),
    'node_modules/\nsrc/server/dist/\nsrc/web/dist/\n*.sqlite*\n',
  );
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(newClone, 'node_modules'), 'dir');
  initCommit(newClone);

  writeExecutable(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
  writeSystemctlMock(bin, state);
  writeCurlMock(bin, state);
  markUnits(state, ['new']);

  return {
    root,
    home,
    oldClone,
    newClone,
    bin,
    state,
    env: createEnv(home, bin),
  };
}

function runCutover(fixture: Fixture, args: string[]) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: fixture.env,
    timeout: SCRIPT_TIMEOUT,
  });
}

function liveArgs(fixture: Fixture, runDir: string, extra: string[] = []): string[] {
  return [
    '--run',
    '--run-dir',
    runDir,
    '--home',
    fixture.home,
    '--old-clone',
    fixture.oldClone,
    '--new-clone',
    fixture.newClone,
    ...extra,
  ];
}

function readState(runDir: string): string {
  return readFileSync(path.join(runDir, 'state'), 'utf8').trim();
}

function readRunLog(runDir: string): string {
  return readFileSync(path.join(runDir, 'cutover.log'), 'utf8');
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

function systemctlCalls(fixture: Fixture): string {
  return readLines(path.join(fixture.state, 'systemctl.log')).join('\n');
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
    const headBefore = gitHead(fixture.newClone);

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
    expect(gitHead(fixture.newClone)).toBe(headBefore);
  });

  it('refuses when the new unit is active but legacy paths remain', () => {
    const fixture = createFixture();
    markUnits(fixture.state, ['new']);
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

  it(
    'restores the master and reports failed when the drain times out',
    () => {
      const fixture = createFixture({ oldActive: true, workingRequests: true });
      const runDir = path.join(fixture.root, 'run');
      const config = path.join(fixture.home, '.config', 'sandbox-harness', 'config.json');
      const configBefore = readFileSync(config, 'utf8');
      const headBefore = gitHead(fixture.oldClone);

      const result = runCutover(fixture, liveArgs(fixture, runDir, ['--wait-seconds', '1']));
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain('timed out waiting for 1 working turn(s) to drain');
      expect(readState(runDir)).toBe('failed');
      expect(readRunLog(runDir)).toContain('rolling back');
      expect(readRunLog(runDir)).toContain('rollback finished');
      expect(readLines(path.join(fixture.state, 'config-patches.log'))).toEqual([
        '{"master":{"enabled":false}}',
        '{"master":{"enabled":true}}',
      ]);

      const calls = systemctlCalls(fixture);
      expect(calls).not.toContain(' stop ');
      expect(calls).not.toContain(' disable ');
      expect(readFileSync(config, 'utf8')).toBe(configBefore);
      expect(gitHead(fixture.oldClone)).toBe(headBefore);
      expect(existsSync(path.join(fixture.home, '.sandbox-harness'))).toBe(true);
      expect(existsSync(fixture.newClone)).toBe(false);
      expect(existsSync(path.join(fixture.home, '.agent-process-segments'))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'restores the pre-build dist directories when the build fails before stopping',
    () => {
      const fixture = createFixture({ failBuild: true });
      const runDir = path.join(fixture.root, 'run');
      const headBefore = gitHead(fixture.oldClone);
      const serverMarker = path.join(fixture.oldClone, 'src', 'server', 'dist', 'marker.txt');
      const webMarker = path.join(fixture.oldClone, 'src', 'web', 'dist', 'marker.txt');
      const serverBefore = readFileSync(serverMarker, 'utf8');
      const webBefore = readFileSync(webMarker, 'utf8');

      const result = runCutover(fixture, liveArgs(fixture, runDir));

      expect(result.status).not.toBe(0);
      expect(readState(runDir)).toBe('failed');
      expect(readRunLog(runDir)).toContain('rolling back');
      expect(readRunLog(runDir)).toContain('restored the pre-build dist directories');
      expect(readFileSync(serverMarker, 'utf8')).toBe(serverBefore);
      expect(readFileSync(webMarker, 'utf8')).toBe(webBefore);
      expect(systemctlCalls(fixture)).not.toContain(' stop ');
      expect(existsSync(path.join(fixture.home, '.sandbox-harness'))).toBe(true);
      expect(existsSync(fixture.newClone)).toBe(false);
      expect(existsSync(path.join(fixture.home, '.agent-process-segments'))).toBe(false);
      expect(gitHead(fixture.oldClone)).toBe(headBefore);
    },
    TEST_TIMEOUT,
  );

  it(
    'restores the old unit when the clone move fails after the stop',
    () => {
      const fixture = createFixture({ failMv: true });
      const runDir = path.join(fixture.root, 'run');
      const config = path.join(fixture.home, '.config', 'sandbox-harness', 'config.json');
      const configBefore = readFileSync(config, 'utf8');
      const headBefore = gitHead(fixture.oldClone);
      const oldData = path.join(fixture.home, '.sandbox-harness');
      const oldConfig = path.join(fixture.home, '.config', 'sandbox-harness');
      const oldState = path.join(fixture.home, '.local', 'state', 'sandbox-harness');
      const oldDb = path.join(fixture.oldClone, 'sandbox-harness.sqlite');
      const requestMarker = path.join(oldData, 'requests', 'req-1', 'transcript.json');
      const rollbackConf = path.join(
        fixture.home,
        '.config',
        'systemd',
        'user',
        'sandbox-harness.service.d',
        'zz-rollback.conf',
      );

      const result = runCutover(fixture, liveArgs(fixture, runDir));
      const log = readRunLog(runDir);

      expect(result.status).not.toBe(0);
      expect(readState(runDir)).toBe('rolled-back');
      expect(log).toContain('failed at line');
      expect(log).toContain('rolling back');
      expect(log).toContain('rollback finished');

      const calls = systemctlCalls(fixture);
      expect(calls).toContain('stop sandbox-harness');
      expect(calls).toContain('enable --now sandbox-harness');
      expect(calls).not.toContain('enable --now agent-process-segments');

      expect(existsSync(fixture.oldClone)).toBe(true);
      expect(existsSync(fixture.newClone)).toBe(false);
      expect(existsSync(oldData)).toBe(true);
      expect(existsSync(oldConfig)).toBe(true);
      expect(existsSync(oldState)).toBe(true);
      expect(existsSync(oldDb)).toBe(true);
      expect(existsSync(requestMarker)).toBe(true);
      expect(existsSync(path.join(fixture.home, '.agent-process-segments'))).toBe(false);
      expect(existsSync(path.join(fixture.home, '.config', 'agent-process-segments'))).toBe(false);
      expect(existsSync(path.join(fixture.home, '.local', 'state', 'agent-process-segments'))).toBe(
        false,
      );
      expect(existsSync(rollbackConf)).toBe(false);
      expect(readFileSync(config, 'utf8')).toBe(configBefore);
      expect(gitHead(fixture.oldClone)).toBe(headBefore);
      expect(existsSync(path.join(fixture.state, 'old.active'))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps migrated data in place and restores the old unit when the new unit fails to start',
    () => {
      const fixture = createFixture({ failNewEnable: true });
      const runDir = path.join(fixture.root, 'run');
      const oldConfig = path.join(fixture.home, '.config', 'sandbox-harness', 'config.json');
      const oldProcess = path.join(fixture.home, '.config', 'sandbox-harness', 'process.json');
      const configBefore = readFileSync(oldConfig, 'utf8');
      const processBefore = readFileSync(oldProcess, 'utf8');
      const requestBefore = readFileSync(
        path.join(fixture.home, '.sandbox-harness', 'requests', 'req-1', 'transcript.json'),
        'utf8',
      );

      const result = runCutover(fixture, liveArgs(fixture, runDir));
      const log = readRunLog(runDir);

      expect(result.status).not.toBe(0);
      expect(readState(runDir)).toBe('rolled-back');
      expect(log).toContain('failed at line');
      expect(log).toContain('rolling back');
      expect(log).toContain('rollback finished');

      const calls = systemctlCalls(fixture);
      expect(calls).toContain('stop sandbox-harness');
      expect(calls).toContain('enable --now agent-process-segments');
      expect(calls).toContain('stop agent-process-segments');
      expect(calls).toContain('disable agent-process-segments');
      expect(calls).toContain('enable --now sandbox-harness');

      expect(existsSync(fixture.oldClone)).toBe(false);
      expect(existsSync(fixture.newClone)).toBe(true);
      expect(existsSync(path.join(fixture.home, '.sandbox-harness'))).toBe(false);
      expect(existsSync(path.join(fixture.home, '.config', 'sandbox-harness'))).toBe(false);
      expect(existsSync(path.join(fixture.home, '.local', 'state', 'sandbox-harness'))).toBe(false);

      const newData = path.join(fixture.home, '.agent-process-segments');
      const newConfig = path.join(fixture.home, '.config', 'agent-process-segments');
      const newState = path.join(fixture.home, '.local', 'state', 'agent-process-segments');
      const newDb = path.join(fixture.newClone, 'agent-process-segments.sqlite');
      const newConfigFile = path.join(newConfig, 'config.json');
      const newProcessFile = path.join(newConfig, 'process.json');
      const newErrorLog = path.join(newState, 'errors.log');
      const newRequest = path.join(newData, 'requests', 'req-1', 'transcript.json');

      expect(existsSync(newData)).toBe(true);
      expect(existsSync(newConfig)).toBe(true);
      expect(existsSync(newState)).toBe(true);
      expect(existsSync(newDb)).toBe(true);
      expect(readFileSync(newConfigFile, 'utf8')).toBe(configBefore);
      expect(readFileSync(newProcessFile, 'utf8')).toBe(processBefore);
      expect(readFileSync(newRequest, 'utf8')).toBe(requestBefore);

      const db = new Database(newDb, { readonly: true });
      expect(db.prepare('SELECT count(*) AS count FROM requests').get()).toEqual({ count: 1 });
      db.close();

      const rollbackConf = path.join(
        fixture.home,
        '.config',
        'systemd',
        'user',
        'sandbox-harness.service.d',
        'zz-rollback.conf',
      );
      const conf = readFileSync(rollbackConf, 'utf8');
      expect(conf).toContain(`WorkingDirectory=${fixture.newClone}`);
      expect(conf).toContain(`Environment=SBOX_DB=${newDb}`);
      expect(conf).toContain(`Environment=SBOX_DATA_DIR=${newData}`);
      expect(conf).toContain(`Environment=SBOX_CONFIG=${newConfigFile}`);
      expect(conf).toContain(`Environment=SBOX_PROCESS=${newProcessFile}`);
      expect(conf).toContain(`Environment=SBOX_ERROR_LOG=${newErrorLog}`);

      expect(
        existsSync(path.join(runDir, 'backup', 'systemd', 'sandbox-harness.service')),
      ).toBe(true);
      expect(
        existsSync(
          path.join(runDir, 'backup', 'systemd', 'sandbox-harness.service.d', 'harness.conf'),
        ),
      ).toBe(true);
      expect(existsSync(path.join(fixture.state, 'old.active'))).toBe(true);
      expect(existsSync(path.join(fixture.state, 'new.active'))).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
