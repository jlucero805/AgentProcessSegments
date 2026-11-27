// Offline guard for scripts/grant-github-scope.mjs. Classification uses the same
// fixtures as the preflight; the refresh is injected except for the POSIX spawn
// cases, which use a fake `gh` on a temp path. No test touches the network or a
// real token.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  runRefresh,
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

function runMain(argv, deps) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = main(argv, deps);
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function neverRefresh() {
  throw new Error('refresh must not run');
}

test('decide separates ok, refresh, manual, and blocked', () => {
  assert.equal(decide(classic('gist, read:org, repo, workflow'), false), 'ok');
  assert.equal(decide(classic('gist, read:org, repo'), false), 'manual');
  assert.equal(decide(classic('gist, read:org, repo'), true), 'refresh');
  assert.equal(decide(classic(null), true), 'blocked');
  assert.equal(
    decide(classify({ status: 1, stderr: 'HTTP 401: Bad credentials' }), true),
    'blocked',
  );
});

test('buildRefreshArgs asks for workflow first and adds repo only when missing', () => {
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

test('isInteractive requires both stdin and stdout to be a TTY', () => {
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
  assert.equal(isInteractive({ stdin: { isTTY: false }, stdout: { isTTY: true } }), false);
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: {} }), false);
  assert.equal(isInteractive({ stdin: {}, stdout: {} }), false);
});

test('parseArgs validates --host and rejects unknown arguments', () => {
  assert.deepEqual(parseArgs([]), { host: 'github.com', help: false });
  assert.deepEqual(parseArgs(['--host=gh.example.com']), {
    host: 'gh.example.com',
    help: false,
  });
  assert.deepEqual(parseArgs(['--host', 'gh.example.com', '--help']), {
    host: 'gh.example.com',
    help: true,
  });
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--host']), UsageError);
  assert.throws(() => parseArgs(['--host=']), UsageError);
  assert.throws(() => parseArgs(['extra']), UsageError);
});

test('an already-scoped credential exits 0 without refreshing', () => {
  const probeFn = sequence([classic('gist, read:org, repo, workflow')]);
  const result = runMain([], { probe: probeFn, refresh: neverRefresh, interactive: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /OK: this credential can push/);
  assert.equal(probeFn.calls.length, 1);
});

test('a non-interactive shell prints the operator command instead of blocking', () => {
  const probeFn = sequence([classic('gist, read:org, repo')]);
  const result = runMain([], { probe: probeFn, refresh: neverRefresh, interactive: false });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL: missing scope\(s\): workflow/);
  assert.match(result.stdout, /gh auth refresh -h github\.com -s workflow/);
  assert.match(result.stdout, /npm run grant:github-scope -- --host github\.com/);
  assert.match(result.stdout, /not interactive/);
  assert.match(result.stdout, /Do not add a deploy key/);
  assert.equal(probeFn.calls.length, 1);
});

test('an interactive review runs the refresh and re-verifies', () => {
  const probeFn = sequence([classic('gist, read:org, repo'), classic('gist, read:org, repo, workflow')]);
  const calls = [];
  const refresh = (host, options) => {
    calls.push([host, options]);
    return { status: 0 };
  };
  const result = runMain([], { probe: probeFn, refresh, interactive: true });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [['github.com', { missing: ['workflow'] }]]);
  assert.deepEqual(probeFn.calls, ['github.com', 'github.com']);
  assert.match(result.stdout, /running `gh auth refresh`/);
  assert.match(result.stdout, /OK: this credential can push/);
});

test('a missing repo scope is refreshed too', () => {
  const probeFn = sequence([classic('gist, workflow'), classic('gist, repo, workflow')]);
  const calls = [];
  const refresh = (host, options) => {
    calls.push([host, options]);
    return { status: 0 };
  };
  const result = runMain([], { probe: probeFn, refresh, interactive: true });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [['github.com', { missing: ['repo'] }]]);
});

test('a declined refresh keeps exit 1 and says the scope was not granted', () => {
  const result = runMain([], {
    probe: sequence([classic('gist, read:org, repo')]),
    refresh: () => ({ status: 1 }),
    interactive: true,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with status 1/);
  assert.match(result.stderr, /scope not granted/);
});

test('a refresh spawn failure exits 2 without leaking a token', () => {
  const result = runMain([], {
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

test('a fine-grained token is not refreshed and exits 2', () => {
  const probeFn = sequence([classic(null)]);
  const result = runMain([], { probe: probeFn, refresh: neverRefresh, interactive: true });
  assert.equal(result.code, 2);
  assert.match(result.stdout, /UNKNOWN: .*Workflows: Read and write/);
});

test('an unauthenticated probe exits 2 and points at gh auth login', () => {
  const unauthenticated = classify({ status: 1, stderr: 'HTTP 401: Bad credentials\n' });
  const result = runMain([], {
    probe: sequence([unauthenticated]),
    refresh: neverRefresh,
    interactive: true,
  });
  assert.equal(result.code, 2);
  assert.match(result.stdout, /gh auth login/);
});

test('--host is forwarded to the probe and the refresh', () => {
  const probeFn = sequence([classic('gist, read:org, repo')]);
  const result = runMain(['--host', 'ghe.example.com'], {
    probe: probeFn,
    refresh: neverRefresh,
    interactive: false,
  });
  assert.equal(result.code, 1);
  assert.deepEqual(probeFn.calls, ['ghe.example.com']);
  assert.match(result.stdout, /gh auth refresh -h ghe\.example\.com -s workflow/);
});

test('--help prints usage without probing', () => {
  const result = runMain(['--help'], { probe: neverRefresh, interactive: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: node scripts\/grant-github-scope\.mjs/);
});

test('an unknown option exits 2 with usage and does not probe', () => {
  const result = runMain(['--nope'], { probe: neverRefresh, interactive: false });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option: --nope/);
  assert.match(result.stderr, /Usage:/);
});

test('runRefresh spawns gh auth refresh with the missing scopes', posixOnly, () => {
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

test('runRefresh reports a missing gh binary as ENOENT', posixOnly, () => {
  const run = runRefresh('github.com', {
    bin: path.join(dir, 'does-not-exist'),
    missing: ['workflow'],
  });
  assert.equal(run.status, null);
  assert.equal(run.error.code, 'ENOENT');
});
