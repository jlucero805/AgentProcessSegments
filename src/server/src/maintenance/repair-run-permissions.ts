import path from 'node:path';
import {
  repairPrivateTree,
  type RepairAction,
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
  /** True when the cutover root has no `runs/` directory at all. */
  rootMissing: boolean;
}

export type RunRepairDeps = RepairDeps;

const RUN_CHILD = { kind: 'dir', missing: 'silent' } as const;

function toRunResult(result: RepairResult): RunRepairResult {
  // The shared engine only emits the dir kind this command exposes.
  return { ...result, entries: result.entries as RunRepairEntry[] };
}

/**
 * Tighten the cutover run directories left by an older
 * `deploy/cutover-vps.sh` (D94). Only `<cutoverRoot>/runs` and its direct
 * run directories are considered. This never follows symlinks, deletes
 * anything, reads run contents, or descends into `dist/` or `backup/`.
 */
export function repairRunPermissions(
  cutoverRoot: string,
  options: { apply: boolean } & RunRepairDeps,
): RunRepairResult {
  return toRunResult(
    repairPrivateTree(
      path.join(path.resolve(cutoverRoot), 'runs'),
      { rootSymlinks: 'reject', child: RUN_CHILD },
      options,
    ),
  );
}
