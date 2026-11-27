#!/usr/bin/env node
// Complete the `workflow`-scope grant for the host's GitHub credential, or say
// exactly what an operator must do. `gh auth refresh` blocks on a device-flow
// approval, so this command refuses to start it from a non-interactive shell:
// an agent that follows the remediation from invariant 47 would otherwise hang.
//
// Usage:
//   node scripts/grant-github-scope.mjs [--host <host>] [--device-code-file <path>]
//
// Exit codes: 0 means the credential can push workflow files; 1 means a required
// classic scope is still missing (the refresh was declined, failed, or cannot run
// here); 2 means the credential could not be classified or the command could not
// run; 3 means an async handoff was written and the approval is still pending.
// Only 0 is a green light.
//
// With `--device-code-file`, the refresh runs as a detached child so it can
// outlive this turn. The child prints a one-time code and a verification URL;
// this command copies them to the file (JSON, mode 0600) plus a sibling log and
// exits 3. The account owner approves the code on any device; the caller later
// verifies with `check-github-scope`.
//
// The preflight classification and the token redaction live in
// `check-github-scope.mjs`; this command reuses them and never reads a token.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_HOST,
  UsageError,
  formatHuman,
  probe,
  redact,
} from './check-github-scope.mjs';

const USAGE = [
  'Usage: node scripts/grant-github-scope.mjs [--host <host>] [--device-code-file <path>]',
  '',
  'Checks the host `gh` credential, then, in an interactive terminal, runs',
  '`gh auth refresh -h <host> -s workflow` and re-verifies. In a non-interactive',
  'shell it prints the exact command and exits 1 instead of blocking on the',
  'device-flow approval.',
  '',
  'With --device-code-file, starts the refresh as a detached child, writes the',
  'one-time code and verification URL to <path> (mode 0600; gh output goes to',
  '<path>.log), and exits 3 while the approval is pending. The account owner',
  'approves the code, then `npm run check:github-scope` (exit 0) verifies it.',
  '',
  'Exit codes: 0 = safe to push .github/workflows/**;',
  '1 = a required classic scope is still missing;',
  '2 = could not classify or run (no gh, unauthenticated, fine-grained, no TTY);',
  '3 = device-flow handoff written; approval pending.',
].join('\n');

// Request `workflow` first so the common case prints the documented command.
const REFRESH_SCOPE_ORDER = ['workflow', 'repo'];

// Capturing the printed code takes seconds; the approval itself is GitHub's
// device-code expiry (about 15 minutes) and the detached child keeps polling.
const HANDOFF_TIMEOUT_MS = 30_000;
const HANDOFF_POLL_MS = 100;

// Built from a char code so the source stays free of literal control characters.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function parseArgs(argv) {
  const options = { host: DEFAULT_HOST, deviceCodeFile: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === '') throw new UsageError('--host needs a hostname');
      options.host = value;
    } else if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length);
      if (value === '') throw new UsageError('--host needs a hostname');
      options.host = value;
    } else if (arg === '--device-code-file') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === '') {
        throw new UsageError('--device-code-file needs a path');
      }
      options.deviceCodeFile = value;
    } else if (arg.startsWith('--device-code-file=')) {
      const value = arg.slice('--device-code-file='.length);
      if (value === '') throw new UsageError('--device-code-file needs a path');
      options.deviceCodeFile = value;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      throw new UsageError(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

export function isInteractive({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** Pick the action for a preflight result and whether a terminal is available. */
export function decide(result, interactive) {
  if (result.exitCode === 0) return 'ok';
  if (result.kind === 'classic' && result.missing.length > 0) {
    return interactive ? 'refresh' : 'manual';
  }
  return 'blocked';
}

/** `gh auth refresh` argv for the missing classic scopes, `workflow` first. */
export function buildRefreshArgs(host, missing) {
  const args = ['auth', 'refresh', '-h', host];
  for (const scope of REFRESH_SCOPE_ORDER) {
    if (missing.includes(scope)) args.push('-s', scope);
  }
  return args;
}

/** Run the interactive refresh. Inherits stdio so gh can print its device code. */
export function runRefresh(host, options = {}) {
  const spawnRefresh = options.spawn ?? spawnSync;
  const bin = options.bin ?? (process.env.GH_BIN || 'gh');
  const missing = options.missing ?? ['workflow'];
  return spawnRefresh(bin, buildRefreshArgs(host, missing), { stdio: 'inherit' });
}

/** Extract the one-time code and verification URL from `gh`'s device-flow output. */
export function parseDeviceHandoff(text) {
  const plain = String(text ?? '').replace(ANSI_PATTERN, '');
  const code = /one-time code:\s*([A-Za-z0-9-]{4,})/.exec(plain);
  const url = /(https?:\/\/[^\s]+?\/login\/device)\b/.exec(plain);
  if (code === null || url === null) return null;
  return { code: code[1], url: url[1] };
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Reuse a handoff whose detached `gh` is still polling; otherwise return null. */
function readPendingHandoff(file, isPidAlive) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof value.host === 'string' &&
      typeof value.code === 'string' &&
      typeof value.url === 'string' &&
      isPidAlive(value.pid)
    ) {
      return value;
    }
  } catch {
    // Missing, unreadable, or not JSON: start a fresh flow.
  }
  return null;
}

/**
 * Write JSON with owner-only permissions. `mode` only applies on creation, so
 * write a sibling temp file and rename it, then chmod explicitly for umask.
 */
function writePrivateJson(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function logTail(file) {
  const lines = readText(file)
    .split(/\r?\n/)
    .filter((line) => line !== '');
  return lines.slice(-8).join('\n');
}

/**
 * Start `gh auth refresh` detached, capture the printed code and URL, and write
 * the handoff. Only the handoff must happen here; the approval keeps polling
 * in the child after this process exits.
 */
export async function startHandoff(host, missing, file, options = {}) {
  const spawnFn = options.spawn ?? spawn;
  const bin = options.bin ?? (process.env.GH_BIN || 'gh');
  const isPidAlive = options.isPidAlive ?? pidAlive;
  const now = options.now ?? (() => new Date());
  const wait = options.sleep ?? ((ms) => delay(ms));
  const timeoutMs = options.timeoutMs ?? HANDOFF_TIMEOUT_MS;
  const pollMs = options.pollMs ?? HANDOFF_POLL_MS;

  const target = path.resolve(file);
  const dir = path.dirname(target);
  if (!existsSync(dir)) {
    return { ok: false, reason: `parent directory does not exist: ${dir}`, log: null };
  }

  const pending = readPendingHandoff(target, isPidAlive);
  if (pending !== null) return { ok: true, handoff: pending, reused: true };

  const logPath = `${target}.log`;
  let fd;
  try {
    fd = openSync(logPath, 'w', 0o600);
    chmodSync(logPath, 0o600);
  } catch (error) {
    return {
      ok: false,
      reason: `cannot write ${logPath} (${error.code ?? error.message})`,
      log: null,
    };
  }
  rmSync(target, { force: true });

  let child;
  try {
    child = spawnFn(bin, buildRefreshArgs(host, missing), {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (error) {
    closeSync(fd);
    return {
      ok: false,
      reason: `could not run gh (${error.code ?? error.message})`,
      log: logPath,
    };
  }
  closeSync(fd);

  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });

  const startedAt = Date.now();
  for (;;) {
    const parsed = parseDeviceHandoff(readText(logPath));
    if (parsed !== null) {
      const handoff = {
        host,
        url: parsed.url,
        code: parsed.code,
        scopes: [...missing],
        pid: child.pid,
        log: logPath,
        startedAt: now().toISOString(),
      };
      try {
        writePrivateJson(target, handoff);
      } catch (error) {
        child.kill('SIGTERM');
        return {
          ok: false,
          reason: `cannot write ${target} (${error.code ?? error.message})`,
          log: logPath,
        };
      }
      child.unref();
      return { ok: true, handoff, reused: false };
    }

    if (spawnError !== null) {
      return {
        ok: false,
        reason: `could not run gh (${spawnError.code ?? spawnError.message ?? 'unknown error'})`,
        log: logPath,
      };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        ok: false,
        reason: `gh exited before printing a device code (${child.exitCode ?? child.signalCode})`,
        log: logPath,
      };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      child.kill('SIGTERM');
      return {
        ok: false,
        reason: `timed out after ${timeoutMs} ms waiting for gh to print a device code`,
        log: logPath,
      };
    }
    await wait(pollMs);
  }
}

function scopeLabel(scope) {
  return scope === 'repo' ? 'repo (or public_repo)' : scope;
}

function missingLabel(missing) {
  return missing.map(scopeLabel).join(', ');
}

function formatManual(result, host) {
  const scopes = result.missing.map((scope) => `-s ${scope}`).join(' ');
  return [
    `grant-github-scope: ${host}`,
    `  credential: ${result.kind}`,
    `  scopes: ${result.scopes.length === 0 ? 'unknown' : result.scopes.join(', ')}`,
    `FAIL: missing scope(s): ${missingLabel(result.missing)}`,
    '',
    'This shell is not interactive, so the device-flow approval cannot be completed here.',
    'Run this in an interactive terminal on the host, then approve the printed URL:',
    `  npm run grant:github-scope -- --host ${host}`,
    `  (it runs: gh auth refresh -h ${host} ${scopes})`,
    '',
    'Or hand the device flow off without blocking this turn:',
    `  npm run grant:github-scope -- --host ${host} --device-code-file /tmp/gh-device.json`,
    'It writes the code and URL to that file and exits 3 while approval is pending;',
    'approve the code as the account owner, then run `npm run check:github-scope`.',
    '',
    'Do not add a deploy key, switch origin to SSH, or use the API to work around this;',
    'stop and report instead.',
  ].join('\n');
}

function printHandoff(host, handoff, reused, file) {
  console.log(
    reused
      ? `grant-github-scope: ${host}: a pending device flow already exists ` +
          `(pid ${handoff.pid}); approval still pending`
      : `grant-github-scope: ${host}: device flow started ` +
          `(pid ${handoff.pid}); approval pending`,
  );
  console.log(`  code: ${handoff.code}`);
  console.log(`  url:  ${handoff.url}`);
  console.log(`  file: ${path.resolve(file)} (mode 0600)`);
  console.log(`  log:  ${handoff.log}`);
  console.log('Approve the code as the account owner; it expires in about 15 minutes.');
  console.log('Then verify with `npm run check:github-scope` (exit 0 = granted).');
  console.log('Delete the handoff and log after approval.');
}

export async function main(argv, deps = {}) {
  const probeFn = deps.probe ?? probe;
  const refreshFn = deps.refresh ?? runRefresh;
  const handoffFn = deps.handoff ?? startHandoff;
  const interactive = deps.interactive ?? isInteractive();

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`grant-github-scope: ${error.message}`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const before = probeFn(options.host);
  let action = decide(before, interactive);
  if (options.deviceCodeFile !== null && (action === 'refresh' || action === 'manual')) {
    action = 'handoff';
  }

  if (action === 'ok') {
    console.log(formatHuman(before, options.host));
    return 0;
  }

  if (action === 'handoff') {
    const result = await handoffFn(options.host, before.missing, options.deviceCodeFile, {
      ...deps.handoffOptions,
    });
    if (!result.ok) {
      console.error(`grant-github-scope: ${redact(result.reason)}; scope not granted`);
      if (result.log !== null && result.log !== undefined) {
        console.error(`grant-github-scope: gh output: ${result.log}`);
        const tail = logTail(result.log);
        if (tail !== '') console.error(redact(tail));
      }
      return 2;
    }
    printHandoff(options.host, result.handoff, result.reused === true, options.deviceCodeFile);
    return 3;
  }

  if (action === 'manual') {
    console.log(formatManual(before, options.host));
    return 1;
  }

  if (action === 'blocked') {
    console.log(formatHuman(before, options.host));
    return 2;
  }

  console.log(
    `grant-github-scope: ${options.host}: missing ${missingLabel(before.missing)}; ` +
      'running `gh auth refresh` in this terminal...',
  );
  const run = refreshFn(options.host, { missing: before.missing });
  if (run.error !== null && run.error !== undefined) {
    const detail = run.error.code ?? run.error.message ?? 'unknown error';
    console.error(`grant-github-scope: could not run gh (${redact(detail)}); scope not granted`);
    return 2;
  }
  if (run.status !== 0) {
    console.error(
      `grant-github-scope: gh auth refresh exited with status ${String(run.status)}; ` +
        'scope not granted',
    );
    return 1;
  }

  const after = probeFn(options.host);
  console.log(formatHuman(after, options.host));
  return after.exitCode;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  process.exitCode = await main(process.argv.slice(2));
}
