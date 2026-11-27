import { loadConfig, requestsDir } from '../config.js';
import { repairPermissions } from './repair-permissions.js';
import {
  parseRepairArgs,
  runDirectly,
  runRepairCli,
  type RepairArgs,
} from './repair-cli.js';
import type { RepairDeps } from './permission-repair.js';

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
    'opens the database. A symlinked requests/ root is refused (exit 1) and',
    'never followed, so a chmod can never reach an unrelated target. To repair a',
    'relocated tree, point --data-dir at the real parent so requests/ is a real',
    'directory.',
  ].join('\n');
}

function parse(argv: string[]): RepairArgs {
  return parseRepairArgs(argv, '--data-dir');
}

export function parseArgs(argv: string[]): CliOptions {
  const args = parse(argv);
  return { apply: args.apply, dataDir: args.value, help: args.help };
}

export function main(argv: string[] = process.argv.slice(2), deps: RepairDeps = {}): number {
  return runRepairCli(argv, deps, {
    usage: usage(),
    parse,
    target: (value) => {
      if (value !== null) return { target: value };
      try {
        return { target: loadConfig().dataDir };
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return { exitCode: 1 };
      }
    },
    missingRoot: (dataDir) => `nothing to repair: ${requestsDir(dataDir)} does not exist`,
    skipFallback: 'not a regular file or directory',
    run: repairPermissions,
  });
}

runDirectly(import.meta.url, () => main());
