#!/usr/bin/env node
// Stress-run the web Vitest suite under competing CPU load.
//
//   npm run test:web-stress
//   node scripts/web-stress.mjs --runs 5 --hogs 8 --verbose
//
// Fails closed: a failed iteration, a hog that exited early, a per-iteration
// timeout, or a missing Vitest JSON report is a non-zero exit, never a pass.
// Hogs are reaped on every exit path, and each hog exits by itself when this
// process disappears (even after SIGKILL).
//
// Each iteration runs under scripts/web-stress/suite-supervisor.mjs, a
// detached group leader. A timeout or interrupt signals the whole npm-to-Vitest
// group, and when this process is SIGKILLed the supervisor sees its parent go
// away and SIGKILLs that same group, so no suite process is orphaned. A
// filtered run (--only) is useful while iterating but is not a full-suite proof.
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

const root = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = 'src/web';
const SUITE_SUPERVISOR = path.join(root, 'scripts', 'web-stress', 'suite-supervisor.mjs');
const HOG_WARMUP_MS = 300;
const SUITE_STOP_MS = 5000;
const OUTPUT_TAIL_LINES = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function fail(message) {
  console.error(`web-stress: ${message}`);
  process.exit(2);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`web-stress: ${error.message}`);
  console.error(USAGE);
  process.exit(2);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const defaultLogDir = options.logDir === null;
let logDir;
try {
  logDir = defaultLogDir
    ? mkdtempSync(path.join(os.tmpdir(), 'aps-web-stress-'))
    : path.resolve(options.logDir);
  mkdirSync(logDir, { recursive: true });
} catch (error) {
  fail(`could not create the log directory: ${error instanceof Error ? error.message : error}`);
}

const cpus =
  typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
console.log(
  `web-stress: cpus=${cpus} hogs=${options.hogs} runs=${options.runs} ` +
    `node=${process.version} tmp=${logDir}`,
);
if (options.hogs > cpus) {
  console.log(`web-stress: note: ${options.hogs} hogs on ${cpus} CPUs oversubscribes heavily`);
}
if (options.only.length > 0) {
  console.log(
    `web-stress: warning: --only ${options.only.join(' ')} filters the suite; ` +
      'this run is not a full-suite proof',
  );
}

let hogs = { children: [], errors: new Map(), stopped: false };
let active = null;
let keepLogs = options.keepLogs;
let cleanupStarted = false;

// Signal the whole suite group, not just the direct child. On POSIX the group
// id is the supervisor's pid; it outlives the leader while npm or a Vitest
// worker is still alive, so cleanup must keep targeting it.
function signalGroup(entry, signal) {
  if (!entry) return;
  if (entry.pgid === null) {
    try {
      entry.child.kill(signal);
    } catch {
      // The child already exited.
    }
    return;
  }
  try {
    process.kill(-entry.pgid, signal);
  } catch {
    // The group already exited.
  }
}

function groupAlive(entry) {
  if (!entry) return false;
  if (entry.pgid === null) {
    return entry.child.exitCode === null && entry.child.signalCode === null;
  }
  try {
    process.kill(-entry.pgid, 0);
    return true;
  } catch (error) {
    // ESRCH is gone; EPERM still means a group exists. Treat anything else as
    // live so cleanup escalates instead of silently skipping.
    return !(error && typeof error === 'object' && error.code === 'ESRCH');
  }
}

async function waitForGroupGone(entry, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(entry)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

// Idempotent per iteration: the timeout path and the final cleanup can both
// stop the same suite without racing two signal escalations.
async function stopSuite(entry) {
  if (!entry) return;
  entry.stopPromise ??= (async () => {
    signalGroup(entry, 'SIGTERM');
    if (await waitForGroupGone(entry, SUITE_STOP_MS)) return;
    signalGroup(entry, 'SIGKILL');
    await waitForGroupGone(entry, SUITE_STOP_MS);
  })();
  await entry.stopPromise;
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
  signalGroup(active, 'SIGKILL');
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
    const npmArgs = [
      'test',
      '--workspace',
      WORKSPACE,
      '--',
      '--reporter=verbose',
      '--reporter=json',
      `--outputFile.json=${resultsPath}`,
      ...options.only,
    ];
    const useSupervisor = process.platform !== 'win32';
    const child = spawn(
      useSupervisor ? process.execPath : npmCommand(),
      useSupervisor
        ? [SUITE_SUPERVISOR, '--parent-pid', String(process.pid), '--', npmCommand(), ...npmArgs]
        : npmArgs,
      {
        cwd: root,
        env: buildPinnedEnv(process.env, { NODE_ENV: 'test' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: useSupervisor,
      },
    );

    const entry = {
      child,
      fd,
      pgid: useSupervisor && Number.isInteger(child.pid) ? child.pid : null,
    };
    active = entry;

    let timedOut = false;
    let timer = null;
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        // Already closed by the timeout path.
      }
      if (active === entry) active = null;
      resolve(outcome);
    };

    timer = setTimeout(() => {
      timedOut = true;
      // Resolve only after the group is gone, so the next iteration cannot
      // start while a dying npm/Vitest tree still holds the CPU.
      void stopSuite(entry).then(() => {
        finish({ code: null, signal: null, timedOut: true, summary: null, error: null });
      });
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

    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        timedOut,
        summary: null,
        error: `could not start ${useSupervisor ? 'the suite supervisor' : 'npm'}: ${error.message}`,
      });
    });

    child.on('close', async (code, signal) => {
      if (settled) return;
      // A supervisor crash can leave npm behind; reap that group before the
      // next iteration starts.
      if (groupAlive(entry)) await stopSuite(entry);
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
    hogs = startHogs({ count: options.hogs });
    console.log(`web-stress: hog pids=${hogs.children.map((child) => child.pid).join(' ')}`);
    await sleep(HOG_WARMUP_MS);
    checkHogs(hogs);
  } else {
    console.log('web-stress: hog pids=none');
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
  console.error(`web-stress: ${error instanceof Error ? error.message : error}`);
} finally {
  await signalCleanup.run();
  signalCleanup.dispose();
}

if (failedRuns === 0) {
  console.log(`web-stress: PASS (${completed}/${options.runs} runs, hogs alive throughout)`);
} else {
  console.log(`web-stress: FAIL (${failedRuns} failing ${failedRuns === 1 ? 'run' : 'runs'})`);
}
if (keepLogs) console.log(`web-stress: logs in ${logDir}`);
process.exitCode = failedRuns === 0 ? 0 : 1;
