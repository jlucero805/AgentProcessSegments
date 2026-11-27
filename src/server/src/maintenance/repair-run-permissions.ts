import { chmodSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIR_MODE, type RepairAction } from './repair-permissions.js';

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

export interface RunRepairDeps {
  chmod?: (file: string, mode: number) => void;
}

interface Context {
  entries: RunRepairEntry[];
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

function addSkip(ctx: Context, target: string, detail: string): void {
  ctx.entries.push({
    path: target,
    kind: 'dir',
    mode: null,
    target: PRIVATE_DIR_MODE,
    action: 'skip',
    detail,
  });
  ctx.skipped += 1;
}

function addError(ctx: Context, target: string, error: unknown): void {
  ctx.entries.push({
    path: target,
    kind: 'dir',
    mode: null,
    target: PRIVATE_DIR_MODE,
    action: 'error',
    detail: errorDetail(error),
  });
  ctx.failed += 1;
}

function consider(ctx: Context, target: string, mode: number): void {
  if (ctx.seen.has(target)) return;
  ctx.seen.add(target);

  const current = mode & 0o777;

  if (current === PRIVATE_DIR_MODE) {
    ctx.entries.push({
      path: target,
      kind: 'dir',
      mode: current,
      target: PRIVATE_DIR_MODE,
      action: 'private',
    });
    ctx.private += 1;
    return;
  }

  if (!ctx.apply) {
    ctx.entries.push({
      path: target,
      kind: 'dir',
      mode: current,
      target: PRIVATE_DIR_MODE,
      action: 'tighten',
    });
    ctx.tightened += 1;
    return;
  }

  try {
    ctx.chmod(target, PRIVATE_DIR_MODE);
    ctx.entries.push({
      path: target,
      kind: 'dir',
      mode: current,
      target: PRIVATE_DIR_MODE,
      action: 'tighten',
    });
    ctx.tightened += 1;
  } catch (error) {
    if (isMissing(error)) {
      addSkip(ctx, target, 'vanished');
    } else {
      ctx.entries.push({
        path: target,
        kind: 'dir',
        mode: current,
        target: PRIVATE_DIR_MODE,
        action: 'error',
        detail: errorDetail(error),
      });
      ctx.failed += 1;
    }
  }
}

/**
 * Inspect one direct child of `runs/`. A missing child is silent because
 * retention may remove a run while the scan is in progress.
 */
function inspect(ctx: Context, target: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (!isMissing(error)) addError(ctx, target, error);
    return;
  }

  if (stat.isSymbolicLink()) {
    addSkip(ctx, target, 'symlink');
    return;
  }
  if (!stat.isDirectory()) {
    addSkip(ctx, target, 'not a directory');
    return;
  }

  consider(ctx, target, stat.mode);
}

function result(ctx: Context, rootMissing: boolean): RunRepairResult {
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
 * Tighten the cutover run directories left by an older
 * `deploy/cutover-vps.sh` (D94). Only `<cutoverRoot>/runs` and its direct
 * run directories are considered. This never follows symlinks, deletes
 * anything, reads run contents, or descends into `dist/` or `backup/`.
 */
export function repairRunPermissions(
  cutoverRoot: string,
  options: { apply: boolean } & RunRepairDeps,
): RunRepairResult {
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
  const runs = path.join(path.resolve(cutoverRoot), 'runs');

  let rootStat: Stats;
  try {
    rootStat = lstatSync(runs);
  } catch (error) {
    if (isMissing(error)) return result(ctx, true);
    addError(ctx, runs, error);
    return result(ctx, false);
  }

  if (rootStat.isSymbolicLink()) {
    addError(ctx, runs, new Error('is a symbolic link'));
    return result(ctx, false);
  }
  if (!rootStat.isDirectory()) {
    addError(ctx, runs, new Error('not a directory'));
    return result(ctx, false);
  }

  // Tighten the container first so an unreadable directory can be listed in
  // apply mode. An existing ancestor above `runs` is never touched.
  consider(ctx, runs, rootStat.mode);

  let names: string[];
  try {
    names = readdirSync(runs).sort();
  } catch (error) {
    addError(ctx, runs, error);
    return result(ctx, false);
  }

  for (const name of names) {
    inspect(ctx, path.join(runs, name));
  }

  return result(ctx, false);
}
