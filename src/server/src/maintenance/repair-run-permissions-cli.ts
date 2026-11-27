import { repairRunPermissions } from './repair-run-permissions.js';
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
  return parseCutoverRepairArgs(argv);
}

export function main(argv: string[] = process.argv.slice(2), deps: RepairDeps = {}): number {
  return runCutoverRepairCli(argv, deps, {
    usage: usage(),
    run: repairRunPermissions,
    missingSubtree: { key: 'runsMissing', dir: 'runs' },
    skipFallback: 'not a directory',
  });
}

runDirectly(import.meta.url, () => main());
