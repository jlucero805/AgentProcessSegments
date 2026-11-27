import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatMode, type RepairDeps, type RepairResult } from './permission-repair.js';

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

export interface CutoverRepairOptions {
  apply: boolean;
  root: string;
  help: boolean;
}

/** The shared cutover root scanned by `repair:runs` and `repair:upgrades`. */
export function defaultCutoverRoot(): string {
  return path.join(os.homedir(), '.aps-cutover');
}

/** Parse the cutover `--apply`/`--dry-run`/`--root`/`--help` contract. */
export function parseCutoverRepairArgs(argv: string[]): CutoverRepairOptions {
  const args = parseRepairArgs(argv, '--root');
  return {
    apply: args.apply,
    root: args.value ?? defaultCutoverRoot(),
    help: args.help,
  };
}

/**
 * Refuse a scan root that must never be treated as cutover evidence. The root
 * itself is a chmod target, so `--apply --root ~` or `--root /` must fail
 * before the engine inspects or changes anything.
 */
export function unsafeRoot(root: string): string | null {
  const resolved = path.resolve(root);
  if (resolved === path.resolve(os.homedir())) return 'refusing to chmod the home directory';
  if (path.parse(resolved).root === resolved) return 'refusing to chmod the filesystem root';
  return null;
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

export interface CutoverRepairResult extends RepairResult {
  /** Set by `repairRunPermissions` when `<root>/runs` is absent. */
  runsMissing?: boolean;
  /** Set by `repairUpgradePermissions` when `<root>/upgrades` is absent. */
  upgradesMissing?: boolean;
}

/** One cutover repair: its usage text, engine, and missing-subtree notice. */
export interface CutoverRepairCommand {
  usage: string;
  run: (root: string, options: { apply: boolean } & RepairDeps) => CutoverRepairResult;
  missingSubtree: { key: 'runsMissing' | 'upgradesMissing'; dir: 'runs' | 'upgrades' };
  /** Detail for a skipped entry that carries none of its own. */
  skipFallback: string;
}

/**
 * Run one `repair:runs` or `repair:upgrades` command. The cutover repairs share
 * every step except their usage text, engine, subtree notice, and skip detail.
 */
export function runCutoverRepairCli(
  argv: string[],
  deps: RepairDeps,
  command: CutoverRepairCommand,
): number {
  let options: CutoverRepairOptions;
  try {
    options = parseCutoverRepairArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(command.usage);
    return 1;
  }

  if (options.help) {
    console.log(command.usage);
    return 0;
  }

  const unsafe = unsafeRoot(options.root);
  if (unsafe !== null) {
    console.error(`${unsafe}: ${options.root}`);
    console.error(command.usage);
    return 1;
  }

  const result = command.run(options.root, { apply: options.apply, ...deps });
  if (result.rootMissing) {
    console.log(`nothing to tighten: ${options.root} does not exist`);
    return 0;
  }

  const { key, dir } = command.missingSubtree;
  if (result[key]) {
    console.log(`${dir} directory not found: ${path.join(options.root, dir)}`);
  }

  printRepairReport(result, options.apply, command.skipFallback);
  return repairExitCode(result);
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
