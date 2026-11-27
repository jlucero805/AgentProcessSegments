// Guard for scripts/web-stress.mjs: the stress run must never report a pass
// when the suite did not run, and it must never leave a CPU hog behind.
//
// The unit cases cover the pure argument/report/hog helpers. The entry cases
// spawn the real script with a PATH `npm` shim, so the run loop, result
// parsing, hog cleanup, and signal exit code are proven without dev
// dependencies or a real Vitest run.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE, UsageError } from './web-stress/args.mjs';
import { checkHogs, HOG_MARKER, startHogs, stopHogs } from './web-stress/hogs.mjs';
import {
  formatFailures,
  formatRunLine,
  formatSlowest,
  readResults,
  ResultsError,
  SLOWEST_LIMIT,
  summarize,
} from './web-stress/results.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(repoRoot, 'scripts', 'web-stress.mjs');

function temp(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function failingReport() {
  return {
    numTotalTestSuites: 1,
    numTotalTests: 3,
    numPassedTests: 2,
    numFailedTests: 1,
    success: false,
    testResults: [
      {
        name: '/repo/src/web/src/Example.test.tsx',
        status: 'failed',
        assertionResults: [
          {
            ancestorTitles: ['Example'],
            fullName: 'Example > slow case',
            status: 'passed',
            title: 'slow case',
            duration: 900,
            failureMessages: [],
          },
          {
            ancestorTitles: ['Example'],
            fullName: 'Example > quick case',
            status: 'passed',
            title: 'quick case',
            duration: 5,
            failureMessages: [],
          },
          {
            ancestorTitles: ['Example'],
            fullName: 'Example > broken case',
            status: 'failed',
            title: 'broken case',
            duration: 12,
            failureMessages: ['expected 1 to be 2', 'at Example.test.tsx:9:1'],
          },
        ],
      },
    ],
  };
}

function passingReport() {
  return {
    numTotalTestSuites: 1,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    success: true,
    testResults: [
      {
        name: '/repo/src/web/src/Example.test.tsx',
        status: 'passed',
        assertionResults: [
          {
            ancestorTitles: ['Example'],
            fullName: 'Example > quick case',
            status: 'passed',
            title: 'quick case',
            duration: 5,
            failureMessages: [],
          },
          {
            ancestorTitles: ['Example'],
            fullName: 'Example > slower case',
            status: 'passed',
            title: 'slower case',
            duration: 120,
            failureMessages: [],
          },
        ],
      },
    ],
  };
}

test('parseArgs returns the documented defaults', () => {
  assert.deepEqual(parseArgs([]), {
    runs: 3,
    hogs: 4,
    timeoutSeconds: 600,
    only: [],
    failFast: false,
    verbose: false,
    logDir: null,
    keepLogs: false,
    help: false,
  });
});

test('parseArgs accepts long, equal-sign, and repeated options', () => {
  const options = parseArgs([
    '--runs=5',
    '--hogs',
    '0',
    '--timeout=30',
    '--only',
    'ConfigPage',
    '--only=Board',
    '--fail-fast',
    '--verbose',
    '--log-dir',
    '/tmp/logs',
    '--keep-logs',
  ]);

  assert.deepEqual(options, {
    runs: 5,
    hogs: 0,
    timeoutSeconds: 30,
    only: ['ConfigPage', 'Board'],
    failFast: true,
    verbose: true,
    logDir: '/tmp/logs',
    keepLogs: true,
    help: false,
  });
});

test('parseArgs rejects invalid values with one-line usage errors', () => {
  const cases = [
    [['--runs', '0'], /--runs needs an integer of at least 1/],
    [['--runs', '-1'], /--runs needs an integer of at least 1/],
    [['--runs', 'abc'], /--runs needs an integer of at least 1/],
    [['--hogs', '-1'], /--hogs needs an integer of at least 0/],
    [['--timeout', '0'], /--timeout needs an integer of at least 1/],
    [['--only'], /--only needs a value/],
    [['--log-dir'], /--log-dir needs a value/],
    [['--verbose=yes'], /--verbose does not take a value/],
    [['--nope'], /unknown argument: --nope/],
    [['stray'], /unexpected argument: stray/],
  ];

  for (const [argv, expected] of cases) {
    assert.throws(
      () => parseArgs(argv),
      (error) => error instanceof UsageError && expected.test(error.message),
      `argv: ${argv.join(' ')}`,
    );
  }
});

test('parseArgs lets --help win over a bad argument', () => {
  assert.equal(parseArgs(['--help', '--runs', 'abc']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('summarize orders slow cases and collects failure messages', () => {
  const summary = summarize(failingReport());

  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.ok, false);
  assert.deepEqual(
    summary.slowest.map((item) => item.duration),
    [900, 12, 5],
  );
  assert.deepEqual(
    summary.failures.map((failure) => failure.fullName),
    ['Example > broken case'],
  );
  assert.deepEqual(summary.failures[0].messages, [
    'expected 1 to be 2',
    'at Example.test.tsx:9:1',
  ]);
});

test('summarize treats a failed suite with zero failed cases as not ok', () => {
  const summary = summarize({ ...passingReport(), success: false });
  assert.equal(summary.ok, false);
});

test('readResults fails closed on a missing, empty, malformed, or zero-test report', (t) => {
  const dir = temp(t, 'aps-web-stress-results-');
  const missing = path.join(dir, 'missing.json');
  const empty = path.join(dir, 'empty.json');
  const malformed = path.join(dir, 'malformed.json');
  const zero = path.join(dir, 'zero.json');
  writeFileSync(empty, '');
  writeFileSync(malformed, '{not json');
  writeFileSync(zero, JSON.stringify({ numTotalTests: 0, testResults: [] }));

  assert.throws(() => readResults(missing), (error) => error instanceof ResultsError);
  assert.throws(() => readResults(missing), /no results at .*\(ENOENT\)/);
  assert.throws(() => readResults(empty), /empty results at/);
  assert.throws(() => readResults(malformed), /unparsable results at/);
  assert.throws(() => readResults(zero), /the report contains no tests/);
});

test('formatRunLine names the state, counts, and slowest case', () => {
  const failed = formatRunLine({
    index: 2,
    runs: 3,
    summary: summarize(failingReport()),
    elapsedMs: 26_400,
  });
  assert.match(failed, /^run 2\/3 FAIL 26\.4s {2}2 passed, 1 failed/);
  assert.match(failed, /slowest 0\.9s Example > slow case/);

  const passed = formatRunLine({
    index: 1,
    runs: 1,
    summary: summarize(passingReport()),
    elapsedMs: 1_000,
  });
  assert.match(passed, /^run 1\/1 PASS 1\.0s {2}2 passed, 0 failed/);
});

test('formatFailures prints the failed case and its messages', () => {
  const lines = formatFailures(summarize(failingReport()));
  assert.deepEqual(lines, [
    '  FAILED Example > broken case',
    '    expected 1 to be 2',
    '    at Example.test.tsx:9:1',
  ]);
});

test('formatSlowest lists durations in order and caps the list', () => {
  const summary = summarize(failingReport());
  assert.deepEqual(formatSlowest(summary), [
    '  0.9s Example > slow case',
    '  0.0s Example > broken case',
    '  0.0s Example > quick case',
  ]);

  const report = {
    numTotalTests: 12,
    numPassedTests: 12,
    numFailedTests: 0,
    success: true,
    testResults: [
      {
        name: '/repo/src/web/src/Many.test.tsx',
        assertionResults: Array.from({ length: 12 }, (_, index) => ({
          fullName: `case ${index}`,
          status: 'passed',
          duration: 1000 - index,
          failureMessages: [],
        })),
      },
    ],
  };
  const lines = formatSlowest(summarize(report));
  assert.equal(lines.length, SLOWEST_LIMIT);
  assert.equal(lines[0], '  1.0s case 0');
  assert.equal(lines[SLOWEST_LIMIT - 1], '  1.0s case 9');
});

function fakeChild(pid) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    stderr: { on() {} },
    on() {},
  };
}

test('startHogs spawns one marked busy loop per hog', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild(200 + calls.length);
  };

  const hogs = startHogs({ count: 2, spawn, execPath: '/fake/node' });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, '/fake/node');
    assert.equal(call.args[0], '-e');
    assert.match(call.args[1], new RegExp(HOG_MARKER));
    assert.match(call.args[1], /process\.ppid !== parent/);
    assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'pipe']);
  }
  assert.deepEqual(
    hogs.children.map((child) => child.pid),
    [201, 202],
  );
});

test('checkHogs rejects a hog that exited or failed to spawn', () => {
  const hogs = { children: [fakeChild(11), fakeChild(12)], errors: new Map(), stopped: false };
  assert.doesNotThrow(() => checkHogs(hogs));

  hogs.children[1].exitCode = 3;
  assert.throws(() => checkHogs(hogs), /hog 2 \(pid 12\) exited early with exit code 3/);

  hogs.children[1].exitCode = null;
  hogs.children[1].signalCode = 'SIGKILL';
  assert.throws(() => checkHogs(hogs), /hog 2 \(pid 12\) exited early with signal SIGKILL/);

  hogs.children[1].signalCode = null;
  hogs.errors.set(hogs.children[0], new Error('spawn ENOENT'));
  assert.throws(() => checkHogs(hogs), /hog 1 could not start: spawn ENOENT/);
});

test('stopHogs SIGTERMs live hogs once and skips exited children', async () => {
  const calls = [];
  const children = [fakeChild(11), fakeChild(12)];
  children[1].exitCode = 0;
  const hogs = { children, errors: new Map(), stopped: false };
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    const child = children.find((candidate) => candidate.pid === pid);
    child.exitCode = 0;
  };

  await stopHogs(hogs, { kill, graceMs: 0, sleep: async () => {} });
  assert.deepEqual(calls, [[11, 'SIGTERM']]);

  await stopHogs(hogs, { kill, graceMs: 0, sleep: async () => {} });
  assert.deepEqual(calls, [[11, 'SIGTERM']], 'a second stop must not signal again');
});

test('stopHogs escalates to SIGKILL when SIGTERM does not land', async () => {
  const calls = [];
  const child = fakeChild(11);
  const hogs = { children: [child], errors: new Map(), stopped: false };
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 'SIGKILL') child.exitCode = 0;
  };

  await stopHogs(hogs, { kill, graceMs: 0, sleep: async () => {} });

  assert.deepEqual(calls, [
    [11, 'SIGTERM'],
    [11, 'SIGKILL'],
  ]);
});

function writeNpmShim(dir, { report = null, exitCode = 0, delayMs = 0 }) {
  const shim = path.join(dir, 'npm');
  const payload = JSON.stringify(report);
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const prefix = '--outputFile.json=';
const arg = process.argv.slice(2).find((candidate) => candidate.startsWith(prefix));
if (${payload} !== 'null' && arg) writeFileSync(arg.slice(prefix.length), ${JSON.stringify(payload)});
const finish = () => process.exit(${exitCode});
if (${delayMs} > 0) setTimeout(finish, ${delayMs});
else finish();
`,
  );
  chmodSync(shim, 0o755);
  return shim;
}

function shimHarness(t, behavior) {
  const dir = temp(t, 'aps-web-stress-shim-');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeNpmShim(bin, behavior);
  const logDir = path.join(dir, 'logs');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  return { env, logDir };
}

function runEntry(args, env) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
}

function hogPids(stdout) {
  const match = /web-stress: hog pids=([^\n]*)/.exec(stdout);
  if (!match) return [];
  return match[1]
    .trim()
    .split(/\s+/)
    .filter((value) => /^\d+$/.test(value))
    .map(Number);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidsGone(pids, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    alive = pids.filter(isAlive);
  }
  return alive;
}

async function waitFor(get, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check(get());
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the entry output');
}

test('--help prints usage and exits 0', () => {
  const result = runEntry(['--help'], process.env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/web-stress\.mjs/);
  assert.match(result.stdout, /--runs <n>/);
  assert.equal(result.stderr, '');
});

test('an invalid flag exits 2 with one stderr line and no stack', () => {
  const result = runEntry(['--hogs', 'nope'], process.env);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /web-stress: --hogs needs an integer of at least 0/);
  assert.match(result.stderr, new RegExp(USAGE.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test(
  'a passing iteration reports PASS, keeps an explicit log dir, and reaps its hogs',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, logDir } = shimHarness(t, { report: passingReport() });

    const result = runEntry(['--runs', '1', '--hogs', '1', '--log-dir', logDir], env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /web-stress: PASS \(1\/1 runs, hogs alive throughout\)/);
    assert.match(result.stdout, /run 1\/1 PASS /);
    const pids = hogPids(result.stdout);
    assert.equal(pids.length, 1);
    assert.deepEqual(await waitForPidsGone(pids), []);
    // An explicit --log-dir is never deleted; an all-pass run removes its runs.
    assert.equal(existsSync(logDir), true);
    assert.equal(existsSync(path.join(logDir, 'run-1')), false);
  },
);

test(
  'a failing iteration exits 1 and names the failed case',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, logDir } = shimHarness(t, { report: failingReport(), exitCode: 1 });

    const result = runEntry(['--runs', '1', '--hogs', '1', '--log-dir', logDir], env);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /run 1\/1 FAIL /);
    assert.match(result.stdout, /FAILED Example > broken case/);
    assert.match(result.stdout, /expected 1 to be 2/);
    assert.match(result.stdout, /web-stress: FAIL \(1 failing run\)/);
    assert.equal(existsSync(path.join(logDir, 'run-1', 'results.json')), true);
    assert.deepEqual(await waitForPidsGone(hogPids(result.stdout)), []);
  },
);

test(
  'a missing report is a failure, never a pass',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, logDir } = shimHarness(t, { report: null, exitCode: 0 });

    const result = runEntry(['--runs', '1', '--hogs', '0', '--log-dir', logDir], env);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /no parsable results/);
    assert.match(result.stdout, /web-stress: FAIL/);
    assert.doesNotMatch(result.stdout, /web-stress: PASS/);
  },
);

test(
  'SIGINT cleans up and exits 130 without leaving a hog behind',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, logDir } = shimHarness(t, { report: null, exitCode: 0, delayMs: 30_000 });
    const child = spawn(
      process.execPath,
      [entry, '--runs', '1', '--hogs', '2', '--log-dir', logDir, '--timeout', '60'],
      { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));

    const pids = await waitFor(
      () => stdout,
      (text) => {
        const found = hogPids(text);
        return found.length === 2 ? found : undefined;
      },
    );
    child.kill('SIGINT');
    const status = await closed;

    assert.equal(status, 130, stderr);
    assert.match(stderr, /interrupted by SIGINT; cleaning up/);
    assert.deepEqual(await waitForPidsGone(pids), []);
  },
);
