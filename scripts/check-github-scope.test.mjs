// Offline guard for scripts/check-github-scope.mjs. A fake `gh` on GH_BIN feeds
// canned `gh api -i user` responses, so no test touches the network, a real
// token, or the host gh config.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classify,
  formatHuman,
  parseArgs,
  parseHeaders,
  parseScopes,
  redact,
  UsageError,
} from './check-github-scope.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = path.join(repoRoot, 'scripts', 'check-github-scope.mjs');
const posixOnly = { skip: process.platform === 'win32' };
const DECOY_TOKEN = 'gho_notreal0123456789abcdef';

let dir;
let gh;
let sequence = 0;

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aps-gh-scope-'));
  gh = path.join(dir, 'gh');
  // One generic fake: stdout/stderr/status and the argv capture come from env,
  // so each case is a fixture rather than another shell script.
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ -n "$FAKE_GH_ARGS_FILE" ]; then',
      '  printf \'%s\\n\' "$@" > "$FAKE_GH_ARGS_FILE"',
      'fi',
      'if [ -n "$FAKE_GH_STDOUT_FILE" ]; then',
      '  cat "$FAKE_GH_STDOUT_FILE"',
      'fi',
      'if [ -n "$FAKE_GH_STDERR" ]; then',
      '  printf \'%s\' "$FAKE_GH_STDERR" >&2',
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

// A realistic `gh api -i user` header block. `scopes === null` omits the
// X-Oauth-Scopes header, which is how GitHub presents fine-grained tokens.
function headerBlock(scopes, { statusLine = 'HTTP/2.0 200 OK' } = {}) {
  return [
    statusLine,
    'Content-Type: application/json; charset=utf-8',
    ...(scopes === null ? [] : [`X-Oauth-Scopes: ${scopes}`]),
    `Authorization: token ${DECOY_TOKEN}`,
    'Date: Fri, 27 Nov 2026 03:30:12 GMT',
    '',
    '{"login":"octocat"}',
    '',
  ].join('\n');
}

function runCli(args, { stdout = '', stderr = '', status = 0, ghBin = gh } = {}) {
  const id = (sequence += 1);
  const stdoutFile = path.join(dir, `stdout-${id}.txt`);
  const argsFile = path.join(dir, `args-${id}.txt`);
  writeFileSync(stdoutFile, stdout);

  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_BIN: ghBin,
      FAKE_GH_STDOUT_FILE: stdoutFile,
      FAKE_GH_STDERR: stderr,
      FAKE_GH_STATUS: String(status),
      FAKE_GH_ARGS_FILE: argsFile,
    },
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`);
  return { ...result, argsFile };
}

function parseJsonOutput(result) {
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one JSON line, got: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

test('a classic token with workflow and repo passes', posixOnly, () => {
  const result = runCli([], { stdout: headerBlock('gist, read:org, repo, workflow') });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /credential: classic/);
  assert.match(result.stdout, /OK: this credential can push .*\.github\/workflows/);
  assert.equal(result.stderr, '');

  const json = parseJsonOutput(
    runCli(['--json'], { stdout: headerBlock('gist, read:org, repo, workflow') }),
  );
  assert.deepEqual(json, {
    host: 'github.com',
    kind: 'classic',
    scopes: ['gist', 'read:org', 'repo', 'workflow'],
    missing: [],
    workflow: true,
    verdict: 'ok',
    exitCode: 0,
  });
});

test('a classic token without workflow fails with the remediation', posixOnly, () => {
  const result = runCli([], { stdout: headerBlock('gist, read:org, repo') });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL: missing scope\(s\): workflow/);
  assert.match(result.stdout, /refusing to allow an OAuth App to create or update workflow/);
  assert.match(result.stdout, /gh auth refresh -h github\.com -s workflow/);
  assert.match(result.stdout, /GH_TOKEN/);
  assert.match(result.stdout, /Do not add a deploy key/);
  assert.equal(result.stderr, '');

  const json = parseJsonOutput(
    runCli(['--json'], { stdout: headerBlock('gist, read:org, repo') }),
  );
  assert.equal(json.verdict, 'missing-scope');
  assert.deepEqual(json.missing, ['workflow']);
  assert.equal(json.workflow, false);
  assert.equal(json.exitCode, 1);
});

test('workflow without repo write access fails and names repo', posixOnly, () => {
  const result = runCli([], { stdout: headerBlock('read:org, workflow') });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL: missing scope\(s\): repo \(or public_repo\)/);

  const json = parseJsonOutput(runCli(['--json'], { stdout: headerBlock('read:org, workflow') }));
  assert.deepEqual(json.missing, ['repo']);
  assert.equal(json.workflow, true);
});

test('public_repo plus workflow passes', posixOnly, () => {
  const result = runCli([], { stdout: headerBlock('public_repo, workflow') });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OK/);
});

test('a fine-grained token is unclassified, not failed', posixOnly, () => {
  const result = runCli([], { stdout: headerBlock(null) });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /credential: fine-grained/);
  assert.match(result.stdout, /UNKNOWN: .*Workflows: Read and write/);
  assert.match(result.stdout, /exit 2 is not a green light/);

  const json = parseJsonOutput(runCli(['--json'], { stdout: headerBlock(null) }));
  assert.equal(json.kind, 'fine-grained');
  assert.equal(json.verdict, 'unknown');
  assert.equal(json.workflow, null);
  assert.equal(json.exitCode, 2);
});

test('a 401 is reported as unauthenticated', posixOnly, () => {
  const result = runCli([], {
    status: 1,
    stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)\n',
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /UNKNOWN: gh is not authenticated/);

  const json = parseJsonOutput(
    runCli(['--json'], {
      status: 1,
      stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)\n',
    }),
  );
  assert.equal(json.kind, 'unauthenticated');
  assert.equal(json.exitCode, 2);
});

test('a missing gh binary exits 2 with the GH_BIN hint', () => {
  const result = runCli([], { ghBin: path.join(dir, 'does-not-exist') });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /gh CLI not found \(set GH_BIN to override\)/);
});

test('--json emits one line and never echoes a token', posixOnly, () => {
  const result = runCli(['--json'], { stdout: headerBlock('gist, read:org, repo') });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(result.stdout, /gho_notreal/);
  assert.doesNotMatch(result.stderr, /gho_notreal/);
});

test('--host is forwarded to gh', posixOnly, () => {
  const result = runCli(['--host', 'ghe.example.com'], {
    stdout: headerBlock('repo, workflow'),
  });
  assert.equal(result.status, 0);
  const argv = readFileSync(result.argsFile, 'utf8').trim().split('\n');
  assert.deepEqual(argv, ['api', '-i', 'user', '--hostname', 'ghe.example.com']);
});

test('parseHeaders reads the block, not the body, and tolerates CRLF', () => {
  const headers = parseHeaders(
    [
      'HTTP/1.1 200 OK',
      'X-Oauth-Scopes: repo, workflow',
      'Date: Fri, 27 Nov 2026 03:30:12 GMT',
      'X-Oauth-Scopes: gist',
      '',
      'X-Oauth-Scopes: body-line-must-not-win',
    ].join('\r\n'),
  );
  assert.deepEqual(headers.get('x-oauth-scopes'), ['repo, workflow', 'gist']);
  assert.deepEqual(headers.get('date'), ['Fri, 27 Nov 2026 03:30:12 GMT']);
});

test('parseScopes normalizes case, padding, duplicates, and empties', () => {
  assert.deepEqual(parseScopes(['Workflow, repo']), ['repo', 'workflow']);
  assert.deepEqual(parseScopes(['  gist ,, read:org  ']), ['gist', 'read:org']);
  assert.deepEqual(parseScopes(['repo', 'repo']), ['repo']);
  assert.deepEqual(parseScopes([]), []);
  assert.deepEqual(parseScopes(undefined), []);
  assert.deepEqual(parseScopes(['']), []);
});

test('classify covers empty scopes, failures, and redaction', () => {
  const empty = classify({
    status: 0,
    stdout: ['HTTP/2.0 200 OK', 'X-Oauth-Scopes:', '', ''].join('\n'),
  });
  assert.equal(empty.kind, 'classic');
  assert.deepEqual(empty.missing, ['repo', 'workflow']);
  assert.equal(empty.exitCode, 1);

  const failed = classify({ status: 1, stderr: `boom ${DECOY_TOKEN}\n` });
  assert.equal(failed.kind, 'unavailable');
  assert.equal(failed.exitCode, 2);
  assert.doesNotMatch(failed.reason, /gho_notreal/);

  const enoent = classify({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) });
  assert.equal(enoent.exitCode, 2);
  assert.match(enoent.reason, /GH_BIN/);

  assert.deepEqual(parseArgs([]), { host: 'github.com', json: false, help: false });
  assert.deepEqual(parseArgs(['--host=gh.example.com', '--json']), {
    host: 'gh.example.com',
    json: true,
    help: false,
  });
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--host']), UsageError);
  assert.throws(() => parseArgs(['extra']), UsageError);

  assert.equal(redact(`token ${DECOY_TOKEN}`), 'token [redacted]');
});

test('formatHuman renders the classic failure verdict', () => {
  const result = classify({ status: 0, stdout: headerBlock('repo') });
  assert.match(formatHuman(result, 'github.com'), /FAIL: missing scope\(s\): workflow/);
});
