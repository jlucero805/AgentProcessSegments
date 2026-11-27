import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  PermissionRepair,
  type RepairDeps,
  type RepairResult,
} from './permission-repair.js';

/**
 * Tighten the cutover run directories left by an older
 * `deploy/cutover-vps.sh` (D94). Only `<cutoverRoot>/runs` and its direct
 * run directories are considered. This never follows symlinks, deletes
 * anything, reads run contents, or descends into `dist/` or `backup/`.
 */
export function repairRunPermissions(
  cutoverRoot: string,
  options: { apply: boolean } & RepairDeps,
): RepairResult {
  const scan = new PermissionRepair(options);
  const runs = path.join(path.resolve(cutoverRoot), 'runs');

  const rootState = scan.root(runs);
  if (rootState !== 'ok') return scan.result(rootState === 'missing');

  // Tighten the container first so an unreadable directory can be listed in
  // apply mode. An existing ancestor above `runs` is never touched.
  let names: string[];
  try {
    names = readdirSync(runs).sort();
  } catch (error) {
    scan.error(runs, 'dir', error);
    return scan.result(false);
  }

  for (const name of names) {
    scan.dir(path.join(runs, name));
  }

  return scan.result(false);
}
