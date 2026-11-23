#!/usr/bin/env node
// Bounded retention for `~/.aps-cutover` run directories. Every real
// `deploy/cutover-vps.sh` run leaves a permanent directory under
// `~/.aps-cutover/runs/<UTC>/` holding its log, before/after evidence, the
// pre-build dist copy, and the systemd rollback backup. This script keeps the
// newest runs and the rollback point and removes the rest.
//
// It only touches files under `--root`, so it is safe while the brain runs.
// Run with `--dry-run` first. See `deploy/vps.md`.
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUN_NAME = /^\d{8}T\d{6}Z$/;
const TERMINAL_STATES = new Set(['success', 'failed', 'rolled-back']);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_VALUE = 100_000;

class UsageError extends Error {}

function usage() {
  return [
    'Usage: node scripts/prune-cutover-runs.mjs [options]',
    '',
    'Prune old ~/.aps-cutover run directories while keeping recent evidence and',
    'the rollback backup you may still need.',
    '',
    'Options:',
    '  --dry-run                    Report what would be removed; change nothing.',
    '  --root DIR                   Cutover root (default: $HOME/.aps-cutover).',
    '  --keep-runs N                Keep the N newest run directories (default: 10).',
    '  --keep-days D                Keep run directories modified within D days (default: 30).',
    '  --incomplete-grace-days D    Keep runs with a non-terminal state for D days',
    '                               (default: 7). Zero disables the grace window.',
    '  --help                       Show this help.',
  ].join('\n');
}

function readInteger(flag, value) {
  if (value === undefined) throw new UsageError(`${flag} needs a value`);
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} needs a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_VALUE) {
    throw new UsageError(`${flag} must be between 0 and ${MAX_VALUE}`);
  }
  return parsed;
}

function readDirectory(flag, value) {
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a directory`);
  return path.resolve(value);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    root: path.join(os.homedir(), '.aps-cutover'),
    keepRuns: 10,
    keepDays: 30,
    incompleteGraceDays: 7,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--root') {
      options.root = readDirectory(arg, argv[index + 1]);
      index += 1;
    } else if (arg === '--keep-runs') {
      options.keepRuns = readInteger(arg, argv[index + 1]);
      index += 1;
    } else if (arg === '--keep-days') {
      options.keepDays = readInteger(arg, argv[index + 1]);
      index += 1;
    } else if (arg === '--incomplete-grace-days') {
      options.incompleteGraceDays = readInteger(arg, argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readState(dir) {
  try {
    return readFileSync(path.join(dir, 'state'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function modifiedMs(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    // An unreadable run stays protected by the age rule rather than being removed.
    return Number.POSITIVE_INFINITY;
  }
}

function directorySize(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      let info;
      try {
        info = lstatSync(target);
      } catch {
        continue;
      }
      if (info.isDirectory()) pending.push(target);
      else total += info.size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function readLatestTarget(root) {
  try {
    return path.resolve(root, readlinkSync(path.join(root, 'latest')));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EINVAL') return null;
    throw error;
  }
}

function collectRuns(runsDir) {
  const runs = [];
  const skipped = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_NAME.test(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    runs.push({ name: entry.name, dir: path.join(runsDir, entry.name) });
  }
  runs.sort((left, right) => (left.name < right.name ? 1 : -1));
  return { runs, skipped };
}

function classify(runs, options, now, latestTarget) {
  for (const run of runs) {
    run.state = readState(run.dir);
    run.mtimeMs = modifiedMs(run.dir);
    run.size = directorySize(run.dir);
  }

  const newestSuccess = runs.find((run) => run.state === 'success')?.name ?? null;
  const keepWindow = options.keepDays * DAY_MS;
  const graceWindow = options.incompleteGraceDays * DAY_MS;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const age = now - run.mtimeMs;
    const terminal = TERMINAL_STATES.has(run.state);

    run.keep = true;
    if (latestTarget !== null && path.resolve(run.dir) === latestTarget) {
      run.reason = 'latest';
    } else if (run.name === newestSuccess) {
      run.reason = 'rollback point';
    } else if (index < options.keepRuns) {
      run.reason = `newest ${options.keepRuns}`;
    } else if (options.keepDays > 0 && age <= keepWindow) {
      run.reason = `modified within ${options.keepDays}d`;
    } else if (!terminal && options.incompleteGraceDays > 0 && age <= graceWindow) {
      run.reason = `incomplete within ${options.incompleteGraceDays}d`;
    } else {
      run.keep = false;
      run.reason = terminal || options.incompleteGraceDays === 0 ? 'old run' : 'incomplete beyond grace';
    }
  }

  return runs;
}

function removeRun(run, runsDir) {
  if (path.dirname(path.resolve(run.dir)) !== path.resolve(runsDir) || !RUN_NAME.test(run.name)) {
    throw new Error('refusing to remove a path outside the runs directory');
  }
  const info = lstatSync(run.dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('refusing to remove a path that is not a run directory');
  }
  rmSync(run.dir, { recursive: true, force: false });
}

function prune(options) {
  const root = path.resolve(options.root);
  const runsDir = path.join(root, 'runs');
  if (!isDirectory(runsDir)) {
    process.stdout.write('nothing to prune\n');
    return 0;
  }

  let latestTarget = readLatestTarget(root);
  if (latestTarget !== null && !isDirectory(latestTarget)) {
    process.stderr.write(`warning: ${path.join(root, 'latest')} points at a missing run directory\n`);
    latestTarget = null;
  }

  const { runs, skipped } = collectRuns(runsDir);
  classify(runs, options, Date.now(), latestTarget);

  let pruned = 0;
  let freed = 0;
  let failed = 0;
  for (const run of runs) {
    const state = run.state ?? 'unknown';
    process.stdout.write(
      `${run.keep ? 'keep ' : 'prune'}  ${run.name}  ${formatBytes(run.size)}  ${state}  (${run.reason})\n`,
    );
    if (run.keep) continue;
    if (options.dryRun) {
      pruned += 1;
      freed += run.size;
      continue;
    }
    try {
      removeRun(run, runsDir);
      pruned += 1;
      freed += run.size;
    } catch (error) {
      failed += 1;
      process.stderr.write(`failed to remove ${run.dir}: ${error.message}\n`);
    }
  }

  for (const name of skipped) {
    process.stdout.write(`skip   ${name}  (not a run directory)\n`);
  }

  const suffix = options.dryRun ? ' (dry run: nothing removed)' : '';
  process.stdout.write(`${pruned} run directories pruned, ${formatBytes(freed)} freed${suffix}\n`);
  return failed > 0 ? 1 : 0;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`error: ${error.message}\n\n${usage()}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  return prune(options);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
