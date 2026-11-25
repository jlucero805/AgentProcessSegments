import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, requestsDir } from '../config.js';
import {
  formatMode,
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
  const options: CliOptions = { apply: false, dataDir: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--data-dir needs a directory');
      options.dataDir = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printResult(result: RepairResult, apply: boolean): void {
  for (const entry of result.entries) {
    if (entry.action === 'private') continue;
    if (entry.action === 'skip') {
      console.log(`skip             ${entry.path} (${entry.detail ?? 'not a regular file or directory'})`);
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
