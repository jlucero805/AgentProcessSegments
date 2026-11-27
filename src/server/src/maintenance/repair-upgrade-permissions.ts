import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  PermissionRepair,
  type RepairDeps,
  type RepairResult,
} from './permission-repair.js';

function scanRun(scan: PermissionRepair, runDir: string): void {
  if (!scan.dir(runDir)) return;
  scan.file(path.join(runDir, 'db-backup.sqlite'));
}

/**
 * Tighten the upgrade run directories and snapshots left by an older
 * `deploy/upgrade-vps.sh` (D86). Only `<cutoverRoot>/upgrades`, its direct run
 * directories, and their top-level `db-backup.sqlite` are considered. This
 * never follows symlinks, deletes anything, or opens the database.
 */
export function repairUpgradePermissions(
  cutoverRoot: string,
  options: { apply: boolean } & RepairDeps,
): RepairResult {
  const scan = new PermissionRepair(options);
  const upgrades = path.join(path.resolve(cutoverRoot), 'upgrades');

  const rootState = scan.root(upgrades);
  if (rootState !== 'ok') return scan.result(rootState === 'missing');

  // Tighten the container first so an unreadable directory can be listed in
  // apply mode. An existing ancestor above `upgrades` is never touched.
  let names: string[];
  try {
    names = readdirSync(upgrades).sort();
  } catch (error) {
    scan.error(upgrades, 'dir', error);
    return scan.result(false);
  }

  for (const name of names) {
    scanRun(scan, path.join(upgrades, name));
  }

  return scan.result(false);
}
