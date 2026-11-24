// Choosing the Claude Code binary for the mock smoke.
//
// The smoke's brain env is hermetic (see env.mjs), but the binary the proof runs
// is still operator input. Resolve it explicitly so an inherited harness
// setting cannot turn the documented skip into a misleading failure: every
// candidate must be a regular executable file whose `--version` says "Claude
// Code". An invalid `--claude-bin` fails the run; an invalid inherited
// APS_CLAUDE_BIN/SBOX_CLAUDE_BIN is reported and skipped, and PATH candidates
// are best-effort.
//
// `resolveClaudeBinary` is pure: callers inject the filesystem check and the
// version probe, so tests never spawn a real CLI. `inspectCandidate` and
// `probeClaudeVersion` are the process-backed defaults.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export const PROBE_TIMEOUT_MS = 5_000;

/** The inherited settings consulted after an explicit flag. */
export const CLAUDE_BIN_ENV_NAMES = Object.freeze(['APS_CLAUDE_BIN', 'SBOX_CLAUDE_BIN']);

/** Whether the resolved binary's version output identifies Claude Code. */
export function looksLikeClaude(output) {
  return typeof output === 'string' && /claude/i.test(output);
}

/**
 * Check that a candidate path is an existing regular executable file.
 * Returns `{ ok: true }` or `{ ok: false, reason }` with a short category.
 */
export function inspectCandidate(candidate) {
  let stats;
  try {
    stats = statSync(candidate);
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'does not exist' };
    return { ok: false, reason: `cannot inspect: ${code ?? 'unknown'}` };
  }
  if (!stats.isFile()) return { ok: false, reason: 'not a regular file' };
  try {
    accessSync(candidate, constants.X_OK);
  } catch {
    return { ok: false, reason: 'not executable' };
  }
  return { ok: true };
}

/** Run `<bin> --version` and return its combined output; throws on failure. */
export function probeClaudeVersion(bin) {
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`--version exited ${result.status ?? 'without a status'}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function probeFailureReason(error) {
  if (error?.code === 'ETIMEDOUT') return 'version probe timed out';
  return `version probe failed${error?.code ? `: ${error.code}` : ''}`;
}

function validateCandidate(candidate, { inspect, probe }) {
  const inspected = inspect(candidate);
  if (!inspected?.ok) return { ok: false, reason: inspected?.reason ?? 'not a usable file' };
  let output;
  try {
    output = probe(candidate);
  } catch (error) {
    return { ok: false, reason: probeFailureReason(error) };
  }
  if (!looksLikeClaude(output)) return { ok: false, reason: 'not Claude Code' };
  return { ok: true };
}

function isCommandName(value) {
  return !value.includes('/') && !value.includes('\\');
}

/** Absolute candidate for a path-valued input, or null for a bare command name. */
function candidateFor(value, cwd) {
  return isCommandName(value) ? null : path.resolve(cwd, value);
}

/** First entry in `pathDirs` whose `<dir>/<name>` validates, as an absolute path. */
function scanPath(name, { cwd, pathDirs, inspect, probe }) {
  for (const dir of pathDirs) {
    if (typeof dir !== 'string' || dir === '') continue;
    const candidate = path.resolve(cwd, dir, name);
    if (validateCandidate(candidate, { inspect, probe }).ok) return candidate;
  }
  return null;
}

function validateInput(value, deps) {
  const bin = candidateFor(value, deps.cwd) ?? scanPath(value, deps);
  if (!bin) return { ok: false, path: value, reason: 'not found on PATH' };
  return { ...validateCandidate(bin, deps), path: bin };
}

/**
 * Resolve the Claude Code binary from the flag, the inherited APS/SBOX aliases,
 * then PATH.
 *
 * Returns `{ status: 'ok', bin, source }`, `{ status: 'skip', source, reason,
 * path? }`, or `{ status: 'error', source: 'flag', path, reason }`. The first
 * present source wins: an invalid flag errors instead of falling through, and
 * an invalid inherited value skips instead of trying the next alias.
 */
export function resolveClaudeBinary({
  flag,
  env = {},
  cwd = process.cwd(),
  pathDirs = [],
  inspect = inspectCandidate,
  probe = probeClaudeVersion,
} = {}) {
  const deps = { cwd, pathDirs, inspect, probe };

  if (typeof flag === 'string') {
    const value = flag.trim();
    if (value === '') {
      return {
        status: 'error',
        source: 'flag',
        path: flag,
        reason: '--claude-bin needs a non-empty path',
      };
    }
    const result = validateInput(value, deps);
    if (result.ok) return { status: 'ok', bin: result.path, source: 'flag' };
    return {
      status: 'error',
      source: 'flag',
      path: result.path,
      reason: `--claude-bin ${value}: ${result.reason}`,
    };
  }

  for (const name of CLAUDE_BIN_ENV_NAMES) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = raw.trim();
    const result = validateInput(value, deps);
    if (result.ok) return { status: 'ok', bin: result.path, source: name };
    return {
      status: 'skip',
      source: name,
      path: result.path,
      reason: `${name}=${value}: ${result.reason}`,
    };
  }

  const bin = scanPath('claude', deps);
  if (bin) return { status: 'ok', bin, source: 'PATH' };
  return { status: 'skip', source: 'none', reason: 'no claude binary found on PATH' };
}
