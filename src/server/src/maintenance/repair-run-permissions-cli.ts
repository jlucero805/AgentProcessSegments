import os from 'node:os';
import path from 'node:path';
import {
  parseRepairArgs,
  printRepairResult,
  runRepairCliIfDirect,
} from './private-path-repair-cli.js';
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
  const root = path.join(os.homedir(), '.aps-cutover');
  const parsed = parseRepairArgs(argv, '--root', root);
  return { apply: parsed.apply, root: parsed.value, help: parsed.help };
}

function printResult(result: RunRepairResult, apply: boolean): void {
  printRepairResult(result, apply, 'not a directory');
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
    console.log(`nothing to tighten: ${options.root} does not exist`);
    return 0;
  }

  if (result.runsMissing) {
    console.log(`runs directory not found: ${path.join(options.root, 'runs')}`);
  }

  printResult(result, options.apply);
  return result.failed > 0 ? 1 : 0;
}

runRepairCliIfDirect(import.meta.url, () => main());
