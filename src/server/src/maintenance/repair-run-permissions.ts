import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  PermissionRepair,
  type RepairDeps,
  type RepairEntry,
  type RepairResult,
} from './permission-repair.js';

export type RunRepairEntry = RepairEntry;
export type RunRepairDeps = RepairDeps;

export interface RunRepairResult extends RepairResult {
  /** True when the cutover root has no `runs/` directory at all. */
  runsMissing: boolean;
}

/**
 * Tighten the shared cutover root and the run directories left by an older
 * `deploy/cutover-vps.sh` (D94/D120). Only `<cutoverRoot>`, `<cutoverRoot>/runs`,
 * and its direct run directories are considered. This never follows a symlinked
 * `runs/`, deletes anything, reads run contents, or descends into `dist/` or
 * `backup/`; a symlinked root is skipped while its `runs/` tree is still scanned
 * through the link.
 */
export function repairRunPermissions(
  cutoverRoot: string,
  options: { apply: boolean } & RepairDeps,
): RunRepairResult {
  const scan = new PermissionRepair(options);
  const root = path.resolve(cutoverRoot);

  // The root itself is a chmod target, so never treat the filesystem root as a
  // cutover root.
  if (path.dirname(root) === root) {
    scan.error(root, 'dir', new Error('refusing to repair the filesystem root'));
    return { ...scan.result(false), runsMissing: true };
  }

  // A relocated root is left for the operator; `runs/` is still scanned through
  // the link exactly as before.
  const rootState = scan.root(root, { symlinks: 'skip' });
  if (rootState !== 'ok') {
    return { ...scan.result(rootState === 'missing'), runsMissing: true };
  }

  const runs = path.join(root, 'runs');
  const runsState = scan.root(runs);
  if (runsState === 'missing') return { ...scan.result(false), runsMissing: true };
  if (runsState === 'failed') return { ...scan.result(false), runsMissing: false };

  let names: string[];
  try {
    names = readdirSync(runs).sort();
  } catch (error) {
    scan.error(runs, 'dir', error);
    return { ...scan.result(false), runsMissing: false };
  }

  for (const name of names) {
    scan.dir(path.join(runs, name));
  }

  return { ...scan.result(false), runsMissing: false };
}
