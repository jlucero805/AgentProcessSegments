import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './tmp.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(repoRoot, 'deploy/upgrade-vps.sh');

const SYSTEMCTL_STUB = String.raw`#!/usr/bin/env bash
root="$FIXTURE_ROOT"
printf "%s\n" "$*" >>"$root/systemctl.calls"
case "$*" in
  *show-environment*) exit 0 ;;
  *"-p LoadState"*) echo loaded; exit 0 ;;
  *"-p WorkingDirectory"*) printf "%s\n" "$FIXTURE_CLONE"; exit 0 ;;
  *"-p ActiveEnterTimestamp"*) date -u "+%a %Y-%m-%d %H:%M:%S UTC"; exit 0 ;;
  *"-p MainPID"*) echo 0; exit 0 ;;
  *"-p Environment"*)
    printf "NODE_ENV=production APS_HOST=127.0.0.1 APS_PORT=7391 APS_DB=%s/agent-process-segments.sqlite APS_DATA_DIR=%s/.agent-process-segments APS_WEB_DIR=%s/src/web/dist\n" \
      "$FIXTURE_CLONE" "$FIXTURE_HOME" "$FIXTURE_CLONE"
    exit 0 ;;
  *is-active*) echo active; exit 0 ;;
  *restart*) echo $(( $(cat "$root/restarts" 2>/dev/null || echo 0) + 1 )) >"$root/restarts"; exit 0 ;;
  *) exit 0 ;;
esac
`;

const SYSTEMD_RUN_STUB = String.raw`#!/usr/bin/env bash
root="$FIXTURE_ROOT"
printf "%s\n" "$*" >>"$root/systemd-run.calls"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit=*|--property=*|--setenv=*|--working-directory=*) shift ;;
    --unit|--property|--setenv|--working-directory) shift 2 ;;
    --collect|--user) shift ;;
    *) break ;;
  esac
done
# Simulate state changing between the parent preflight and the detached run.
if [[ -f "$root/refuse-detached-preflight" ]]; then
  printf 'drift\n' >"$FIXTURE_CLONE/untracked-drift.txt"
fi
if [[ -f "$root/break-detached-pruner" ]]; then
  for pruner in "$FIXTURE_HOME"/.aps-cutover/upgrades/*/prune-cutover-runs.mjs; do
    [[ -f "$pruner" ]] || continue
    printf '#!/usr/bin/env node\nprocess.exit(1);\n' >"$pruner"
  done
fi
if [[ -f "$root/fail-detached-launch" ]]; then
  exit 1
fi
exec "$@"
`;

const CURL_STUB = String.raw`#!/usr/bin/env bash
root="$FIXTURE_ROOT"
method=GET
status_only=0
data=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) data="$2"; shift 2 ;;
    -w) status_only=1; shift 2 ;;
    -o) shift 2 ;;
    -H) shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
path="$(printf "%s" "$url" | sed -E "s#^[a-z]+://[^/]+##")"
printf "%s %s %s\n" "$method" "$path" "$data" >>"$root/curl.calls"
restarts="$(cat "$root/restarts" 2>/dev/null || echo 0)"
if [[ -f "$root/fail-health-once" && "$restarts" -eq 1 ]]; then unhealthy=1; else unhealthy=0; fi
status=200
body=""
case "$path" in
  /health)
    if [[ "$unhealthy" -eq 1 ]]; then status=503; body='{"ok":false}'; else body='{"ok":true}'; fi ;;
  /api/config)
    if [[ "$method" == "PATCH" ]]; then
      printf "%s\n" "$data" >>"$root/config.patches"
      cat "$root/config.json"
      exit 0
    fi
    cat "$root/config.json" ;;
  /api/requests) body='[]' ;;
  /api/requests/*) body='{"id":"fixture"}' ;;
  /api/models) body='{"harness":"opencode","source":"probe"}' ;;
  /api/notifications/status) body='{"enabled":true}' ;;
  *) status=404; body='{"error":"not_found"}' ;;
esac
if [[ "$status_only" -eq 1 ]]; then printf "%s" "$status"; else printf "%s" "$body"; fi
`;

const NPM_STUB = String.raw`#!/usr/bin/env bash
root="$FIXTURE_ROOT"
nodeenv="$NODE_ENV"
if [[ -z "$nodeenv" ]]; then nodeenv=unset; fi
printf "%s NODE_ENV=%s\n" "$*" "$nodeenv" >>"$root/npm.calls"
if [[ "$1" == "ci" ]]; then
  case " $* " in
    *" --include=dev "*) ;;
    *) printf "missing --include=dev\n" >&2; exit 1 ;;
  esac
  rm -rf node_modules
  mkdir -p node_modules
  printf "new\n" >node_modules/marker.txt
  exit 0
fi
if [[ "$1" == "run" && "$2" == "build" ]]; then
  if [[ -f "$root/fail-build" ]]; then printf "build failed\n" >&2; exit 1; fi
  mkdir -p src/server/dist src/web/dist
  printf "built server\n" >src/server/dist/app.js
  printf "built web\n" >src/web/dist/index.html
  exit 0
fi
exit 0
`;

const JOURNALCTL_STUB = '#!/usr/bin/env bash\nexit 0\n';

interface Fixture {
  root: string;
  home: string;
  clone: string;
  v1: string;
  v2: string;
  env: NodeJS.ProcessEnv;
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function head(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']);
}

function writeFixtureTree(dir: string, version: string, lockfile: string): void {
  mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  mkdirSync(path.join(dir, 'src/server/src/http'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { build: 'echo fixture' } }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages:
          lockfile === 'v2'
            ? { 'node_modules/fixture-dep': { version: '1.0.0' } }
            : {},
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(dir, '.gitignore'),
    'node_modules/\ndist/\n*.sqlite\n*.sqlite-wal\n*.sqlite-shm\n',
  );
  writeFileSync(
    path.join(dir, 'deploy/agent-process-segments.service'),
    '[Service]\nWorkingDirectory=%h/agent-process-segments\n',
  );
  writeFileSync(
    path.join(dir, 'src/server/src/http/server.ts'),
    "app.get('/api/notifications/status', async () => ({ ok: true }));\n",
  );
  writeFileSync(path.join(dir, 'src/server/src/version.ts'), `export const version = '${version}';\n`);
}

function createEnv(root: string, home: string, clone: string, bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    NODE_PATH: path.join(repoRoot, 'node_modules'),
    FIXTURE_ROOT: root,
    FIXTURE_HOME: home,
    FIXTURE_CLONE: clone,
  };
  for (const key of [
    'NODE_ENV',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'APS_DB',
    'APS_DATA_DIR',
    'APS_CONFIG',
    'APS_PROCESS',
    'APS_ERROR_LOG',
    'SBOX_DB',
    'SBOX_DATA_DIR',
    'SBOX_CONFIG',
    'SBOX_PROCESS',
    'SBOX_ERROR_LOG',
  ]) {
    delete env[key];
  }
  return env;
}

function createFixture(options: { lockfileChanges?: boolean } = {}): Fixture {
  const root = tmpDir('upgrade-vps');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const origin = path.join(root, 'origin.git');
  const builder = path.join(root, 'builder');
  const clone = path.join(root, 'live');

  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin]);

  mkdirSync(builder, { recursive: true });
  writeFixtureTree(builder, 'v1', 'v1');
  git(builder, ['init', '-b', 'main']);
  git(builder, ['add', '.']);
  git(builder, ['commit', '-m', 'fixture v1']);
  git(builder, ['remote', 'add', 'origin', origin]);
  const v1 = head(builder);
  git(builder, ['push', '-u', 'origin', 'main']);

  writeFixtureTree(builder, 'v2', options.lockfileChanges === false ? 'v1' : 'v2');
  git(builder, ['add', '.']);
  git(builder, ['commit', '-m', 'fixture v2']);
  const v2 = head(builder);
  git(builder, ['push', 'origin', 'main']);

  execFileSync('git', ['clone', '--quiet', origin, clone]);
  git(clone, ['reset', '--hard', v1]);

  // Runtime trees the real clone keeps out of git; the script must back these up itself.
  mkdirSync(path.join(clone, 'src/server/dist'), { recursive: true });
  writeFileSync(path.join(clone, 'src/server/dist/app.js'), 'old server\n');
  mkdirSync(path.join(clone, 'src/web/dist'), { recursive: true });
  writeFileSync(path.join(clone, 'src/web/dist/index.html'), 'old web\n');
  mkdirSync(path.join(clone, 'node_modules'), { recursive: true });
  writeFileSync(path.join(clone, 'node_modules/marker.txt'), 'old\n');

  const db = new Database(path.join(clone, 'agent-process-segments.sqlite'));
  db.exec('CREATE TABLE requests (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO requests (id) VALUES (?)').run('one');
  db.close();

  writeExecutable(path.join(bin, 'systemctl'), SYSTEMCTL_STUB);
  writeExecutable(path.join(bin, 'systemd-run'), SYSTEMD_RUN_STUB);
  writeExecutable(path.join(bin, 'curl'), CURL_STUB);
  writeExecutable(path.join(bin, 'npm'), NPM_STUB);
  writeExecutable(path.join(bin, 'journalctl'), JOURNALCTL_STUB);

  writeFileSync(
    path.join(root, 'config.json'),
    `${JSON.stringify(
      {
        master: { enabled: true, intervalMinutes: 5 },
        path: path.join(home, 'config.json'),
      },
      null,
      2,
    )}\n`,
  );

  return { root, home, clone, v1, v2, env: createEnv(root, home, clone, bin) };
}

function runScript(fixture: Fixture, args: string[], timeout = 60_000, umask?: string) {
  const argv = [script, '--home', fixture.home, '--clone', fixture.clone, ...args];
  const options = { encoding: 'utf8' as const, env: fixture.env, timeout };
  if (umask === undefined) return spawnSync('bash', argv, options);
  return spawnSync('bash', ['-c', `umask ${umask}; exec bash "$@"`, 'bash', ...argv], options);
}

function latestRun(fixture: Fixture): string {
  return realpathSync(path.join(fixture.home, '.aps-cutover', 'upgrades', 'latest'));
}

function upgradeRuns(fixture: Fixture): string[] {
  const dir = path.join(fixture.home, '.aps-cutover', 'upgrades');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{8}T\d{6}Z$/.test(name))
    .sort();
}

function seedUpgradeRun(
  fixture: Fixture,
  name: string,
  options: { state?: string; ageDays?: number } = {},
): string {
  const dir = path.join(fixture.home, '.aps-cutover', 'upgrades', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'upgrade.log'), 'old run\n');
  writeFileSync(path.join(dir, 'state'), `${options.state ?? 'success'}\n`);
  const seconds = Date.now() / 1000 - (options.ageDays ?? 0) * 86_400;
  utimesSync(dir, seconds, seconds);
  return dir;
}

function seedSuccessfulRuns(fixture: Fixture, count: number, ageDays = 40): string[] {
  const names = Array.from({ length: count }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return `202501${day}T000000Z`;
  });
  for (const name of names) seedUpgradeRun(fixture, name, { state: 'success', ageDays });
  return names;
}

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

function stateOf(fixture: Fixture): string {
  return readFileSync(path.join(latestRun(fixture), 'state'), 'utf8').trim();
}

function calls(fixture: Fixture, file: string): string {
  const full = path.join(fixture.root, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

function patchBody(fixture: Fixture): unknown {
  return JSON.parse(readFileSync(path.join(latestRun(fixture), 'after.json'), 'utf8'));
}

describe('deploy/upgrade-vps.sh', () => {
  it('shows usage for --help', () => {
    const result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    for (const flag of [
      '--dry-run',
      '--detach',
      '--request-id',
      '--home',
      '--clone',
      '--unit',
      '--branch',
      '--to',
      '--wait-seconds',
      '--health-timeout',
      '--allow-busy',
      '--keep-runs',
      '--keep-days',
      '--no-prune',
    ]) {
      expect(result.stdout).toContain(flag);
    }
  });

  it('rejects invalid retention counts before doing any work', () => {
    const fixture = createFixture();
    for (const args of [
      ['--keep-runs'],
      ['--keep-runs', '-1'],
      ['--keep-runs', 'abc'],
      ['--keep-runs', '100001'],
      ['--keep-days'],
      ['--keep-days', '-1'],
      ['--keep-days', 'abc'],
      ['--keep-days', '100001'],
    ]) {
      const result = runScript(fixture, args);
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /needs a value|needs a non-negative integer|must be at most 100000/,
      );
    }
    expect(calls(fixture, 'npm.calls')).toBe('');
    expect(calls(fixture, 'restarts')).toBe('');
  });

  it('previews upgrade-run retention during a dry run without changing runs', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 4);
    const oldest = seeded[0];
    if (oldest === undefined) throw new Error('expected a seeded run');
    const before = upgradeRuns(fixture);

    const result = runScript(fixture, [
      '--dry-run',
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('plan: would prune upgrade runs (--keep-runs 1 --keep-days 0)');
    expect(output).toContain(oldest);
    expect(output).toContain('(dry run: nothing removed)');
    expect(upgradeRuns(fixture)).toEqual(before);
    expect(head(fixture.clone)).toBe(fixture.v1);
    expect(calls(fixture, 'npm.calls')).toBe('');
    expect(calls(fixture, 'restarts')).toBe('');
  });

  it('forwards custom retention settings and prunes old runs after success', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);

    const result = runScript(fixture, [
      '--detach',
      '--health-timeout',
      '10',
      '--keep-runs',
      '3',
      '--keep-days',
      '0',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(stateOf(fixture)).toBe('success');
    expect(calls(fixture, 'systemd-run.calls')).toContain('--keep-runs 3 --keep-days 0');
    expect(readFileSync(path.join(latestRun(fixture), 'upgrade.log'), 'utf8')).toContain(
      'prune success (--keep-runs 3 --keep-days 0)',
    );
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([...seeded.slice(5), current].sort());
    expect(output).toContain('pruned');
  });

  it('keeps runs modified inside the keep-days window', () => {
    const fixture = createFixture();
    const recent = seedSuccessfulRuns(fixture, 2, 2);
    const old = Array.from({ length: 3 }, (_, index) => {
      const name = `2024010${index + 1}T000000Z`;
      seedUpgradeRun(fixture, name, { state: 'success', ageDays: 40 });
      return name;
    });

    const result = runScript(fixture, [
      '--detach',
      '--health-timeout',
      '10',
      '--keep-runs',
      '0',
      '--keep-days',
      '30',
    ]);

    expect(result.status).toBe(0);
    expect(stateOf(fixture)).toBe('success');
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([...recent, current].sort());
    for (const name of old) expect(existsSync(path.join(fixture.home, '.aps-cutover', 'upgrades', name))).toBe(false);
  });

  it('prunes old runs after a failed upgrade', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);
    writeFileSync(path.join(fixture.root, 'fail-build'), '1\n');

    runScript(fixture, [
      '--detach',
      '--health-timeout',
      '10',
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
    ]);

    expect(stateOf(fixture)).toBe('failed');
    const newest = seeded.at(-1);
    if (newest === undefined) throw new Error('expected seeded runs');
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([newest, current].sort());
    const log = readFileSync(path.join(latestRun(fixture), 'upgrade.log'), 'utf8');
    expect(log.match(/prune failed \(/g)).toHaveLength(1);
  });

  it('prunes old runs after a rollback', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);
    writeFileSync(path.join(fixture.root, 'fail-health-once'), '1\n');

    runScript(fixture, [
      '--detach',
      '--health-timeout',
      '3',
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
    ]);

    expect(stateOf(fixture)).toBe('rolled_back');
    const newest = seeded.at(-1);
    if (newest === undefined) throw new Error('expected seeded runs');
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([newest, current].sort());
  });

  it('skips pruning with --no-prune', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);

    const result = runScript(fixture, [
      '--detach',
      '--health-timeout',
      '10',
      '--keep-runs',
      '0',
      '--keep-days',
      '0',
      '--no-prune',
    ]);

    expect(result.status).toBe(0);
    expect(stateOf(fixture)).toBe('success');
    for (const name of seeded) {
      expect(existsSync(path.join(fixture.home, '.aps-cutover', 'upgrades', name))).toBe(true);
    }
    expect(readFileSync(path.join(latestRun(fixture), 'upgrade.log'), 'utf8')).toContain(
      'pruning skipped (--no-prune)',
    );
  });

  it('prunes old runs when a detached preflight refuses', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);
    writeFileSync(path.join(fixture.root, 'refuse-detached-preflight'), '1\n');

    const result = runScript(fixture, [
      '--detach',
      '--health-timeout',
      '10',
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('the detached upgrade did not complete');
    expect(stateOf(fixture)).toBe('failed');
    const newest = seeded.at(-1);
    if (newest === undefined) throw new Error('expected seeded runs');
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([newest, current].sort());
    const log = readFileSync(path.join(latestRun(fixture), 'upgrade.log'), 'utf8');
    expect(log).toContain('REFUSED: clone has uncommitted changes');
    expect(log.match(/prune failed \(/g)).toHaveLength(1);
    expect(modeOf(latestRun(fixture))).toBe(0o700);
  }, 30_000);

  it('keeps every run when a refused detached preflight opts out of pruning', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);
    writeFileSync(path.join(fixture.root, 'refuse-detached-preflight'), '1\n');

    const result = runScript(fixture, [
      '--detach',
      '--health-timeout',
      '10',
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
      '--no-prune',
    ]);

    expect(result.status).toBe(1);
    expect(stateOf(fixture)).toBe('failed');
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([...seeded, current].sort());
    expect(readFileSync(path.join(latestRun(fixture), 'upgrade.log'), 'utf8')).toContain(
      'pruning skipped (--no-prune)',
    );
  }, 30_000);

  it('warns instead of failing when the pruner breaks on a refusal', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);
    writeFileSync(path.join(fixture.root, 'refuse-detached-preflight'), '1\n');
    writeFileSync(path.join(fixture.root, 'break-detached-pruner'), '1\n');

    const result = runScript(fixture, [
      '--detach',
      '--health-timeout',
      '10',
      '--keep-runs',
      '1',
      '--keep-days',
      '0',
    ]);

    expect(result.status).toBe(1);
    expect(stateOf(fixture)).toBe('failed');
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([...seeded, current].sort());
    const log = readFileSync(path.join(latestRun(fixture), 'upgrade.log'), 'utf8');
    expect(log.match(/prune failed \(/g)).toHaveLength(1);
    expect(log).toContain('(exit 1); older run directories may remain');
    expect(log).not.toContain('upgrade pruner not found');
  }, 30_000);

  it('prunes old runs when the detached upgrade cannot start', () => {
    const fixture = createFixture();
    const seeded = seedSuccessfulRuns(fixture, 7);
    writeFileSync(path.join(fixture.root, 'fail-detached-launch'), '1\n');

    const result = runScript(fixture, ['--detach', '--keep-runs', '1', '--keep-days', '0']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('the detached upgrade did not complete');
    expect(stateOf(fixture)).toBe('failed');
    const newest = seeded.at(-1);
    if (newest === undefined) throw new Error('expected seeded runs');
    const current = path.basename(latestRun(fixture));
    expect(upgradeRuns(fixture)).toEqual([newest, current].sort());
    const log = readFileSync(path.join(latestRun(fixture), 'upgrade.log'), 'utf8');
    expect(log.match(/prune failed \(/g)).toHaveLength(1);
  }, 30_000);

  it('fails closed when the pruning helper is missing', () => {
    const fixture = createFixture();
    const checkout = path.join(fixture.root, 'script-checkout');
    mkdirSync(path.join(checkout, 'deploy'), { recursive: true });
    copyFileSync(script, path.join(checkout, 'deploy', 'upgrade-vps.sh'));
    const copiedScript = path.join(checkout, 'deploy', 'upgrade-vps.sh');

    const result = spawnSync(
      'bash',
      [copiedScript, '--home', fixture.home, '--clone', fixture.clone, '--dry-run'],
      { encoding: 'utf8', env: fixture.env, timeout: 60_000 },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain('upgrade pruner not found');
    expect(output).toContain('--no-prune');

    const noPrune = spawnSync(
      'bash',
      [copiedScript, '--home', fixture.home, '--clone', fixture.clone, '--dry-run', '--no-prune'],
      { encoding: 'utf8', env: fixture.env, timeout: 60_000 },
    );
    expect(noPrune.status).toBe(0);
    expect(`${noPrune.stdout}${noPrune.stderr}`).toContain(
      'plan: would skip pruning upgrade runs (--no-prune)',
    );
  });

  it('prints the plan and changes nothing on --dry-run', () => {
    const fixture = createFixture();
    const before = head(fixture.clone);

    const result = runScript(fixture, ['--dry-run']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('plan: old HEAD');
    expect(output).toContain('would run npm ci --include=dev');
    expect(output).toContain('would pause master.enabled=true');
    expect(output).toContain('dry run complete; nothing was changed');
    expect(head(fixture.clone)).toBe(before);
    expect(calls(fixture, 'npm.calls')).toBe('');
    expect(calls(fixture, 'restarts')).toBe('');
    expect(existsSync(path.join(fixture.home, '.aps-cutover', 'upgrades'))).toBe(false);
  }, 30_000);

  it('refuses a clone that is not a fast-forward', () => {
    const fixture = createFixture();
    git(fixture.clone, ['commit', '--allow-empty', '-m', 'local work']);
    const before = head(fixture.clone);

    const result = runScript(fixture, ['--dry-run']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('not a fast-forward');
    expect(head(fixture.clone)).toBe(before);
    expect(calls(fixture, 'npm.calls')).toBe('');
    expect(calls(fixture, 'restarts')).toBe('');
  }, 30_000);

  it('refuses a dirty worktree', () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.clone, 'scratch.txt'), 'dirty\n');

    const result = runScript(fixture, ['--dry-run']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('uncommitted changes');
    expect(calls(fixture, 'npm.calls')).toBe('');
    expect(calls(fixture, 'restarts')).toBe('');
    expect(existsSync(path.join(fixture.home, '.aps-cutover', 'upgrades'))).toBe(false);
  }, 30_000);

  it('refuses a live run without --detach or --dry-run', () => {
    const fixture = createFixture();

    const result = runScript(fixture, []);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain('Refusing to restart agent-process-segments');
    expect(calls(fixture, 'restarts')).toBe('');
    expect(head(fixture.clone)).toBe(fixture.v1);
  }, 30_000);

  it('fast-forwards, installs, builds, restarts, and verifies', () => {
    const fixture = createFixture();

    const result = runScript(fixture, ['--detach', '--health-timeout', '10']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(stateOf(fixture)).toBe('success');
    expect(head(fixture.clone)).toBe(fixture.v2);
    expect(output).toContain('new-code probe passed');

    const npm = calls(fixture, 'npm.calls').trim().split('\n');
    expect(npm[0]).toContain('ci --include=dev');
    expect(npm[0]).toContain('NODE_ENV=unset');
    expect(npm[1]).toContain('run build');

    expect(calls(fixture, 'systemd-run.calls')).toContain('--run --run-dir');
    expect(calls(fixture, 'systemd-run.calls')).toContain('--setenv=HOME=');
    expect(calls(fixture, 'restarts').trim()).toBe('1');

    const patches = calls(fixture, 'config.patches').trim().split('\n');
    expect(patches[0]).toBe('{"master":{"enabled":false}}');
    expect(patches[patches.length - 1]).toBe('{"master":{"enabled":true}}');

    const run = latestRun(fixture);
    for (const file of [
      'upgrade.log',
      'before.json',
      'after.json',
      'config-before.json',
      'config-after.json',
      'db-before.json',
      'db-backup.sqlite',
      'dist-backup/server',
      'dist-backup/web',
    ]) {
      expect(existsSync(path.join(run, file)), file).toBe(true);
    }
    expect(existsSync(path.join(run, 'node_modules.bak'))).toBe(false);

    if (process.platform !== 'win32') {
      expect(modeOf(run)).toBe(0o700);
      expect(modeOf(path.join(run, 'db-backup.sqlite'))).toBe(0o600);
    }
    const snapshot = new Database(path.join(run, 'db-backup.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    const snapshotCount = snapshot.prepare('SELECT count(*) AS count FROM requests').get() as {
      count: number;
    };
    expect(snapshotCount.count).toBe(1);
    snapshot.close();

    const after = patchBody(fixture) as {
      head: string;
      http: { notificationsStatus: string };
      dbIntegrity: string;
    };
    expect(after.head).toBe(fixture.v2);
    expect(after.http.notificationsStatus).toBe('200');
    expect(after.dbIntegrity).toBe('ok');
    expect(readFileSync(path.join(fixture.clone, 'node_modules/marker.txt'), 'utf8').trim()).toBe(
      'new',
    );
  }, 30_000);

  it('reuses node_modules when the lockfile did not change', () => {
    const fixture = createFixture({ lockfileChanges: false });

    const result = runScript(fixture, ['--detach', '--health-timeout', '10']);

    expect(result.status).toBe(0);
    expect(stateOf(fixture)).toBe('success');
    expect(head(fixture.clone)).toBe(fixture.v2);
    const npm = calls(fixture, 'npm.calls').trim().split('\n');
    expect(npm).toHaveLength(1);
    expect(npm[0]).toContain('run build');
    expect(npm[0]).not.toContain('ci');
    expect(calls(fixture, 'restarts').trim()).toBe('1');
  }, 30_000);

  it('exits 0 without changes when the clone is already up to date', () => {
    const fixture = createFixture();
    git(fixture.clone, ['reset', '--hard', fixture.v2]);

    const result = runScript(fixture, []);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('already up to date');
    expect(calls(fixture, 'npm.calls')).toBe('');
    expect(calls(fixture, 'restarts')).toBe('');
    expect(existsSync(path.join(fixture.home, '.aps-cutover', 'upgrades'))).toBe(false);
  }, 30_000);

  it('rolls back in place when the build fails, without restarting', () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.root, 'fail-build'), '1\n');

    const result = runScript(fixture, ['--detach', '--health-timeout', '10']);
    const output = `${result.stdout}${result.stderr}`;

    expect(stateOf(fixture)).toBe('failed');
    expect(output).toContain('before restarting anything');
    expect(head(fixture.clone)).toBe(fixture.v1);
    expect(readFileSync(path.join(fixture.clone, 'node_modules/marker.txt'), 'utf8').trim()).toBe(
      'old',
    );
    expect(readFileSync(path.join(fixture.clone, 'src/server/dist/app.js'), 'utf8').trim()).toBe(
      'old server',
    );
    expect(calls(fixture, 'restarts')).toBe('');
    const patches = calls(fixture, 'config.patches').trim().split('\n');
    expect(patches[patches.length - 1]).toBe('{"master":{"enabled":true}}');
  }, 30_000);

  it('restarts the old build and marks rolled_back when the new build is unhealthy', () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.root, 'fail-health-once'), '1\n');

    const result = runScript(fixture, ['--detach', '--health-timeout', '3']);
    const output = `${result.stdout}${result.stderr}`;

    expect(stateOf(fixture)).toBe('rolled_back');
    expect(output).toContain('rolled back');
    expect(calls(fixture, 'restarts').trim()).toBe('2');
    expect(head(fixture.clone)).toBe(fixture.v1);

    const run = latestRun(fixture);
    expect(existsSync(path.join(run, 'db-backup.sqlite'))).toBe(true);
    expect(existsSync(path.join(run, 'dist-backup/server'))).toBe(true);
    expect(existsSync(path.join(run, 'node_modules.bak'))).toBe(true);
    expect(output).toContain('database snapshot:');
    if (process.platform !== 'win32') {
      expect(modeOf(run)).toBe(0o700);
      expect(modeOf(path.join(run, 'db-backup.sqlite'))).toBe(0o600);
    }
    const patches = calls(fixture, 'config.patches').trim().split('\n');
    expect(patches[patches.length - 1]).toBe('{"master":{"enabled":true}}');
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'keeps the run directory and snapshot owner-only under a permissive umask',
    () => {
      const fixture = createFixture();

      const result = runScript(fixture, ['--detach', '--health-timeout', '10'], 30_000, '000');

      expect(result.status).toBe(0);
      expect(stateOf(fixture)).toBe('success');
      const cutoverRoot = path.join(fixture.home, '.aps-cutover');
      const run = latestRun(fixture);
      expect(modeOf(cutoverRoot)).toBe(0o700);
      expect(modeOf(path.join(cutoverRoot, 'upgrades'))).toBe(0o700);
      expect(modeOf(run)).toBe(0o700);
      expect(modeOf(path.join(run, 'db-backup.sqlite'))).toBe(0o600);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'leaves a pre-existing cutover root at its mode',
    () => {
      const fixture = createFixture();
      const cutoverRoot = path.join(fixture.home, '.aps-cutover');
      const upgrades = path.join(cutoverRoot, 'upgrades');
      mkdirSync(upgrades, { recursive: true });
      chmodSync(cutoverRoot, 0o755);
      chmodSync(upgrades, 0o755);

      const result = runScript(fixture, ['--detach', '--health-timeout', '10'], 30_000);

      expect(result.status).toBe(0);
      expect(stateOf(fixture)).toBe('success');
      expect(modeOf(cutoverRoot)).toBe(0o755);
      expect(modeOf(upgrades)).toBe(0o755);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'creates a missing cutover root owner-only when the run directory is outside it',
    () => {
      const fixture = createFixture();
      const cutoverRoot = path.join(fixture.home, '.aps-cutover');
      const run = path.join(fixture.root, 'external-run');

      const result = runScript(
        fixture,
        ['--run', '--run-dir', run, '--health-timeout', '10'],
        30_000,
        '000',
      );

      expect(result.status).toBe(0);
      expect(stateOf(fixture)).toBe('success');
      expect(modeOf(cutoverRoot)).toBe(0o700);
      expect(modeOf(path.join(cutoverRoot, 'upgrades'))).toBe(0o700);
      expect(modeOf(run)).toBe(0o700);
      expect(latestRun(fixture)).toBe(realpathSync(run));
      expect(existsSync(path.join(cutoverRoot, 'runs'))).toBe(false);
    },
    30_000,
  );
});
