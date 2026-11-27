import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  PermissionRepair,
  type RepairDeps,
  type RepairResult,
} from './permission-repair.js';

export interface UpgradeRepairResult extends RepairResult {
  /** True when the cutover root has no `upgrades/` directory at all. */
  upgradesMissing: boolean;
}

function scanRun(scan: PermissionRepair, runDir: string): void {
  if (!scan.dir(runDir)) return;
  scan.file(path.join(runDir, 'db-backup.sqlite'));
}

/**
 * Tighten the shared cutover root, upgrade run directories, and snapshots left
 * by an older `deploy/upgrade-vps.sh` (D86/D120). Only `<cutoverRoot>`,
 * `<cutoverRoot>/upgrades`, its direct run directories, and their top-level
 * `db-backup.sqlite` are considered. This never follows a symlinked `upgrades/`,
 * deletes anything, or opens the database; a symlinked root is skipped while its
 * `upgrades/` tree is still scanned through the link.
 */
export function repairUpgradePermissions(
  cutoverRoot: string,
  options: { apply: boolean } & RepairDeps,
): UpgradeRepairResult {
  const scan = new PermissionRepair(options);
  const root = path.resolve(cutoverRoot);

  // The root itself is a chmod target, so never treat the filesystem root as a
  // cutover root.
  if (path.dirname(root) === root) {
    scan.error(root, 'dir', new Error('refusing to repair the filesystem root'));
    return { ...scan.result(false), upgradesMissing: true };
  }

  // A relocated root is left for the operator; `upgrades/` is still scanned
  // through the link exactly as before.
  const rootState = scan.root(root, { symlinks: 'skip' });
  if (rootState !== 'ok') {
    return { ...scan.result(rootState === 'missing'), upgradesMissing: true };
  }

  const upgrades = path.join(root, 'upgrades');
  const upgradesState = scan.root(upgrades);
  if (upgradesState === 'missing') {
    return { ...scan.result(false), upgradesMissing: true };
  }
  if (upgradesState === 'failed') {
    return { ...scan.result(false), upgradesMissing: false };
  }

  let names: string[];
  try {
    names = readdirSync(upgrades).sort();
  } catch (error) {
    scan.error(upgrades, 'dir', error);
    return { ...scan.result(false), upgradesMissing: false };
  }

  for (const name of names) {
    scanRun(scan, path.join(upgrades, name));
  }

  return { ...scan.result(false), upgradesMissing: false };
}
