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

export interface RepairCliResult extends RepairResult {
  /** Set by `repairRunPermissions` when `<root>/runs` is absent. */
  runsMissing?: boolean;
  /** Set by `repairUpgradePermissions` when `<root>/upgrades` is absent. */
  upgradesMissing?: boolean;
}

/** One repair command: its usage text, engine, and missing-path wording. */
export interface RepairCliCommand {
  usage: string;
  parse: (argv: string[]) => RepairArgs;
  /** Resolve the engine target; return an exit code after printing to stop. */
  target: (value: string | null) => { target: string } | { exitCode: number };
  /** Refuse the home directory and the filesystem root before scanning. */
  guardRoot?: boolean;
  /** Full line printed when the engine reports `rootMissing`. */
  missingRoot: (target: string) => string;
  /** Optional one-level subtree whose absence gets a notice. */
  missingSubtree?: { key: 'runsMissing' | 'upgradesMissing'; dir: 'runs' | 'upgrades' };
  /** Detail for a skipped entry that carries none of its own. */
  skipFallback: string;
  run: (target: string, options: { apply: boolean } & RepairDeps) => RepairCliResult;
}

/**
 * Run one permission repair. Every maintenance repair shares this sequence;
 * commands differ only in their usage text, target resolution, guards, engine,
 * and messages.
 */
export function runRepairCli(
  argv: string[],
  deps: RepairDeps,
  command: RepairCliCommand,
): number {
  let options: RepairArgs;
  try {
    options = command.parse(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(command.usage);
    return 1;
  }

  if (options.help) {
    console.log(command.usage);
    return 0;
  }

  const resolved = command.target(options.value);
  if ('exitCode' in resolved) return resolved.exitCode;
  const target = resolved.target;

  if (command.guardRoot === true) {
    const unsafe = unsafeRoot(target);
    if (unsafe !== null) {
      console.error(`${unsafe}: ${target}`);
      console.error(command.usage);
      return 1;
    }
  }

  const result = command.run(target, { apply: options.apply, ...deps });
  if (result.rootMissing) {
    console.log(command.missingRoot(target));
    return 0;
  }

  if (command.missingSubtree !== undefined) {
    const { key, dir } = command.missingSubtree;
    if (result[key]) {
      console.log(`${dir} directory not found: ${path.join(target, dir)}`);
    }
  }

  printRepairReport(result, options.apply, command.skipFallback);
  return repairExitCode(result);
}

/** One cutover repair: its usage text, engine, and missing-subtree notice. */
export interface CutoverRepairCommand {
  usage: string;
  run: (root: string, options: { apply: boolean } & RepairDeps) => RepairCliResult;
  missingSubtree: { key: 'runsMissing' | 'upgradesMissing'; dir: 'runs' | 'upgrades' };
  /** Detail for a skipped entry that carries none of its own. */
  skipFallback: string;
}

/**
 * Run one `repair:runs` or `repair:upgrades` command as a preset over
 * `runRepairCli`: the shared default root, home/root guard, and messages.
 */
export function runCutoverRepairCli(
  argv: string[],
  deps: RepairDeps,
  command: CutoverRepairCommand,
): number {
  return runRepairCli(argv, deps, {
    usage: command.usage,
    parse: (args) => {
      const options = parseCutoverRepairArgs(args);
      return { apply: options.apply, help: options.help, value: options.root };
    },
    target: (value) => ({ target: value ?? defaultCutoverRoot() }),
    guardRoot: true,
    missingRoot: (root) => `nothing to tighten: ${root} does not exist`,
    missingSubtree: command.missingSubtree,
    skipFallback: command.skipFallback,
    run: command.run,
  });
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
