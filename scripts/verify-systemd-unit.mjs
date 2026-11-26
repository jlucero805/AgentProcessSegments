#!/usr/bin/env node
// Verify the deploy systemd unit with systemd-analyze. systemd-analyze exits 0
// for some unit-file defects (unknown keys, invalid values), so any diagnostic
// naming the unit is fatal here as well as a non-zero exit status.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const DEFAULT_UNIT = 'deploy/agent-process-segments.service';

const USAGE = `Usage: node scripts/verify-systemd-unit.mjs [--unit <path>]

Runs systemd-analyze verify on the deploy unit. Relative paths resolve from
${repoRoot}; the default is ${DEFAULT_UNIT}.`;

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

function displayPath(unitPath) {
  const relative = path.relative(repoRoot, unitPath);
  return relative.startsWith('..') ? unitPath : relative;
}

function verify(unitPath) {
  const display = displayPath(unitPath);
  let target;
  try {
    // systemd-analyze prints the canonical path, which can differ from a
    // symlinked worktree path; match the same path it will report.
    target = realpathSync(unitPath);
  } catch {
    console.error(`verify-systemd-unit: unit file not found: ${display}`);
    return 1;
  }
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aps-systemd-unit-'));
  try {
    const runtimeDir = path.join(temp, 'run');
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const result = spawnSync('systemd-analyze', ['verify', '--man=no', target], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: temp,
        XDG_CONFIG_HOME: path.join(temp, 'config'),
        XDG_DATA_HOME: path.join(temp, 'data'),
        XDG_RUNTIME_DIR: runtimeDir,
      },
    });

    if (result.error) {
      if (result.error.code === 'ENOENT') {
        console.error(
          'verify-systemd-unit: systemd-analyze not found; install systemd (for example: sudo apt-get install systemd)',
        );
      } else {
        console.error(`verify-systemd-unit: ${result.error.message}`);
      }
      return 1;
    }

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const diagnostics = unitDiagnostics(output, target);
    if (result.status !== 0 || diagnostics.length > 0) {
      if (output.trim() !== '') {
        process.stderr.write(output.endsWith('\n') ? output : `${output}\n`);
      }
      if (result.status !== 0) {
        console.error(`verify-systemd-unit: systemd-analyze verify failed for ${display}`);
      } else {
        console.error(
          `verify-systemd-unit: ${diagnostics.length} diagnostic(s) for ${display}`,
        );
      }
      return 1;
    }

    console.log(`systemd-analyze verify: ${display} OK`);
    return 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function main(argv) {
  const unitPath = parseArgs(argv);
  if (process.platform !== 'linux') {
    console.log('SKIPPED: systemd-analyze verify requires Linux');
    return 0;
  }
  return verify(unitPath);
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  process.exitCode = main(process.argv.slice(2));
}
