import { loadConfig, requestsDir } from '../config.js';
import {
  parseRepairArgs,
  printRepairResult,
  runRepairCliIfDirect,
} from './private-path-repair-cli.js';
import {
  repairPermissions,
  type RepairDeps,
  type RepairResult,
} from './repair-permissions.js';

export interface CliOptions {
  apply: boolean;
  dataDir: string | null;
  help: boolean;
}

export function usage(): string {
  return [
    'Usage: npm run repair:permissions -- [--apply] [--dry-run] [--data-dir DIR]',
    '',
    'Tightens existing request/session workdirs created before the owner-only',
    'change. Dry run by default; nothing changes without --apply.',
    '',
    '  --apply          chmod loose request dirs to 0700 and state files to 0600',
    '  --dry-run        preview only (the default; useful after --apply)',
    '  --data-dir DIR   data directory to scan (default: APS_DATA_DIR or configured default)',
    '  --help, -h       show this text',
    '',
    'Only the requests/ tree is scanned: requests/, each session dir, cwd/,',
    'opencode/, session.json, transcript.json, mcp-config.json, and',
    'opencode/opencode.json. It never recurses into cwd/ checkouts and never',
    'opens the database.',
  ].join('\n');
}

export function parseArgs(argv: string[]): CliOptions {
  const parsed = parseRepairArgs(argv, '--data-dir', null);
  return { apply: parsed.apply, dataDir: parsed.value, help: parsed.help };
}

function printResult(result: RepairResult, apply: boolean): void {
  printRepairResult(result, apply, 'not a regular file or directory');
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

  let dataDir: string;
  try {
    dataDir = options.dataDir ?? loadConfig().dataDir;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const result = repairPermissions(dataDir, { apply: options.apply, ...deps });
  if (result.rootMissing) {
    console.log(`nothing to repair: ${requestsDir(dataDir)} does not exist`);
    return 0;
  }

  printResult(result, options.apply);
  return result.failed > 0 ? 1 : 0;
}

runRepairCliIfDirect(import.meta.url, () => main());
