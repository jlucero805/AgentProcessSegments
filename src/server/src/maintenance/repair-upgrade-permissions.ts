import path from 'node:path';
import {
  repairPrivateTree,
  type RepairAction,
  type RepairDeps,
  type RepairResult,
} from './private-path-repair.js';

export interface UpgradeRepairEntry {
  path: string;
  kind: 'dir' | 'file';
  mode: number | null;
  target: number;
  action: RepairAction;
  detail?: string;
}

export interface UpgradeRepairResult {
  entries: UpgradeRepairEntry[];
  /** Entries changed now, or pending when `apply` is false. */
  tightened: number;
  private: number;
  skipped: number;
  failed: number;
  /** True when the cutover root has no `upgrades/` directory at all. */
  rootMissing: boolean;
}

export type UpgradeRepairDeps = RepairDeps;

const UPGRADE_CHILD = {
  kind: 'dir',
  missing: 'silent',
  children: [{ name: 'db-backup.sqlite', kind: 'file' }],
} as const;

function toUpgradeResult(result: RepairResult): UpgradeRepairResult {
  // The shared engine only emits the dir/file kinds this command exposes.
  return { ...result, entries: result.entries as UpgradeRepairEntry[] };
}

/**
 * Tighten the upgrade run directories and snapshots left by an older
 * `deploy/upgrade-vps.sh` (D86). Only `<cutoverRoot>/upgrades`, its direct run
 * directories, and their top-level `db-backup.sqlite` are considered. This
 * never follows symlinks, deletes anything, or opens the database.
 */
export function repairUpgradePermissions(
  cutoverRoot: string,
  options: { apply: boolean } & UpgradeRepairDeps,
): UpgradeRepairResult {
  return toUpgradeResult(
    repairPrivateTree(
      path.join(path.resolve(cutoverRoot), 'upgrades'),
      { rootSymlinks: 'reject', child: UPGRADE_CHILD },
      options,
    ),
  );
}
