import os from 'node:os';
import path from 'node:path';
import { repairUpgradePermissions } from './repair-upgrade-permissions.js';
import {
  parseRepairArgs,
  printRepairReport,
  repairExitCode,
  runDirectly,
} from './repair-cli.js';
import type { RepairDeps } from './permission-repair.js';

export interface CliOptions {
  apply: boolean;
  root: string;
  help: boolean;
}

export function usage(): string {
  return [
    'Usage: npm run repair:upgrades -- [--apply] [--dry-run] [--root DIR]',
    '',
    'Tightens upgrade run directories and database snapshots left by an older',
    'deploy/upgrade-vps.sh. Dry run by default; nothing changes without --apply.',
    '',
    '  --apply      chmod run dirs to 0700 and db-backup.sqlite to 0600',
    '  --dry-run    preview only (the default; useful after --apply)',
    '  --root DIR   cutover root to scan (default: $HOME/.aps-cutover)',
    '  --help, -h   show this text',
    '',
    'Only <root>/upgrades is scanned, one level deep: the upgrades/ directory,',
    'each direct run directory, and each top-level db-backup.sqlite. It never',
    'follows symlinks, deletes anything, touches runs/, or opens the database.',
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

  const result = repairUpgradePermissions(options.root, { apply: options.apply, ...deps });
  if (result.rootMissing) {
    console.log(`nothing to tighten: ${path.join(options.root, 'upgrades')} does not exist`);
    return 0;
  }

  printRepairReport(result, options.apply, 'not a regular file or directory');
  return repairExitCode(result);
}

runDirectly(import.meta.url, () => main());
