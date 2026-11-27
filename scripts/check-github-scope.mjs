#!/usr/bin/env node
// Classify whether the current GitHub credential can push changes under
// `.github/workflows/`. GitHub rejects those pushes from a token without the
// `workflow` scope, and the harness host's OAuth token has only ever carried
// `gist`, `read:org`, and `repo`.
//
// Usage:
//   node scripts/check-github-scope.mjs [--host <host>] [--json]
//
// Exit codes: 0 means the credential may push workflow files; 1 means a classic
// token is missing `workflow` or `repo`/`public_repo`; 2 means the credential
// could not be classified (no gh, unauthenticated, or a fine-grained token whose
// granted permissions GitHub does not expose). Only 0 is a green light.
//
// The probe is `gh api -i user`: its `X-Oauth-Scopes` response header is the
// classic token's granted scopes. The token itself is never read or printed.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOST = 'github.com';

const USAGE = [
  'Usage: node scripts/check-github-scope.mjs [--host <host>] [--json]',
  '',
  'Exit codes: 0 = safe to push .github/workflows/**;',
  '1 = classic token missing repo/public_repo or workflow scope;',
  '2 = could not classify (no gh, unauthenticated, or a fine-grained token).',
].join('\n');

// gh[pousr]_ is an OAuth/PAT token; github_pat_ is a fine-grained PAT. Neither
// should ever reach output, but stderr is echoed on failure, so redact anyway.
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;

export class UsageError extends Error {}

function failUsage(message) {
  throw new UsageError(message);
}

export function parseArgs(argv) {
  const options = { host: DEFAULT_HOST, json: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === '') failUsage('--host needs a hostname');
      options.host = value;
    } else if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length);
      if (value === '') failUsage('--host needs a hostname');
      options.host = value;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      failUsage(`unknown option: ${arg}`);
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Parse an HTTP response header block (`gh api -i` output) into lowercase names
 * mapped to every value seen. Stops at the first blank line after a header so
 * the JSON body is not parsed, and ignores the `HTTP/...` status line. Values
 * may contain `:`, so only the first colon separates name from value.
 */
export function parseHeaders(stdout) {
  const headers = new Map();

  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.trim() === '') {
      if (headers.size > 0) break;
      continue;
    }
    if (/^HTTP\//i.test(line)) continue;

    const colon = line.indexOf(':');
    if (colon <= 0) continue;

    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === '') continue;

    const values = headers.get(name);
    if (values === undefined) headers.set(name, [value]);
    else values.push(value);
  }

  return headers;
}

/** Normalize one or more comma-separated scope lists to a sorted, deduped list. */
export function parseScopes(values) {
  const scopes = new Set();
  for (const value of values ?? []) {
    for (const scope of String(value).split(',')) {
      const name = scope.trim().toLowerCase();
      if (name !== '') scopes.add(name);
    }
  }
  return [...scopes].sort();
}

export function redact(text) {
  return String(text ?? '').replace(TOKEN_PATTERN, '[redacted]');
}

function firstLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((entry) => entry.trim() !== '');
  return line === undefined ? '' : redact(line.trim());
}

function unknown(kind, reason) {
  return {
    kind,
    scopes: [],
    missing: [],
    workflow: null,
    verdict: 'unknown',
    exitCode: 2,
    reason,
  };
}

/**
 * Classify a `gh api -i user` result. Pure: the CLI passes spawnSync's fields in,
 * the tests pass fixtures, and neither path reads the token.
 */
export function classify({ error = null, status = null, stdout = '', stderr = '' }) {
  if (error !== null && error !== undefined) {
    const reason =
      error.code === 'ENOENT'
        ? 'gh CLI not found (set GH_BIN to override)'
        : `could not run gh (${error.code ?? error.message ?? 'unknown error'})`;
    return unknown('unavailable', reason);
  }

  if (status !== 0) {
    const text = `${stderr}\n${stdout}`;
    if (/HTTP 401|bad credentials|authentication/i.test(text)) {
      return unknown('unauthenticated', 'gh is not authenticated; run `gh auth login`');
    }
    const reason = firstLine(stderr) || `gh api exited with status ${String(status)}`;
    return unknown('unavailable', reason);
  }

  const headers = parseHeaders(stdout);
  const rawScopes = headers.get('x-oauth-scopes');
  if (rawScopes === undefined) {
    return unknown(
      'fine-grained',
      'cannot enumerate fine-grained token permissions; ensure Contents: Read and write ' +
        'and Workflows: Read and write',
    );
  }

  const scopes = parseScopes(rawScopes);
  const missing = [];
  if (!scopes.includes('repo') && !scopes.includes('public_repo')) missing.push('repo');
  if (!scopes.includes('workflow')) missing.push('workflow');

  return {
    kind: 'classic',
    scopes,
    missing,
    workflow: scopes.includes('workflow'),
    verdict: missing.length === 0 ? 'ok' : 'missing-scope',
    exitCode: missing.length === 0 ? 0 : 1,
    reason: null,
  };
}

function scopeLabel(scope) {
  return scope === 'repo' ? 'repo (or public_repo)' : scope;
}

export function formatHuman(result, host) {
  const lines = [
    `check-github-scope: ${host}`,
    `  credential: ${result.kind}`,
    `  scopes: ${result.scopes.length === 0 ? 'unknown' : result.scopes.join(', ')}`,
  ];

  if (result.verdict === 'ok') {
    lines.push('OK: this credential can push .github/workflows/** changes.');
    return lines.join('\n');
  }

  if (result.verdict === 'missing-scope') {
    lines.push(`FAIL: missing scope(s): ${result.missing.map(scopeLabel).join(', ')}`);
    lines.push('  GitHub rejects a push that adds or edits `.github/workflows/*` with:');
    lines.push(
      "    refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope",
    );
    lines.push('  Fix the host credential with one of:');
    lines.push(`    gh auth refresh -h ${host} -s workflow`);
    lines.push('    export GH_TOKEN=<classic PAT with repo + workflow>');
    lines.push('    (or a fine-grained PAT with Contents: Read and write, Workflows: Read and write)');
    lines.push('  Do not add a deploy key, switch origin to SSH, or use the API to work around');
    lines.push('  this; stop and report.');
    return lines.join('\n');
  }

  lines.push(`UNKNOWN: ${result.reason} (exit 2 is not a green light)`);
  return lines.join('\n');
}

function probe(host) {
  const bin = process.env.GH_BIN || 'gh';
  const run = spawnSync(bin, ['api', '-i', 'user', '--hostname', host], { encoding: 'utf8' });
  return classify({
    error: run.error ?? null,
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
  });
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`check-github-scope: ${error.message}`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const result = probe(options.host);
  if (options.json) {
    console.log(
      JSON.stringify({
        host: options.host,
        kind: result.kind,
        scopes: result.scopes,
        missing: result.missing,
        workflow: result.workflow,
        verdict: result.verdict,
        exitCode: result.exitCode,
      }),
    );
  } else {
    console.log(formatHuman(result, options.host));
  }
  return result.exitCode;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  process.exitCode = main(process.argv.slice(2));
}
