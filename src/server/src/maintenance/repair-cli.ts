import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatMode, type RepairResult } from './permission-repair.js';

export interface RepairArgs {
  apply: boolean;
  /** The value of `valueFlag`, resolved against the current directory. */
  value: string | null;
  help: boolean;
}

/** Parse the shared `--apply`/`--dry-run`/`<valueFlag>`/`--help` contract. */
export function parseRepairArgs(argv: string[], valueFlag: string): RepairArgs {
  const args: RepairArgs = { apply: false, value: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--dry-run') {
      args.apply = false;
    } else if (arg === valueFlag) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${valueFlag} needs a directory`);
      args.value = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

/**
 * Print one repair report. Skip and change lines go to stdout, errors to stderr,
 * and every line matches the pre-consolidation output byte for byte.
 */
export function printRepairReport(
  result: RepairResult,
  apply: boolean,
  skipFallback: string,
): void {
  for (const entry of result.entries) {
    if (entry.action === 'private') continue;
    if (entry.action === 'skip') {
      console.log(`skip             ${entry.path} (${entry.detail ?? skipFallback})`);
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

/** Exit 1 when any entry failed; a missing root and a clean scan exit 0. */
export function repairExitCode(result: RepairResult): number {
  return result.failed > 0 ? 1 : 0;
}

/** Run `main` only when this module is the process entry point. */
export function runDirectly(moduleUrl: string, main: () => number): void {
  const invoked =
    process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href;
  if (!invoked) return;

  try {
    const code = main();
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
