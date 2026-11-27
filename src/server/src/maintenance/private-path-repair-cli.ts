import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatMode, type RepairResult } from './private-path-repair.js';

export interface ParsedRepairArgs<T extends string | null> {
  apply: boolean;
  value: T;
  help: boolean;
}

export function parseRepairArgs(
  argv: string[],
  flag: '--data-dir' | '--root',
  defaultValue: string,
): ParsedRepairArgs<string>;
export function parseRepairArgs(
  argv: string[],
  flag: '--data-dir' | '--root',
  defaultValue: null,
): ParsedRepairArgs<string | null>;
export function parseRepairArgs(
  argv: string[],
  flag: '--data-dir' | '--root',
  defaultValue: string | null,
): ParsedRepairArgs<string | null> {
  const options: ParsedRepairArgs<string | null> = {
    apply: false,
    value: defaultValue,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === flag) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a directory`);
      options.value = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

export function printRepairResult(
  result: RepairResult,
  apply: boolean,
  defaultSkipDetail: string,
): void {
  for (const entry of result.entries) {
    if (entry.action === 'private') continue;
    if (entry.action === 'skip') {
      console.log(`skip             ${entry.path} (${entry.detail ?? defaultSkipDetail})`);
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

export function runRepairCliIfDirect(importMetaUrl: string, main: () => number): void {
  const invokedDirectly =
    process.argv[1] !== undefined && importMetaUrl === pathToFileURL(process.argv[1]).href;
  if (!invokedDirectly) return;

  try {
    const code = main();
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
