// Offline guard for scripts/grant-github-scope.mjs. Classification uses the same
// fixtures as the preflight; the refresh is injected except for the POSIX spawn
// cases, which use a fake `gh` on a temp path. No test touches the network or a
// real token.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { classify, UsageError } from './check-github-scope.mjs';
import {
  buildRefreshArgs,
  decide,
  isInteractive,
  main,
  parseArgs,
  parseDeviceHandoff,
  runRefresh,
  startHandoff,
} from './grant-github-scope.mjs';

const posixOnly = { skip: process.platform === 'win32' };
const DECOY_TOKEN = 'gho_notreal0123456789abcdef';

let dir;
let gh;

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aps-gh-grant-'));
  gh = path.join(dir, 'gh');
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ -n "$FAKE_GH_ARGS_FILE" ]; then',
      '  printf \'%s\\n\' "$@" > "$FAKE_GH_ARGS_FILE"',
      'fi',
      'exit "${FAKE_GH_STATUS:-0}"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(gh, 0o755);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function headerBlock(scopes) {
  return [
    'HTTP/2.0 200 OK',
    ...(scopes === null ? [] : [`X-Oauth-Scopes: ${scopes}`]),
    '',
    '{"login":"octocat"}',
    '',
  ].join('\n');
}

function classic(scopes) {
  return classify({ status: 0, stdout: headerBlock(scopes) });
}

function sequence(results) {
  const calls = [];
  const fn = (host) => {
    calls.push(host);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

async function runMain(argv, deps) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = await main(argv, deps);
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function neverRefresh() {
  throw new Error('refresh must not run');
}

function handoffDir(name) {
  const target = path.join(dir, name);
  mkdirSync(target, { recursive: true });
  return target;
}

function fakeScript(name, lines) {
  const file = path.join(dir, name);
  writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function successScript() {
  return fakeScript('gh-handoff-ok', [
    "printf '%s\\n' '! First copy your one-time code: ABCD-1234' >&2",
    "printf '%s\\n' 'Open this URL to continue in your web browser: https://github.com/login/device' >&2",
    'exec sleep 30',
  ]);
}

function killQuietly(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

test('decide separates ok, refresh, manual, and blocked', async () => {
  assert.equal(decide(classic('gist, read:org, repo, workflow'), false), 'ok');
  assert.equal(decide(classic('gist, read:org, repo'), false), 'manual');
  assert.equal(decide(classic('gist, read:org, repo'), true), 'refresh');
  assert.equal(decide(classic(null), true), 'blocked');
  assert.equal(
    decide(classify({ status: 1, stderr: 'HTTP 401: Bad credentials' }), true),
    'blocked',
  );
});

test('buildRefreshArgs asks for workflow first and adds repo only when missing', async () => {
  assert.deepEqual(buildRefreshArgs('github.com', ['workflow']), [
    'auth',
    'refresh',
    '-h',
    'github.com',
    '-s',
    'workflow',
  ]);
  assert.deepEqual(buildRefreshArgs('ghe.example.com', ['repo', 'workflow']), [
    'auth',
    'refresh',
    '-h',
    'ghe.example.com',
    '-s',
    'workflow',
    '-s',
    'repo',
  ]);
});

test('isInteractive requires both stdin and stdout to be a TTY', async () => {
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
  assert.equal(isInteractive({ stdin: { isTTY: false }, stdout: { isTTY: true } }), false);
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: {} }), false);
  assert.equal(isInteractive({ stdin: {}, stdout: {} }), false);
});

test('parseArgs validates --host and --device-code-file', async () => {
  assert.deepEqual(parseArgs([]), {
    host: 'github.com',
    deviceCodeFile: null,
    help: false,
  });
  assert.deepEqual(parseArgs(['--host=gh.example.com']), {
    host: 'gh.example.com',
    deviceCodeFile: null,
    help: false,
  });
  assert.deepEqual(parseArgs(['--host', 'gh.example.com', '--help']), {
    host: 'gh.example.com',
    deviceCodeFile: null,
    help: true,
  });
  assert.deepEqual(parseArgs(['--device-code-file', '/tmp/device.json']), {
    host: 'github.com',
    deviceCodeFile: '/tmp/device.json',
    help: false,
  });
  assert.deepEqual(parseArgs(['--device-code-file=/tmp/device.json']), {
    host: 'github.com',
    deviceCodeFile: '/tmp/device.json',
    help: false,
  });
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--host']), UsageError);
  assert.throws(() => parseArgs(['--host=']), UsageError);
  assert.throws(() => parseArgs(['--device-code-file']), UsageError);
  assert.throws(() => parseArgs(['--device-code-file=']), UsageError);
  assert.throws(() => parseArgs(['extra']), UsageError);
});

test('parseDeviceHandoff reads the code and URL through ANSI color', async () => {
  assert.deepEqual(
    parseDeviceHandoff(
      [
        '\x1b[33m!\x1b[0m First copy your one-time code: ABCD-1234',
        'Open this URL to continue in your web browser: https://github.com/login/device',
        '',
      ].join('\n'),
    ),
    { code: 'ABCD-1234', url: 'https://github.com/login/device' },
  );
  assert.deepEqual(
    parseDeviceHandoff(
      [
        'First, copy your one-time code: WXYZ-9876',
        'Open this URL to continue in your web browser: https://ghe.example.com/login/device',
      ].join('\n'),
    ),
    { code: 'WXYZ-9876', url: 'https://ghe.example.com/login/device' },
  );
  assert.equal(parseDeviceHandoff('one-time code: ABCD-1234'), null);
  assert.equal(parseDeviceHandoff('https://github.com/login/device'), null);
  assert.equal(parseDeviceHandoff(''), null);
});

test('an already-scoped credential exits 0 without refreshing', async () => {
  const probeFn = sequence([classic('gist, read:org, repo, workflow')]);
  const result = await runMain([], { probe: probeFn, refresh: neverRefresh, interactive: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /OK: this credential can push/);
  assert.equal(probeFn.calls.length, 1);
});

test('a non-interactive shell prints the operator command instead of blocking', async () => {
  const probeFn = sequence([classic('gist, read:org, repo')]);
  const result = await runMain([], { probe: probeFn, refresh: neverRefresh, interactive: false });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL: missing scope\(s\): workflow/);
  assert.match(result.stdout, /gh auth refresh -h github\.com -s workflow/);
  assert.match(result.stdout, /npm run grant:github-scope -- --host github\.com/);
  assert.match(result.stdout, /--device-code-file \/tmp\/gh-device\.json/);
  assert.match(result.stdout, /not interactive/);
  assert.match(result.stdout, /Do not add a deploy key/);
  assert.equal(probeFn.calls.length, 1);
});

test('--device-code-file starts a handoff from a non-interactive shell', async () => {
  const calls = [];
  const handoff = async (host, missing, file, options) => {
    calls.push([host, missing, file, options]);
    return {
      ok: true,
      reused: false,
      handoff: {
        host,
        url: 'https://github.com/login/device',
        code: 'ABCD-1234',
        scopes: missing,
        pid: 4321,
        log: `${file}.log`,
        startedAt: '2026-11-27T18:00:00.000Z',
      },
    };
  };
  const result = await runMain(['--device-code-file', '/tmp/device.json'], {
    probe: sequence([classic('gist, read:org, repo')]),
    refresh: neverRefresh,
    handoff,
    interactive: false,
  });
  assert.equal(result.code, 3);
  assert.deepEqual(
    calls.map(([host, missing, file]) => [host, missing, file]),
    [['github.com', ['workflow'], '/tmp/device.json']],
  );
  assert.match(result.stdout, /approval pending/);
  assert.match(result.stdout, /code: ABCD-1234/);
  assert.match(result.stdout, /verify with `npm run check:github-scope`/);
});

test('--device-code-file is async even in a terminal', async () => {
  const calls = [];
  const result = await runMain(['--device-code-file=/tmp/device.json'], {
    probe: sequence([classic('gist, read:org, repo')]),
    refresh: neverRefresh,
    handoff: async (host, missing, file) => {
      calls.push(file);
      return {
        ok: true,
        reused: true,
        handoff: {
          host,
          url: 'https://github.com/login/device',
          code: 'WXYZ-9876',
          scopes: missing,
          pid: process.pid,
          log: `${file}.log`,
          startedAt: '2026-11-27T18:00:00.000Z',
        },
      };
    },
    interactive: true,
  });
  assert.equal(result.code, 3);
  assert.deepEqual(calls, ['/tmp/device.json']);
  assert.match(result.stdout, /already exists/);
});

test('--device-code-file does not start a flow when the credential is complete', async () => {
  const result = await runMain(['--device-code-file', '/tmp/device.json'], {
    probe: sequence([classic('gist, read:org, repo, workflow')]),
    refresh: neverRefresh,
    handoff: neverRefresh,
    interactive: false,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /OK: this credential can push/);
});

test('--device-code-file does not start a flow for a fine-grained token', async () => {
  const result = await runMain(['--device-code-file', '/tmp/device.json'], {
    probe: sequence([classic(null)]),
    refresh: neverRefresh,
    handoff: neverRefresh,
    interactive: false,
  });
  assert.equal(result.code, 2);
  assert.match(result.stdout, /UNKNOWN: .*Workflows: Read and write/);
});

test('a failed handoff exits 2 and redacts the reason and log tail', async () => {
  const log = path.join(dir, 'failed-handoff.log');
  writeFileSync(log, `${DECOY_TOKEN}\nboom\n`);
  const result = await runMain(['--device-code-file', '/tmp/device.json'], {
    probe: sequence([classic('gist, read:org, repo')]),
    refresh: neverRefresh,
    handoff: async () => ({ ok: false, reason: `cannot run ${DECOY_TOKEN}`, log }),
    interactive: false,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /scope not granted/);
  assert.match(result.stderr, /boom/);
  assert.doesNotMatch(result.stderr, /gho_notreal/);
});

test('an interactive review runs the refresh and re-verifies', async () => {
  const probeFn = sequence([classic('gist, read:org, repo'), classic('gist, read:org, repo, workflow')]);
  const calls = [];
  const refresh = (host, options) => {
    calls.push([host, options]);
    return { status: 0 };
  };
  const result = await runMain([], { probe: probeFn, refresh, interactive: true });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [['github.com', { missing: ['workflow'] }]]);
  assert.deepEqual(probeFn.calls, ['github.com', 'github.com']);
  assert.match(result.stdout, /running `gh auth refresh`/);
  assert.match(result.stdout, /OK: this credential can push/);
});

test('a missing repo scope is refreshed too', async () => {
  const probeFn = sequence([classic('gist, workflow'), classic('gist, repo, workflow')]);
  const calls = [];
  const refresh = (host, options) => {
    calls.push([host, options]);
    return { status: 0 };
  };
  const result = await runMain([], { probe: probeFn, refresh, interactive: true });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [['github.com', { missing: ['repo'] }]]);
});

test('a declined refresh keeps exit 1 and says the scope was not granted', async () => {
  const result = await runMain([], {
    probe: sequence([classic('gist, read:org, repo')]),
    refresh: () => ({ status: 1 }),
    interactive: true,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with status 1/);
  assert.match(result.stderr, /scope not granted/);
});

test('a refresh spawn failure exits 2 without leaking a token', async () => {
  const result = await runMain([], {
    probe: sequence([classic('gist, read:org, repo')]),
    refresh: () => ({
      error: Object.assign(new Error(`spawn gh ENOENT ${DECOY_TOKEN}`), { code: 'ENOENT' }),
      status: null,
    }),
    interactive: true,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /gho_notreal/);
});

test('a fine-grained token is not refreshed and exits 2', async () => {
  const probeFn = sequence([classic(null)]);
  const result = await runMain([], { probe: probeFn, refresh: neverRefresh, interactive: true });
  assert.equal(result.code, 2);
  assert.match(result.stdout, /UNKNOWN: .*Workflows: Read and write/);
});

test('an unauthenticated probe exits 2 and points at gh auth login', async () => {
  const unauthenticated = classify({ status: 1, stderr: 'HTTP 401: Bad credentials\n' });
  const result = await runMain([], {
    probe: sequence([unauthenticated]),
    refresh: neverRefresh,
    interactive: true,
  });
  assert.equal(result.code, 2);
  assert.match(result.stdout, /gh auth login/);
});

test('--host is forwarded to the probe and the refresh', async () => {
  const probeFn = sequence([classic('gist, read:org, repo')]);
  const result = await runMain(['--host', 'ghe.example.com'], {
    probe: probeFn,
    refresh: neverRefresh,
    interactive: false,
  });
  assert.equal(result.code, 1);
  assert.deepEqual(probeFn.calls, ['ghe.example.com']);
  assert.match(result.stdout, /gh auth refresh -h ghe\.example\.com -s workflow/);
});

test('--help prints usage without probing', async () => {
  const result = await runMain(['--help'], { probe: neverRefresh, interactive: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: node scripts\/grant-github-scope\.mjs/);
  assert.match(result.stdout, /--device-code-file <path>/);
  assert.match(result.stdout, /3 = device-flow handoff written/);
});

test('an unknown option exits 2 with usage and does not probe', async () => {
  const result = await runMain(['--nope'], { probe: neverRefresh, interactive: false });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option: --nope/);
  assert.match(result.stderr, /Usage:/);
});

test('runRefresh spawns gh auth refresh with the missing scopes', posixOnly, async () => {
  const argsFile = path.join(dir, 'refresh-args.txt');
  process.env.FAKE_GH_ARGS_FILE = argsFile;
  try {
    const run = runRefresh('github.com', { bin: gh, missing: ['workflow'] });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0);
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
      'auth',
      'refresh',
      '-h',
      'github.com',
      '-s',
      'workflow',
    ]);
  } finally {
    delete process.env.FAKE_GH_ARGS_FILE;
  }
});

test('runRefresh reports a missing gh binary as ENOENT', posixOnly, async () => {
  const run = runRefresh('github.com', {
    bin: path.join(dir, 'does-not-exist'),
    missing: ['workflow'],
  });
  assert.equal(run.status, null);
  assert.equal(run.error.code, 'ENOENT');
});

test('startHandoff writes a 0600 handoff and leaves gh polling', posixOnly, async () => {
  const work = handoffDir('handoff-ok');
  const target = path.join(work, 'device.json');
  const bin = successScript();
  let handoff;
  try {
    const result = await startHandoff('github.com', ['workflow'], target, {
      bin,
      timeoutMs: 5000,
      pollMs: 20,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    handoff = result.handoff;
    assert.equal(handoff.host, 'github.com');
    assert.equal(handoff.code, 'ABCD-1234');
    assert.equal(handoff.url, 'https://github.com/login/device');
    assert.deepEqual(handoff.scopes, ['workflow']);
    assert.equal(handoff.log, `${target}.log`);
    assert.match(handoff.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(statSync(handoff.log).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), handoff);
    assert.deepEqual(readdirSync(work).sort(), ['device.json', 'device.json.log']);
    assert.doesNotThrow(() => process.kill(handoff.pid, 0));
  } finally {
    killQuietly(handoff?.pid);
  }
});

test('startHandoff repairs a pre-existing 0644 handoff and log', posixOnly, async () => {
  const work = handoffDir('handoff-repair');
  const target = path.join(work, 'device.json');
  writeFileSync(target, '{}\n', { mode: 0o644 });
  chmodSync(target, 0o644);
  writeFileSync(`${target}.log`, 'stale\n', { mode: 0o644 });
  chmodSync(`${target}.log`, 0o644);
  let handoff;
  try {
    const result = await startHandoff('github.com', ['workflow'], target, {
      bin: successScript(),
      timeoutMs: 5000,
      pollMs: 20,
    });
    assert.equal(result.ok, true);
    handoff = result.handoff;
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(statSync(`${target}.log`).mode & 0o777, 0o600);
  } finally {
    killQuietly(handoff?.pid);
  }
});

test('startHandoff times out, kills gh, and leaves no handoff', posixOnly, async () => {
  const work = handoffDir('handoff-timeout');
  const target = path.join(work, 'device.json');
  const bin = fakeScript('gh-handoff-silent', ['exec sleep 30']);
  const result = await startHandoff('github.com', ['workflow'], target, {
    bin,
    timeoutMs: 250,
    pollMs: 20,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out after 250 ms/);
  assert.equal(existsSync(target), false);
});

test('startHandoff reports gh exiting before the code', posixOnly, async () => {
  const work = handoffDir('handoff-early');
  const target = path.join(work, 'device.json');
  const bin = fakeScript('gh-handoff-early', ['exit 7']);
  const result = await startHandoff('github.com', ['workflow'], target, {
    bin,
    timeoutMs: 2000,
    pollMs: 20,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exited before printing a device code \(7\)/);
  assert.equal(existsSync(target), false);
});

test('startHandoff reports a missing binary without writing a handoff', async () => {
  const work = handoffDir('handoff-missing');
  const target = path.join(work, 'device.json');
  const result = await startHandoff('github.com', ['workflow'], target, {
    bin: path.join(work, 'does-not-exist'),
    timeoutMs: 2000,
    pollMs: 20,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not run gh \(ENOENT\)/);
  assert.equal(existsSync(target), false);
});

test('startHandoff refuses a missing parent directory', async () => {
  const work = handoffDir('handoff-nodir');
  const result = await startHandoff(
    'github.com',
    ['workflow'],
    path.join(work, 'nested', 'device.json'),
    { spawn: neverRefresh },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /parent directory does not exist/);
});

test('startHandoff reuses a live pending handoff without spawning', async () => {
  const work = handoffDir('handoff-live');
  const target = path.join(work, 'device.json');
  const pending = {
    host: 'github.com',
    url: 'https://github.com/login/device',
    code: 'WXYZ-9876',
    scopes: ['workflow'],
    pid: process.pid,
    log: `${target}.log`,
    startedAt: '2026-11-27T18:00:00.000Z',
  };
  writeFileSync(target, `${JSON.stringify(pending)}\n`);
  const result = await startHandoff('github.com', ['workflow'], target, {
    spawn: neverRefresh,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.deepEqual(result.handoff, pending);
});

test('startHandoff replaces a dead handoff', posixOnly, async () => {
  const work = handoffDir('handoff-dead');
  const target = path.join(work, 'device.json');
  writeFileSync(
    target,
    `${JSON.stringify({
      host: 'github.com',
      url: 'https://github.com/login/device',
      code: 'OLD0-CODE',
      scopes: ['workflow'],
      pid: 999999,
      log: `${target}.log`,
      startedAt: '2026-11-20T18:00:00.000Z',
    })}\n`,
  );
  let handoff;
  try {
    const result = await startHandoff('github.com', ['workflow'], target, {
      bin: successScript(),
      isPidAlive: () => false,
      timeoutMs: 5000,
      pollMs: 20,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    handoff = result.handoff;
    assert.equal(handoff.code, 'ABCD-1234');
  } finally {
    killQuietly(handoff?.pid);
  }
});
