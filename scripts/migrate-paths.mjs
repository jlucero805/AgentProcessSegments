#!/usr/bin/env node
// One-time move from the legacy Sandbox Harness runtime names to Agent Process
// Segments. The brain never runs this automatically: moving a live data directory
// can break git worktree metadata and an open SQLite database, so the script
// refuses while a known brain unit is active, a visible process is using the
// planned paths, a brain answers its health endpoint, or an opt-in brain
// heartbeat file (`APS_BRAIN_LOCK=1`) is fresh. Use --allow-running only when
// the operator accepts that risk.
// Re-running is safe; existing destinations are never overwritten.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRAIN_UNITS = [
  { unit: 'agent-process-segments.service', scope: 'user' },
  { unit: 'agent-process-segments.service', scope: 'system' },
  { unit: 'sandbox-harness.service', scope: 'user' },
  { unit: 'sandbox-harness.service', scope: 'system' },
];

const PROC_ROOT = '/proc';
const DEFAULT_BRAIN_PORT = 7391;
const BRAIN_PROBE_TIMEOUT_MS = 2000;
const BRAIN_LOCK_FILE = 'brain.lock';
// Paired with BRAIN_LOCK_INTERVAL_MS (10 s) in src/server/src/brain-lock.ts:
// six missed beats after a crash must not block a migration forever.
const BRAIN_LOCK_TTL_MS = 60_000;

function usage() {
  return [
    'Usage: node scripts/migrate-paths.mjs [--dry-run] [--allow-running] [--brain-url URL] [--brain-lock FILE] [--home DIR] [--cwd DIR]',
    '',
    'Moves the default legacy locations to the APS names:',
    '  ~/.sandbox-harness                 -> ~/.agent-process-segments',
    '  $XDG_CONFIG_HOME/sandbox-harness   -> $XDG_CONFIG_HOME/agent-process-segments',
    '  $XDG_STATE_HOME/sandbox-harness    -> $XDG_STATE_HOME/agent-process-segments',
    '  <cwd>/sandbox-harness.sqlite       -> <cwd>/agent-process-segments.sqlite',
    '',
    'Options:',
    '  --dry-run          Print the planned moves; change nothing.',
    '  --allow-running    Move even when a brain unit, process, health endpoint, or fresh brain lock is active (unsafe).',
    '  --brain-url URL    Probe this http(s) base URL instead of http://127.0.0.1:<APS_PORT|SBOX_PORT|7391>.',
    '  --brain-lock FILE  Read this heartbeat file instead of <data dir>/brain.lock.',
    '  --home DIR         Home directory that owns the XDG defaults.',
    '  --cwd DIR          Directory that holds the SQLite database.',
    '  --help             Show this help.',
    '',
    'Explicit APS_* / SBOX_* path overrides are not inspected or moved.',
  ].join('\n');
}

function normalizeBrainUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--brain-url needs an http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--brain-url needs an http(s) URL');
  }
  if (!parsed.hostname) throw new Error('--brain-url needs a host');
  if (parsed.username || parsed.password) {
    throw new Error('--brain-url must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('--brain-url must be a base URL without a query or fragment');
  }
  return value.replace(/\/+$/, '');
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    allowRunning: false,
    brainUrl: null,
    brainLock: null,
    home: os.homedir(),
    cwd: process.cwd(),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--allow-running') {
      options.allowRunning = true;
    } else if (arg === '--brain-url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--brain-url needs an http(s) URL');
      options.brainUrl = normalizeBrainUrl(value);
      index += 1;
    } else if (arg === '--brain-lock') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--brain-lock needs a file');
      options.brainLock = path.resolve(value);
      index += 1;
    } else if (arg === '--home' || arg === '--cwd') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a directory`);
      options[arg === '--home' ? 'home' : 'cwd'] = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function moveCommand(from, to) {
  return `mv ${shellQuote(from)} ${shellQuote(to)}`;
}

function systemctlArgs({ unit, scope }) {
  return scope === 'user'
    ? ['--user', 'is-active', '--quiet', unit]
    : ['is-active', '--quiet', unit];
}

function stopCommand({ unit, scope }) {
  return scope === 'user'
    ? `systemctl --user stop ${unit}`
    : `sudo systemctl stop ${unit}`;
}

function unitLabel({ unit, scope }) {
  return `${unit} (${scope})`;
}

function activeBrainUnits() {
  const active = [];
  let unavailable = false;

  for (const candidate of BRAIN_UNITS) {
    const result = spawnSync('systemctl', systemctlArgs(candidate), {
      stdio: 'ignore',
      timeout: 2000,
    });
    if (result.error?.code === 'ENOENT') {
      unavailable = true;
      break;
    }
    if (result.error || result.status === null) {
      // A timeout or permission error is not proof that the unit is stopped.
      // Keep checking the other scope and unit, but tell the operator that the
      // guard could not verify systemd.
      unavailable = true;
      continue;
    }
    if (result.status === 0) active.push(candidate);
  }

  return { active, unavailable };
}

function resolvedSources(planned) {
  return planned.map((item) => {
    let source;
    try {
      source = realpathSync(item.from);
    } catch {
      source = path.resolve(item.from);
    }
    return { ...item, source };
  });
}

function withoutDeletedSuffix(target) {
  const suffix = ' (deleted)';
  return target.endsWith(suffix) ? target.slice(0, -suffix.length) : target;
}

function matchesSource(candidate, source) {
  if (!path.isAbsolute(candidate)) return false;
  if (source.kind === 'directory') {
    return candidate === source.source || candidate.startsWith(`${source.source}${path.sep}`);
  }
  return candidate === source.source;
}

function processLabel(pid) {
  try {
    return readFileSync(`${PROC_ROOT}/${pid}/comm`, 'utf8').trim() || '?';
  } catch {
    return '?';
  }
}

/**
 * Find visible processes that already have one of the planned sources open or
 * use a planned directory as their cwd. Linux-only: callers fall back to a note
 * when /proc is unavailable rather than making the migration unusable.
 */
function processesUsingSources(planned) {
  const sources = resolvedSources(planned);
  const matches = [];
  const seen = new Set();
  let unreadable = 0;
  let entries;

  try {
    entries = readdirSync(PROC_ROOT);
  } catch {
    return { matches, unavailable: true, unreadable: 0 };
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    const dir = `${PROC_ROOT}/${entry}`;
    const comm = processLabel(entry);
    let denied = false;
    const record = (target, via) => {
      const candidate = withoutDeletedSuffix(target);
      for (const source of sources) {
        if (!matchesSource(candidate, source)) continue;
        const key = `${pid}:${candidate}`;
        if (seen.has(key)) return;
        seen.add(key);
        matches.push({ pid, comm, path: candidate, via });
        return;
      }
    };

    try {
      record(readlinkSync(`${dir}/cwd`), 'cwd');
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') denied = true;
    }

    try {
      for (const fd of readdirSync(`${dir}/fd`)) {
        try {
          record(readlinkSync(`${dir}/fd/${fd}`), 'fd');
        } catch (error) {
          if (error?.code === 'EACCES' || error?.code === 'EPERM') denied = true;
        }
      }
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') denied = true;
    }

    if (denied) unreadable += 1;
  }

  return { matches, unavailable: false, unreadable };
}

function processBlocker(match) {
  return match.via === 'cwd'
    ? `pid ${match.pid} (${match.comm}) has cwd ${match.path}`
    : `pid ${match.pid} (${match.comm}) has ${match.path} open`;
}

function brainProbeUrl(options) {
  if (options.brainUrl) return `${options.brainUrl}/health`;

  const raw = process.env.APS_PORT ?? process.env.SBOX_PORT;
  if (raw === undefined) return `http://127.0.0.1:${DEFAULT_BRAIN_PORT}/health`;

  const port = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      'note: cannot derive the brain port from APS_PORT/SBOX_PORT; pass --brain-url to probe it',
    );
    return null;
  }
  return `http://127.0.0.1:${port}/health`;
}

/** The data dir this host's brain would use, matching the path-override rules. */
function activeDataDir() {
  const raw = [process.env.APS_DATA_DIR, process.env.SBOX_DATA_DIR].find(
    (value) => value !== undefined && value.trim() !== '',
  );
  if (raw === undefined) return null;
  return path.resolve(raw);
}

/**
 * Files to inspect for an opt-in heartbeat. An explicit --brain-lock always wins.
 * Otherwise check every planned directory source plus the legacy, canonical, and
 * active data dirs: a brain on the new names may still hold a legacy SQLite file.
 */
function brainLockCandidates(options, planned) {
  if (options.brainLock) return [options.brainLock];

  const dirs = new Set();
  for (const item of planned) {
    if (item.kind === 'directory') dirs.add(path.resolve(item.from));
  }
  dirs.add(path.join(options.home, '.sandbox-harness'));
  dirs.add(path.join(options.home, '.agent-process-segments'));
  const active = activeDataDir();
  if (active) dirs.add(active);

  return [...dirs]
    .filter((dir) => existsSync(dir))
    .map((dir) => path.join(dir, BRAIN_LOCK_FILE));
}

function isMissingFile(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

/**
 * A fresh file blocks by mtime alone; its JSON only enriches the message. A
 * stale or unreadable file is a note, matching the /proc policy: the guard is
 * best-effort and --allow-running is the explicit override.
 */
function readBrainLock(file, explicit) {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    if (isMissingFile(error)) {
      if (explicit) {
        console.error(
          `note: no brain lock at ${file}; a brain that does not write one may go undetected`,
        );
      }
      return null;
    }
    console.error(
      `note: could not read brain lock ${file} (${error?.code ?? 'error'}); a live brain may go undetected`,
    );
    return null;
  }

  if (!stat.isFile()) {
    if (explicit) {
      console.error(`note: --brain-lock expects a file, not a directory: ${file}`);
    }
    return null;
  }

  const ageMs = Date.now() - stat.mtimeMs;
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  if (ageMs > BRAIN_LOCK_TTL_MS) {
    console.error(
      `note: ignoring stale brain lock ${file} (last heartbeat ${ageSeconds}s ago; fresh threshold 60s)`,
    );
    return null;
  }

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(
      `note: could not read brain lock ${file} (${error?.code ?? 'error'}); a live brain may go undetected`,
    );
    return null;
  }

  let info = null;
  try {
    const body = JSON.parse(raw);
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) info = body;
  } catch {
    // A fresh but malformed file still blocks; the content only improves the message.
  }
  return { path: file, ageSeconds, info };
}

function freshBrainLocks(options, planned) {
  const explicit = options.brainLock !== null;
  const locks = [];
  for (const file of brainLockCandidates(options, planned)) {
    const lock = readBrainLock(file, explicit);
    if (lock) locks.push(lock);
  }
  return locks;
}

function lockBlocker(lock) {
  const lines = [`refusing to migrate: a brain lock is fresh at ${lock.path}`];
  if (lock.info && typeof lock.info.pid === 'number') {
    const host = typeof lock.info.host === 'string' ? lock.info.host : 'an unknown host';
    lines.push(`  pid ${lock.info.pid} on ${host}; last heartbeat ${lock.ageSeconds}s ago`);
  } else {
    lines.push('  the lock content is not a recognized heartbeat; a live brain may be writing it');
  }
  lines.push('stop the brain, container, or remote host that writes this lock, then retry.');
  lines.push('or re-run with --allow-running to move files under a live brain (unsafe).');
  return lines;
}

function probeErrorReason(error) {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timed out';
  }
  return error?.cause?.code ?? (error instanceof Error ? error.name : 'request failed');
}

/**
 * A live brain answers its own /health endpoint, which is reachable even when the
 * process lives in another PID/mount namespace or on another host. A 2xx JSON
 * `{ok:true}` is the existing health contract, so an older brain is caught too.
 */
async function probeBrain(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(BRAIN_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return { state: 'unreachable', reason: probeErrorReason(error) };
  }

  if (response.ok) {
    let body;
    try {
      body = await response.json();
    } catch {
      return { state: 'unrelated', status: response.status };
    }
    if (body !== null && typeof body === 'object' && body.ok === true) {
      return { state: 'brain' };
    }
  }
  return { state: 'unrelated', status: response.status };
}

async function checkRunningBrain(options, planned) {
  const { active, unavailable } = activeBrainUnits();
  if (unavailable) {
    console.error('note: could not query systemd; cannot verify that a brain unit is stopped');
  }

  const {
    matches,
    unavailable: procUnavailable,
    unreadable,
  } = processesUsingSources(planned);
  if (procUnavailable) {
    console.error('note: could not inspect /proc; cannot verify that no process is using the paths');
  }
  if (unreadable > 0) {
    console.error(
      `note: could not inspect ${unreadable} process(es); a brain owned by another user or hidden by permissions may go undetected`,
    );
  }

  const probeUrl = brainProbeUrl(options);
  const probe = probeUrl === null ? null : await probeBrain(probeUrl);
  if (probe?.state === 'unrelated') {
    console.error(
      `note: ${probeUrl} answered HTTP ${probe.status} but is not an APS health endpoint; continuing`,
    );
  } else if (probe?.state === 'unreachable' && options.brainUrl) {
    console.error(
      `note: could not reach the brain at ${probeUrl} (${probe.reason}); a brain reachable only from another namespace or host may go undetected`,
    );
  }
  const brain = probe?.state === 'brain';
  const locks = freshBrainLocks(options, planned);

  if (active.length === 0 && matches.length === 0 && !brain && locks.length === 0) return true;

  const names = active.map(unitLabel).join(', ');

  if (options.dryRun) {
    if (active.length > 0) {
      if (options.allowRunning) {
        console.error(
          `warning: ${names} active; a real run with --allow-running would move files under a live brain`,
        );
      } else {
        console.error(
          `warning: ${names} active; a real run would refuse. Stop the unit or pass --allow-running.`,
        );
      }
    }
    if (matches.length > 0) {
      const pids = matches.map((match) => `pid ${match.pid} (${match.comm})`).join(', ');
      if (options.allowRunning) {
        console.error(
          `warning: ${pids} using the planned paths; a real run with --allow-running would move files under a live brain`,
        );
      } else {
        console.error(
          `warning: ${pids} using the planned paths; a real run would refuse. Stop the process or pass --allow-running.`,
        );
      }
    }
    if (brain) {
      if (options.allowRunning) {
        console.error(
          `warning: a brain is answering at ${probeUrl}; a real run with --allow-running would move files under a live brain`,
        );
      } else {
        console.error(
          `warning: a brain is answering at ${probeUrl}; a real run would refuse. Stop it or pass --allow-running.`,
        );
      }
    }
    for (const lock of locks) {
      if (options.allowRunning) {
        console.error(
          `warning: a brain lock is fresh at ${lock.path}; a real run with --allow-running would move files under a live brain`,
        );
      } else {
        console.error(
          `warning: a brain lock is fresh at ${lock.path}; a real run would refuse. Stop it or pass --allow-running.`,
        );
      }
    }
    return true;
  }

  if (options.allowRunning) {
    if (active.length > 0) {
      console.error(
        `warning: ${names} active; moving files under a live brain can corrupt the database, sessions, and worktrees`,
      );
    }
    if (matches.length > 0) {
      console.error(
        `warning: ${matches.length} process(es) using the planned paths; moving files under a live brain can corrupt the database, sessions, and worktrees`,
      );
    }
    if (brain) {
      console.error(
        `warning: a brain is answering at ${probeUrl}; moving files under a live brain can corrupt the database, sessions, and worktrees`,
      );
    }
    for (const lock of locks) {
      console.error(
        `warning: a brain lock is fresh at ${lock.path}; moving files under a live brain can corrupt the database, sessions, and worktrees`,
      );
    }
    return true;
  }

  if (active.length > 0) {
    console.error(`refusing to migrate: ${names} active`);
    console.error('stop the brain unit first:');
    for (const entry of active) console.error(`  ${stopCommand(entry)}`);
    console.error('or re-run with --allow-running to move files under a live brain (unsafe).');
  }

  if (matches.length > 0) {
    console.error(`refusing to migrate: ${matches.length} process(es) using the planned paths`);
    for (const match of matches) console.error(`  ${processBlocker(match)}`);
    console.error('stop the foreground brain or the process holding these paths:');
    for (const pid of new Set(matches.map((match) => match.pid))) console.error(`  kill ${pid}`);
    console.error('or re-run with --allow-running to move files under a live brain (unsafe).');
  }

  if (brain) {
    console.error(`refusing to migrate: a brain is answering at ${probeUrl}`);
    console.error(
      'stop the brain, container, unit, or tunnel that publishes this address, then retry.',
    );
    console.error('or re-run with --allow-running to move files under a live brain (unsafe).');
  }

  for (const lock of locks) {
    for (const line of lockBlocker(lock)) console.error(line);
  }

  process.exitCode = 1;
  return false;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(options.home, '.config');
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(options.home, '.local', 'state');

  const overrides = [
    'APS_DATA_DIR',
    'SBOX_DATA_DIR',
    'APS_CONFIG',
    'SBOX_CONFIG',
    'APS_PROCESS',
    'SBOX_PROCESS',
    'APS_ERROR_LOG',
    'SBOX_ERROR_LOG',
    'APS_DB',
    'SBOX_DB',
  ].filter((name) => process.env[name] !== undefined);
  if (overrides.length > 0) {
    console.warn(`note: explicit path overrides are not migrated: ${overrides.join(', ')}`);
  }

  const planned = [];
  const skipped = [];

  const directories = [
    {
      label: 'data directory',
      from: path.join(options.home, '.sandbox-harness'),
      to: path.join(options.home, '.agent-process-segments'),
      kind: 'directory',
    },
    {
      label: 'config directory',
      from: path.join(configHome, 'sandbox-harness'),
      to: path.join(configHome, 'agent-process-segments'),
      kind: 'directory',
    },
    {
      label: 'state directory',
      from: path.join(stateHome, 'sandbox-harness'),
      to: path.join(stateHome, 'agent-process-segments'),
      kind: 'directory',
    },
  ];

  for (const item of directories) {
    if (!existsSync(item.from)) continue;
    if (existsSync(item.to)) {
      skipped.push(item);
      continue;
    }
    planned.push(item);
  }

  const dbFrom = path.join(options.cwd, 'sandbox-harness.sqlite');
  const dbTo = path.join(options.cwd, 'agent-process-segments.sqlite');
  if (existsSync(dbFrom)) {
    if (existsSync(dbTo)) {
      skipped.push({ label: 'database', from: dbFrom, to: dbTo, kind: 'file' });
    } else {
      for (const suffix of ['', '-wal', '-shm']) {
        const from = `${dbFrom}${suffix}`;
        const to = `${dbTo}${suffix}`;
        if (!existsSync(from)) continue;
        if (existsSync(to)) {
          skipped.push({ label: `database${suffix}`, from, to, kind: 'file' });
          continue;
        }
        planned.push({ label: `database${suffix}`, from, to, kind: 'file' });
      }
    }
  }

  for (const item of skipped) {
    console.warn(`skip ${item.label}: ${item.to} already exists; leaving ${item.from} alone`);
  }

  if (planned.length === 0) {
    console.log('nothing to migrate');
    return;
  }

  if (!(await checkRunningBrain(options, planned))) return;

  if (options.dryRun) {
    for (const item of planned) {
      console.log(`would move ${item.label}: ${item.from} -> ${item.to}`);
    }
    console.log('dry run: no files were changed');
    return;
  }

  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    try {
      renameSync(item.from, item.to);
      console.log(`moved ${item.label}: ${item.from} -> ${item.to}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`could not move ${item.label}: ${message}`);
      console.error('run these commands manually, then retry:');
      for (const remaining of planned.slice(index)) {
        console.error(`  ${moveCommand(remaining.from, remaining.to)}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  if (planned.some((item) => item.label === 'data directory')) {
    console.log(
      'note: existing worktrees moved with the data directory; if git reports them at the',
    );
    console.log('old path, run `git worktree repair` in the target repo or remove and recreate them.');
  }
  console.log('migration complete');
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
