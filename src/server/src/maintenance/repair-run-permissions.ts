import { lstatSync, readdirSync, type Stats } from 'node:fs';
import path from 'node:path';
import {
  addError,
  addSkip,
  buildRepairResult,
  consider,
  createRepairContext,
  inspect,
  isMissing,
  type RepairAction,
  type RepairContext,
  type RepairDeps,
  type RepairResult,
} from './private-path-repair.js';

export interface RunRepairEntry {
  path: string;
  kind: 'dir';
  mode: number | null;
  target: number;
  action: RepairAction;
  detail?: string;
}

export interface RunRepairResult {
  entries: RunRepairEntry[];
  /** Entries changed now, or pending when `apply` is false. */
  tightened: number;
  private: number;
  skipped: number;
  failed: number;
  /** True when the cutover root itself does not exist. */
  rootMissing: boolean;
  /** True when the cutover root has no `runs/` directory at all. */
  runsMissing: boolean;
}

export type RunRepairDeps = RepairDeps;

function toRunResult(
  result: RepairResult,
  runsMissing: boolean,
): RunRepairResult {
  // The shared engine only emits the dir kind this command exposes.
  return { ...result, entries: result.entries as RunRepairEntry[], runsMissing };
}

function result(
  ctx: RepairContext,
  rootMissing: boolean,
  runsMissing: boolean,
): RunRepairResult {
  return toRunResult(buildRepairResult(ctx, rootMissing), runsMissing);
}

/**
 * Tighten the shared cutover root and the run directories left by an older
 * `deploy/cutover-vps.sh` (D94/D120). Only `<cutoverRoot>`,
 * `<cutoverRoot>/runs`, and its direct run directories are considered. This
 * never follows symlinks, deletes anything, reads run contents, or descends
 * into `dist/` or `backup/`.
 */
export function repairRunPermissions(
  cutoverRoot: string,
  options: { apply: boolean } & RunRepairDeps,
): RunRepairResult {
  const ctx = createRepairContext(options);
  const root = path.resolve(cutoverRoot);

  // The root itself is now a chmod target, so never treat the filesystem
  // root as a cutover root.
  if (path.dirname(root) === root) {
    addError(ctx, root, 'dir', new Error('refusing to repair the filesystem root'));
    return result(ctx, false, true);
  }

  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if (isMissing(error)) return result(ctx, true, true);
    addError(ctx, root, 'dir', error);
    return result(ctx, false, true);
  }

  if (rootStat.isSymbolicLink()) {
    // A relocated root is left for the operator; `runs/` is still scanned
    // through the link exactly as before.
    addSkip(ctx, root, 'dir', 'symlink');
  } else if (!rootStat.isDirectory()) {
    addError(ctx, root, 'dir', new Error('not a directory'));
    return result(ctx, false, true);
  } else {
    // Tighten the root first so an unreadable root can be listed in apply mode.
    consider(ctx, root, 'dir', rootStat.mode);
  }

  const runs = path.join(root, 'runs');

  let runsStat: Stats;
  try {
    runsStat = lstatSync(runs);
  } catch (error) {
    if (isMissing(error)) return result(ctx, false, true);
    addError(ctx, runs, 'dir', error);
    return result(ctx, false, false);
  }

  if (runsStat.isSymbolicLink()) {
    addError(ctx, runs, 'dir', new Error('is a symbolic link'));
    return result(ctx, false, false);
  }
  if (!runsStat.isDirectory()) {
    addError(ctx, runs, 'dir', new Error('not a directory'));
    return result(ctx, false, false);
  }

  // Tighten the container first so an unreadable directory can be listed in
  // apply mode. Nothing above the root is touched.
  consider(ctx, runs, 'dir', runsStat.mode);

  let names: string[];
  try {
    names = readdirSync(runs).sort();
  } catch (error) {
    addError(ctx, runs, 'dir', error);
    return result(ctx, false, false);
  }

  for (const name of names) {
    inspect(ctx, path.join(runs, name), 'dir');
  }

  return result(ctx, false, false);
}
