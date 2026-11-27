import { repairUpgradePermissions } from './repair-upgrade-permissions.js';
import {
  parseCutoverRepairArgs,
  runCutoverRepairCli,
  runDirectly,
  type CutoverRepairOptions,
} from './repair-cli.js';
import type { RepairDeps } from './permission-repair.js';

export type CliOptions = CutoverRepairOptions;

export function usage(): string {
  return [
    'Usage: npm run repair:upgrades -- [--apply] [--dry-run] [--root DIR]',
    '',
    'Tightens the shared cutover root, upgrade run directories, and database',
    'snapshots left by an older deploy/upgrade-vps.sh.',
    'Dry run by default; nothing changes without --apply.',
    '',
    '  --apply      chmod the root and run dirs to 0700 and db-backup.sqlite to 0600',
    '  --dry-run    preview only (the default; useful after --apply)',
    '  --root DIR   cutover root to scan (default: $HOME/.aps-cutover)',
    '  --help, -h   show this text',
    '',
    '<root>, <root>/upgrades, each direct run directory, and each top-level',
    'db-backup.sqlite are scanned. The upgrades directory is examined one level',
    'deep. It never follows symlinks, deletes anything, opens the database, or',
    'touches runs/ or the latest symlink.',
  ].join('\n');
}

export function parseArgs(argv: string[]): CliOptions {
  return parseCutoverRepairArgs(argv);
}

export function main(argv: string[] = process.argv.slice(2), deps: RepairDeps = {}): number {
  return runCutoverRepairCli(argv, deps, {
    usage: usage(),
    run: repairUpgradePermissions,
    missingSubtree: { key: 'upgradesMissing', dir: 'upgrades' },
    skipFallback: 'not a regular file or directory',
  });
}

runDirectly(import.meta.url, () => main());
