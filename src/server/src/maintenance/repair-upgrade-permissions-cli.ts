import os from 'node:os';
import path from 'node:path';
import {
  parseRepairArgs,
  printRepairResult,
  runRepairCliIfDirect,
} from './private-path-repair-cli.js';
import {
  repairUpgradePermissions,
  type UpgradeRepairDeps,
  type UpgradeRepairResult,
} from './repair-upgrade-permissions.js';

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
  const root = path.join(os.homedir(), '.aps-cutover');
  const parsed = parseRepairArgs(argv, '--root', root);
  return { apply: parsed.apply, root: parsed.value, help: parsed.help };
}

function printResult(result: UpgradeRepairResult, apply: boolean): void {
  printRepairResult(result, apply, 'not a regular file or directory');
}

export function main(argv: string[] = process.argv.slice(2), deps: UpgradeRepairDeps = {}): number {
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

  printResult(result, options.apply);
  return result.failed > 0 ? 1 : 0;
}

runRepairCliIfDirect(import.meta.url, () => main());
