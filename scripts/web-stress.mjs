#!/usr/bin/env node
// Stress-run a Vitest workspace suite under competing CPU load.
//
//   npm run test:web-stress
//   npm run test:server-stress
//   node scripts/web-stress.mjs --suite server --runs 5 --hogs 8 --verbose
//
// Fails closed: a failed iteration, a hog that exited early, a per-iteration
// timeout, or a missing Vitest JSON report is a non-zero exit, never a pass.
// Hogs are reaped on every exit path, and each hog exits by itself when this
// process disappears (even after SIGKILL).
//
// The suite child runs in its own process group so a timeout or an interrupt
// kills npm, its shell, and the Vitest workers together. A filtered run
// (--only) is useful while iterating but is not a full-suite proof.
import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPinnedEnv } from './e2e/env.mjs';
import { createSignalCleanup } from './e2e/signal-cleanup.mjs';
import { parseArgs, USAGE, UsageError } from './web-stress/args.mjs';
import { checkHogs, startHogs, stopHogs } from './web-stress/hogs.mjs';
import { ResultsError, formatFailures, formatRunLine, formatSlowest, readResults } from './web-stress/results.mjs';
import { SUITES, suiteArgs } from './web-stress/suites.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const HOG_WARMUP_MS = 300;
const SUITE_STOP_MS = 5000;
const OUTPUT_TAIL_LINES = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  const errorLabel = SUITES[error.suite]?.label ?? SUITES.web.label;
  console.error(`${errorLabel}: ${error.message}`);
  console.error(USAGE);
  process.exit(2);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const suite = SUITES[options.suite];
const label = suite.label;

function fail(message) {
  console.error(`${label}: ${message}`);
  process.exit(2);
}

const defaultLogDir = options.logDir === null;
let logDir;
try {
  logDir = defaultLogDir
    ? mkdtempSync(path.join(os.tmpdir(), suite.logPrefix))
    : path.resolve(options.logDir);
  mkdirSync(logDir, { recursive: true });
} catch (error) {
  fail(`could not create the log directory: ${error instanceof Error ? error.message : error}`);
}

const cpus =
  typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
console.log(
  `${label}: suite=${options.suite} cpus=${cpus} hogs=${options.hogs} runs=${options.runs} ` +
    `node=${process.version} tmp=${logDir}`,
);
if (options.hogs > cpus) {
  console.log(`${label}: note: ${options.hogs} hogs on ${cpus} CPUs oversubscribes heavily`);
}
if (options.only.length > 0) {
  console.log(
    `${label}: warning: --only ${options.only.join(' ')} filters the suite; ` +
      'this run is not a full-suite proof',
  );
}

let hogs = { children: [], errors: new Map(), stopped: false };
let active = null;
let keepLogs = options.keepLogs;
let cleanupStarted = false;

function killGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The child or its process group already exited.
  }
}

async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) return;
    await sleep(50);
  }
}

async function stopSuite(entry) {
  if (!entry) return;
  killGroup(entry.child, 'SIGTERM');
  await waitForExit(entry.child, SUITE_STOP_MS);
  killGroup(entry.child, 'SIGKILL');
}

function removeLogs() {
  try {
    if (defaultLogDir) {
      rmSync(logDir, { recursive: true, force: true });
      return;
    }
    // An explicit --log-dir may hold unrelated files; remove only our runs.
    for (let index = 1; index <= options.runs; index += 1) {
      rmSync(path.join(logDir, `run-${index}`), { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup; the exit code already reflects the run result.
  }
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await stopSuite(active);
  active = null;
  await stopHogs(hogs);
  if (!keepLogs) removeLogs();
}

// A second signal cannot await cleanup, so release every handle synchronously.
function forceCleanup() {
  if (active) killGroup(active.child, 'SIGKILL');
  for (const child of hogs.children) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (!keepLogs) removeLogs();
}

// Installed before the first spawn so Ctrl-C during startup still reaps hogs.
const signalCleanup = createSignalCleanup({ cleanup, force: forceCleanup });

function tailLines(file) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES);
  } catch {
    return [];
  }
}

function runSuite({ resultsPath, outputPath }) {
  return new Promise((resolve) => {
    const fd = openSync(outputPath, 'w');
    const args = suiteArgs(suite, { resultsPath, only: options.only });
    const child = spawn(npmCommand(), args, {
      cwd: root,
      env: buildPinnedEnv(process.env, { NODE_ENV: 'test' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    active = { child, fd };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), SUITE_STOP_MS).unref();
    }, options.timeoutSeconds * 1000);

    const sink = (stream, target) => {
      stream.on('data', (chunk) => {
        try {
          writeSync(fd, chunk);
        } catch {
          // The log is best-effort; the exit code and report still decide.
        }
        if (options.verbose) target.write(chunk);
      });
    };
    sink(child.stdout, process.stdout);
    sink(child.stderr, process.stderr);

    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        // Already closed by the error path.
      }
      active = null;
      resolve(outcome);
    };

    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        timedOut,
        summary: null,
        error: `could not start npm: ${error.message}`,
      });
    });

    child.on('close', (code, signal) => {
      let summary = null;
      let error = null;
      if (!timedOut) {
        try {
          summary = readResults(resultsPath);
        } catch (caught) {
          error = caught instanceof ResultsError ? caught.message : String(caught);
        }
      }
      finish({ code, signal, timedOut, summary, error });
    });
  });
}

let failedRuns = 0;
let completed = 0;

try {
  if (options.hogs > 0) {
    hogs = startHogs({ count: options.hogs, marker: suite.hogMarker });
    console.log(`${label}: hog pids=${hogs.children.map((child) => child.pid).join(' ')}`);
    await sleep(HOG_WARMUP_MS);
    checkHogs(hogs);
  } else {
    console.log(`${label}: hog pids=none`);
  }

  for (let index = 1; index <= options.runs; index += 1) {
    checkHogs(hogs);

    const runDir = path.join(logDir, `run-${index}`);
    mkdirSync(runDir, { recursive: true });
    const resultsPath = path.join(runDir, 'results.json');
    const outputPath = path.join(runDir, 'output.log');

    const startedAt = Date.now();
    const outcome = await runSuite({ resultsPath, outputPath });
    const elapsedMs = Date.now() - startedAt;
    checkHogs(hogs);
    completed += 1;

    const ok =
      !outcome.timedOut && outcome.code === 0 && outcome.summary !== null && outcome.summary.ok;
    if (ok) {
      console.log(
        formatRunLine({ index, runs: options.runs, summary: outcome.summary, elapsedMs }),
      );
      for (const line of formatSlowest(outcome.summary)) console.log(line);
      continue;
    }

    failedRuns += 1;
    keepLogs = true;
    const reason = outcome.timedOut
      ? `timed out after ${options.timeoutSeconds}s`
      : outcome.summary === null
        ? `no parsable results: ${outcome.error}`
        : `exit ${outcome.code ?? outcome.signal}`;
    console.log(
      `run ${index}/${options.runs} FAIL ${(elapsedMs / 1000).toFixed(1)}s  ${reason}`,
    );
    if (outcome.summary !== null) {
      for (const line of formatSlowest(outcome.summary)) console.log(line);
      for (const line of formatFailures(outcome.summary)) console.log(line);
    } else {
      for (const line of tailLines(outputPath)) console.log(`    ${line}`);
    }
    console.log(`    report: ${resultsPath}`);
    if (options.failFast) break;
  }
} catch (error) {
  failedRuns += 1;
  keepLogs = true;
  console.error(`${label}: ${error instanceof Error ? error.message : error}`);
} finally {
  await signalCleanup.run();
  signalCleanup.dispose();
}

if (failedRuns === 0) {
  console.log(`${label}: PASS (${completed}/${options.runs} runs, hogs alive throughout)`);
} else {
  console.log(`${label}: FAIL (${failedRuns} failing ${failedRuns === 1 ? 'run' : 'runs'})`);
}
if (keepLogs) console.log(`${label}: logs in ${logDir}`);
process.exitCode = failedRuns === 0 ? 0 : 1;
