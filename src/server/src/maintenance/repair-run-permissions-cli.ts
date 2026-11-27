import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatMode } from './repair-permissions.js';
import {
  repairRunPermissions,
  type RunRepairDeps,
  type RunRepairResult,
} from './repair-run-permissions.js';

export interface CliOptions {
  apply: boolean;
  root: string;
  help: boolean;
}

export function usage(): string {
  return [
    'Usage: npm run repair:runs -- [--apply] [--dry-run] [--root DIR]',
    '',
    'Tightens cutover run directories left by an older deploy/cutover-vps.sh.',
    'Dry run by default; nothing changes without --apply.',
    '',
    '  --apply      chmod the runs directory and each run directory to 0700',
    '  --dry-run    preview only (the default; useful after --apply)',
    '  --root DIR   cutover root to scan (default: $HOME/.aps-cutover)',
    '  --help, -h   show this text',
    '',
    'Only <root>/runs is scanned, one level deep: the runs/ directory and each',
    'direct run directory. It never follows symlinks, deletes anything, descends',
    'into dist/ or backup/, reads run contents, or touches upgrades/.',
  ].join('\n');
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    root: path.join(os.homedir(), '.aps-cutover'),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--root needs a directory');
      options.root = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printResult(result: RunRepairResult, apply: boolean): void {
  for (const entry of result.entries) {
    if (entry.action === 'private') continue;
    if (entry.action === 'skip') {
      console.log(`skip             ${entry.path} (${entry.detail ?? 'not a directory'})`);
      continue;
    }
    if (entry.action === 'error') {
      console.error(`error            ${entry.path}: ${entry.detail ?? 'unknown error'}`);
      continue;
    }

    const was = entry.mode === null ? 'missing' : formatMode(entry.mode);
    console.log(
      `${apply ? 'chmod' : 'would chmod'} ${formatMode(entry.target)}  ${entry.path}  (was ${was})`,
    );
  }

  console.log('');
  console.log(
    `${result.tightened} ${apply ? 'tightened' : 'pending'}, ` +
      `${result.private} already private, ${result.skipped} skipped, ` +
      `${result.failed} error(s)`,
  );
  if (!apply && result.tightened > 0) {
    console.log('Re-run with --apply to make these changes.');
  }
}

export function main(argv: string[] = process.argv.slice(2), deps: RunRepairDeps = {}): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 1;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const result = repairRunPermissions(options.root, { apply: options.apply, ...deps });
  if (result.rootMissing) {
    console.log(`nothing to tighten: ${path.join(options.root, 'runs')} does not exist`);
    return 0;
  }

  printResult(result, options.apply);
  return result.failed > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const code = main();
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
