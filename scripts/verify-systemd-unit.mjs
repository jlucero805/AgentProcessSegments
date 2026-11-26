#!/usr/bin/env node
// Verify the deploy systemd unit with systemd-analyze. systemd-analyze exits 0
// for some unit-file defects (unknown keys, invalid values), so any diagnostic
// naming the unit is fatal here as well as a non-zero exit status. This wrapper
// also pins the reviewed sandboxing directives and the offline exposure
// ceiling: `npm run lint` is the only thing standing between the unit and a
// silent security regression.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const DEFAULT_UNIT = 'deploy/agent-process-segments.service';

// systemd-analyze --threshold is an integer percentage of the overall exposure
// level, so 55 means "must stay below 5.5". The reviewed unit scores 4.3 on
// systemd 259; the headroom absorbs systemd version differences.
const SECURITY_THRESHOLD = 55;
const MIN_SECURITY_SYSTEMD = 250;

const USAGE = `Usage: node scripts/verify-systemd-unit.mjs [--unit <path>]

Runs systemd-analyze verify, checks the reviewed sandboxing directives, and
runs the offline security review on the deploy unit. Relative paths resolve
from ${repoRoot}; the default is ${DEFAULT_UNIT}.`;

/** Sandboxing directives the deploy unit must set, with exact [Service] values. */
export const HARDENING_REQUIRED = {
  NoNewPrivileges: 'yes',
  PrivateTmp: 'yes',
  ProtectSystem: 'full',
  ProtectKernelTunables: 'yes',
  ProtectKernelModules: 'yes',
  ProtectControlGroups: 'yes',
  ProtectKernelLogs: 'yes',
  ProtectClock: 'yes',
  ProtectHostname: 'yes',
  KeyringMode: 'private',
  RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6 AF_NETLINK',
  RestrictRealtime: 'yes',
  RestrictSUIDSGID: 'yes',
  LockPersonality: 'yes',
  SystemCallArchitectures: 'native',
  CapabilityBoundingSet: '',
  AmbientCapabilities: '',
  UMask: '0077',
};

/** Directives that must stay off: the brain needs the capability they remove. */
export const HARDENING_FORBIDDEN = {
  MemoryDenyWriteExecute: ['yes'],
  PrivateNetwork: ['yes'],
  PrivateUsers: ['yes'],
  ProtectHome: ['yes', 'read-only', 'tmpfs'],
};

function fail(message) {
  console.error(`verify-systemd-unit: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  let unit = DEFAULT_UNIT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--unit') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('--unit needs a path');
      }
      unit = value;
      index += 1;
    } else if (arg.startsWith('--unit=')) {
      unit = arg.slice('--unit='.length);
      if (unit === '') fail('--unit needs a path');
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return path.isAbsolute(unit) ? unit : path.join(repoRoot, unit);
}

/** Lines from `systemd-analyze` output that name the unit file under test. */
export function unitDiagnostics(output, unitPath) {
  return output.split('\n').filter((line) => line.startsWith(`${unitPath}:`));
}

/** [Service] directives from unit text; the last assignment wins. */
export function serviceDirectives(unitText) {
  const directives = new Map();
  let section = null;

  for (const rawLine of unitText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    if (section !== 'Service') continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    directives.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }

  return directives;
}

/** Problems with the reviewed sandboxing set, or [] when it matches. */
export function hardeningProblems(unitText) {
  const directives = serviceDirectives(unitText);
  const problems = [];

  for (const [key, expected] of Object.entries(HARDENING_REQUIRED)) {
    if (!directives.has(key)) {
      problems.push(`missing ${key}=${expected}`);
    } else if (directives.get(key) !== expected) {
      problems.push(`${key}=${directives.get(key)} (expected ${expected})`);
    }
  }
  for (const [key, forbidden] of Object.entries(HARDENING_FORBIDDEN)) {
    if (!directives.has(key)) continue;
    const value = directives.get(key);
    if (forbidden.includes(value)) {
      problems.push(`${key}=${value} is not allowed`);
    }
  }

  return problems;
}

/** systemd major version from `systemd-analyze --version`, or null. */
export function systemdVersion(output) {
  const match = /^systemd\s+(\d+)/m.exec(output);
  return match === null ? null : Number(match[1]);
}

function displayPath(unitPath) {
  const relative = path.relative(repoRoot, unitPath);
  return relative.startsWith('..') ? unitPath : relative;
}

function formatLimit() {
  return (SECURITY_THRESHOLD / 10).toFixed(1);
}

function printOutput(output) {
  if (output.trim() === '') return;
  process.stderr.write(output.endsWith('\n') ? output : `${output}\n`);
}

function analyze(args, env) {
  return spawnSync('systemd-analyze', args, { encoding: 'utf8', env });
}

function spawnFailure(result) {
  if (!result.error) return false;
  if (result.error.code === 'ENOENT') {
    console.error(
      'verify-systemd-unit: systemd-analyze not found; install systemd (for example: sudo apt-get install systemd)',
    );
  } else {
    console.error(`verify-systemd-unit: ${result.error.message}`);
  }
  return true;
}

function verifyUnit(target, display, env) {
  const result = analyze(['verify', '--man=no', target], env);
  if (spawnFailure(result)) return 1;

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const diagnostics = unitDiagnostics(output, target);
  if (result.status !== 0 || diagnostics.length > 0) {
    printOutput(output);
    if (result.status !== 0) {
      console.error(`verify-systemd-unit: systemd-analyze verify failed for ${display}`);
    } else {
      console.error(`verify-systemd-unit: ${diagnostics.length} diagnostic(s) for ${display}`);
    }
    return 1;
  }

  console.log(`systemd-analyze verify: ${display} OK`);
  return 0;
}

function securityReview(target, display, env) {
  const version = analyze(['--version'], env);
  if (spawnFailure(version)) return 1;

  const major = systemdVersion(`${version.stdout ?? ''}${version.stderr ?? ''}`);
  if (major === null || major < MIN_SECURITY_SYSTEMD) {
    console.error(
      `verify-systemd-unit: systemd-analyze ${MIN_SECURITY_SYSTEMD} or newer is required for the security review; found ${major ?? 'unknown'}`,
    );
    return 1;
  }

  const result = analyze(
    [
      'security',
      '--offline=yes',
      '--user',
      '--man=no',
      `--threshold=${SECURITY_THRESHOLD}`,
      target,
    ],
    env,
  );
  if (spawnFailure(result)) return 1;

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    printOutput(output);
    console.error(
      `verify-systemd-unit: systemd-analyze security failed for ${display} (exposure limit ${formatLimit()})`,
    );
    console.error(
      `verify-systemd-unit: inspect with: systemd-analyze security --offline=yes --user ${display}`,
    );
    return 1;
  }

  const score = /Overall exposure level[^:]*:\s*([0-9]+(?:\.[0-9]+)?)/.exec(output);
  const measured = score === null ? `within limit ${formatLimit()}` : `${score[1]} (limit ${formatLimit()})`;
  console.log(`systemd-analyze security: ${measured} OK`);
  return 0;
}

function verify(target, display) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aps-systemd-unit-'));
  try {
    const runtimeDir = path.join(temp, 'run');
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      HOME: temp,
      XDG_CONFIG_HOME: path.join(temp, 'config'),
      XDG_DATA_HOME: path.join(temp, 'data'),
      XDG_RUNTIME_DIR: runtimeDir,
    };

    const verified = verifyUnit(target, display, env);
    if (verified !== 0) return verified;
    return securityReview(target, display, env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function main(argv) {
  const unitPath = parseArgs(argv);
  const display = displayPath(unitPath);

  let target;
  let text;
  try {
    // systemd-analyze prints the canonical path, which can differ from a
    // symlinked worktree path; match the same path it will report.
    target = realpathSync(unitPath);
    text = readFileSync(target, 'utf8');
  } catch {
    console.error(`verify-systemd-unit: unit file not found: ${display}`);
    return 1;
  }

  // Runs on every platform so a macOS lint run still catches a loosened unit.
  const problems = hardeningProblems(text);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`verify-systemd-unit: unit hardening: ${problem}`);
    }
    console.error(
      'verify-systemd-unit: update the unit or HARDENING_REQUIRED in this script together',
    );
    return 1;
  }

  if (process.platform !== 'linux') {
    console.log('SKIPPED: systemd-analyze verify and security analysis require Linux');
    return 0;
  }

  return verify(target, display);
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  process.exitCode = main(process.argv.slice(2));
}
