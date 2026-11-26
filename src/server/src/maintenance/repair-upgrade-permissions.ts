import { chmodSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import path from 'node:path';
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  type RepairAction,
} from './repair-permissions.js';

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

export interface UpgradeRepairDeps {
  chmod?: (file: string, mode: number) => void;
}

interface Context {
  entries: UpgradeRepairEntry[];
  tightened: number;
  private: number;
  skipped: number;
  failed: number;
  apply: boolean;
  chmod: (file: string, mode: number) => void;
  seen: Set<string>;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function addSkip(
  ctx: Context,
  target: string,
  kind: UpgradeRepairEntry['kind'],
  detail: string,
): void {
  const targetMode = kind === 'file' ? PRIVATE_FILE_MODE : PRIVATE_DIR_MODE;
  ctx.entries.push({ path: target, kind, mode: null, target: targetMode, action: 'skip', detail });
  ctx.skipped += 1;
}

function addError(
  ctx: Context,
  target: string,
  kind: UpgradeRepairEntry['kind'],
  error: unknown,
): void {
  ctx.entries.push({
    path: target,
    kind,
    mode: null,
    target: kind === 'file' ? PRIVATE_FILE_MODE : PRIVATE_DIR_MODE,
    action: 'error',
    detail: errorDetail(error),
  });
  ctx.failed += 1;
}

function consider(
  ctx: Context,
  target: string,
  kind: UpgradeRepairEntry['kind'],
  mode: number,
): void {
  if (ctx.seen.has(target)) return;
  ctx.seen.add(target);

  const current = mode & 0o777;
  const wanted = kind === 'dir' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;

  if (current === wanted) {
    ctx.entries.push({ path: target, kind, mode: current, target: wanted, action: 'private' });
    ctx.private += 1;
    return;
  }

  if (!ctx.apply) {
    ctx.entries.push({ path: target, kind, mode: current, target: wanted, action: 'tighten' });
    ctx.tightened += 1;
    return;
  }

  try {
    ctx.chmod(target, wanted);
    ctx.entries.push({ path: target, kind, mode: current, target: wanted, action: 'tighten' });
    ctx.tightened += 1;
  } catch (error) {
    if (isMissing(error)) {
      addSkip(ctx, target, kind, 'vanished');
    } else {
      ctx.entries.push({
        path: target,
        kind,
        mode: current,
        target: wanted,
        action: 'error',
        detail: errorDetail(error),
      });
      ctx.failed += 1;
    }
  }
}

/**
 * Inspect one known path. A missing artifact is silent because old or partial
 * runs may not have a snapshot.
 */
function inspect(
  ctx: Context,
  target: string,
  kind: UpgradeRepairEntry['kind'],
): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (!isMissing(error)) addError(ctx, target, kind, error);
    return false;
  }

  if (stat.isSymbolicLink()) {
    addSkip(ctx, target, kind, 'symlink');
    return false;
  }
  if (kind === 'dir' && !stat.isDirectory()) {
    addSkip(ctx, target, kind, 'not a directory');
    return false;
  }
  if (kind === 'file' && !stat.isFile()) {
    addSkip(ctx, target, kind, 'not a regular file');
    return false;
  }

  consider(ctx, target, kind, stat.mode);
  return true;
}

function scanRun(ctx: Context, runDir: string): void {
  if (!inspect(ctx, runDir, 'dir')) return;
  inspect(ctx, path.join(runDir, 'db-backup.sqlite'), 'file');
}

function result(ctx: Context, rootMissing: boolean): UpgradeRepairResult {
  return {
    entries: ctx.entries,
    tightened: ctx.tightened,
    private: ctx.private,
    skipped: ctx.skipped,
    failed: ctx.failed,
    rootMissing,
  };
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
  const ctx: Context = {
    entries: [],
    tightened: 0,
    private: 0,
    skipped: 0,
    failed: 0,
    apply: options.apply,
    chmod: options.chmod ?? chmodSync,
    seen: new Set<string>(),
  };
  const upgrades = path.join(path.resolve(cutoverRoot), 'upgrades');

  let rootStat: Stats;
  try {
    rootStat = lstatSync(upgrades);
  } catch (error) {
    if (isMissing(error)) return result(ctx, true);
    addError(ctx, upgrades, 'dir', error);
    return result(ctx, false);
  }

  if (rootStat.isSymbolicLink()) {
    addError(ctx, upgrades, 'dir', new Error('is a symbolic link'));
    return result(ctx, false);
  }
  if (!rootStat.isDirectory()) {
    addError(ctx, upgrades, 'dir', new Error('not a directory'));
    return result(ctx, false);
  }

  // Tighten the container first so an unreadable directory can be listed in
  // apply mode. An existing ancestor above `upgrades` is never touched.
  consider(ctx, upgrades, 'dir', rootStat.mode);

  let names: string[];
  try {
    names = readdirSync(upgrades).sort();
  } catch (error) {
    addError(ctx, upgrades, 'dir', error);
    return result(ctx, false);
  }

  for (const name of names) {
    scanRun(ctx, path.join(upgrades, name));
  }

  return result(ctx, false);
}
