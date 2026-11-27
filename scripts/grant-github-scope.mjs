#!/usr/bin/env node
// Complete the `workflow`-scope grant for the host's GitHub credential, or say
// exactly what an operator must do. `gh auth refresh` blocks on a device-flow
// approval, so this command refuses to start it from a non-interactive shell:
// an agent that follows the remediation from invariant 47 would otherwise hang.
//
// Usage:
//   node scripts/grant-github-scope.mjs [--host <host>]
//
// Exit codes: 0 means the credential can push workflow files; 1 means a required
// classic scope is still missing (the refresh was declined, failed, or cannot run
// here); 2 means the credential could not be classified or the command could not
// run. Only 0 is a green light.
//
// The preflight classification and the token redaction live in
// `check-github-scope.mjs`; this command reuses them and never reads a token.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_HOST,
  UsageError,
  formatHuman,
  probe,
  redact,
} from './check-github-scope.mjs';

const USAGE = [
  'Usage: node scripts/grant-github-scope.mjs [--host <host>]',
  '',
  'Checks the host `gh` credential, then, in an interactive terminal, runs',
  '`gh auth refresh -h <host> -s workflow` and re-verifies. In a non-interactive',
  'shell it prints the exact command and exits 1 instead of blocking on the',
  'device-flow approval.',
  '',
  'Exit codes: 0 = safe to push .github/workflows/**;',
  '1 = a required classic scope is still missing;',
  '2 = could not classify or run (no gh, unauthenticated, fine-grained, no TTY).',
].join('\n');

// Request `workflow` first so the common case prints the documented command.
const REFRESH_SCOPE_ORDER = ['workflow', 'repo'];

export function parseArgs(argv) {
  const options = { host: DEFAULT_HOST, help: false };

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
  const spawn = options.spawn ?? spawnSync;
  const bin = options.bin ?? (process.env.GH_BIN || 'gh');
  const missing = options.missing ?? ['workflow'];
  return spawn(bin, buildRefreshArgs(host, missing), { stdio: 'inherit' });
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
    'Do not add a deploy key, switch origin to SSH, or use the API to work around this;',
    'stop and report instead.',
  ].join('\n');
}

export function main(argv, deps = {}) {
  const probeFn = deps.probe ?? probe;
  const refreshFn = deps.refresh ?? runRefresh;
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
  const action = decide(before, interactive);

  if (action === 'ok') {
    console.log(formatHuman(before, options.host));
    return 0;
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
  process.exitCode = main(process.argv.slice(2));
}
