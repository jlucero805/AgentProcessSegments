import os from 'node:os';
import path from 'node:path';
import { repairRunPermissions } from './repair-run-permissions.js';
import {
  parseRepairArgs,
  printRepairReport,
  repairExitCode,
  runDirectly,
  unsafeRoot,
} from './repair-cli.js';
import type { RepairDeps } from './permission-repair.js';

export interface CliOptions {
  apply: boolean;
  root: string;
  help: boolean;
}

export function usage(): string {
  return [
    'Usage: npm run repair:runs -- [--apply] [--dry-run] [--root DIR]',
    '',
    'Tightens the shared cutover root and the run directories left by an older',
    'deploy/cutover-vps.sh.',
    'Dry run by default; nothing changes without --apply.',
    '',
    '  --apply      chmod the root, the runs directory, and each run directory to 0700',
    '  --dry-run    preview only (the default; useful after --apply)',
    '  --root DIR   cutover root to scan (default: $HOME/.aps-cutover)',
    '  --help, -h   show this text',
    '',
    '<root>, <root>/runs, and each direct run directory are scanned. The runs',
    'directory is examined one level deep. It never follows symlinks, deletes',
    'anything, descends into dist/ or backup/, reads or changes run contents, or',
    'touches upgrades/ or the latest symlink.',
  ].join('\n');
}

export function parseArgs(argv: string[]): CliOptions {
  const args = parseRepairArgs(argv, '--root');
  return {
    apply: args.apply,
    root: args.value ?? path.join(os.homedir(), '.aps-cutover'),
    help: args.help,
  };
}

export function main(argv: string[] = process.argv.slice(2), deps: RepairDeps = {}): number {
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

  const unsafe = unsafeRoot(options.root);
  if (unsafe !== null) {
    console.error(`${unsafe}: ${options.root}`);
    console.error(usage());
    return 1;
  }

  const result = repairRunPermissions(options.root, { apply: options.apply, ...deps });
  if (result.rootMissing) {
    console.log(`nothing to tighten: ${options.root} does not exist`);
    return 0;
  }

  if (result.runsMissing) {
    console.log(`runs directory not found: ${path.join(options.root, 'runs')}`);
  }

  printRepairReport(result, options.apply, 'not a directory');
  return repairExitCode(result);
}

runDirectly(import.meta.url, () => main());
