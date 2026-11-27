import {
  chmodSync,
  lstatSync,
  readdirSync,
  statSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export type RepairAction = 'tighten' | 'private' | 'skip' | 'error';

export interface RepairEntry {
  path: string;
  kind: 'dir' | 'file' | 'other';
  mode: number | null;
  target: number;
  action: RepairAction;
  detail?: string;
}

export interface RepairResult {
  entries: RepairEntry[];
  /** Entries changed now, or pending when `apply` is false. */
  tightened: number;
  private: number;
  skipped: number;
  failed: number;
  /** True when the scan root does not exist at all. */
  rootMissing: boolean;
}

export interface RepairDeps {
  chmod?: (file: string, mode: number) => void;
}

export interface RepairContext {
  entries: RepairEntry[];
  tightened: number;
  private: number;
  skipped: number;
  failed: number;
  apply: boolean;
  chmod: (file: string, mode: number) => void;
  seen: Set<string>;
}

/** A named child below a policy-defined direct child. */
export interface RepairChild {
  name: string;
  kind: 'dir' | 'file';
  children?: readonly RepairChild[];
}

/** The shape applied to every direct child found under the scan root. */
export interface RepairChildPolicy {
  kind: 'dir' | 'file';
  /**
   * `skip` records a `vanished` skip when the child disappears mid-scan;
   * `silent` treats a missing child as normal, like an absent known artifact.
   */
  missing: 'silent' | 'skip';
  children?: readonly RepairChild[];
}

export interface RepairPolicy {
  /**
   * `follow` uses `stat` for the root legacy behavior; `reject` uses `lstat`
   * and reports one error instead of following a root symlink.
   */
  rootSymlinks: 'follow' | 'reject';
  child: RepairChildPolicy;
}

/** Render a POSIX mode as four octal digits, such as `0700`. */
export function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function createRepairContext(options: { apply: boolean } & RepairDeps): RepairContext {
  return {
    entries: [],
    tightened: 0,
    private: 0,
    skipped: 0,
    failed: 0,
    apply: options.apply,
    chmod: options.chmod ?? chmodSync,
    seen: new Set<string>(),
  };
}

export function addSkip(
  ctx: RepairContext,
  target: string,
  kind: RepairEntry['kind'],
  detail: string,
): void {
  const targetMode = kind === 'file' ? PRIVATE_FILE_MODE : PRIVATE_DIR_MODE;
  ctx.entries.push({ path: target, kind, mode: null, target: targetMode, action: 'skip', detail });
  ctx.skipped += 1;
}

export function addError(
  ctx: RepairContext,
  target: string,
  kind: RepairEntry['kind'],
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

export function consider(
  ctx: RepairContext,
  target: string,
  kind: 'dir' | 'file',
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

function inspectNode(
  ctx: RepairContext,
  target: string,
  kind: 'dir' | 'file',
  missing: RepairChildPolicy['missing'],
  children: readonly RepairChild[] = [],
): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (isMissing(error)) {
      if (missing === 'skip') addSkip(ctx, target, kind, 'vanished');
    } else {
      addError(ctx, target, kind, error);
    }
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
  for (const child of children) {
    inspectNode(ctx, path.join(target, child.name), child.kind, 'silent', child.children);
  }
  return true;
}

/**
 * Inspect one known path. Missing artifacts are silent because sessions do not
 * all have the same optional files.
 */
export function inspect(
  ctx: RepairContext,
  target: string,
  kind: 'dir' | 'file',
): boolean {
  return inspectNode(ctx, target, kind, 'silent');
}

export function buildRepairResult(ctx: RepairContext, rootMissing: boolean): RepairResult {
  return {
    entries: ctx.entries,
    tightened: ctx.tightened,
    private: ctx.private,
    skipped: ctx.skipped,
    failed: ctx.failed,
    rootMissing,
  };
}

function scanRoot(
  ctx: RepairContext,
  root: string,
  policy: RepairPolicy,
): RepairResult {
  let rootStat: Stats;
  try {
    rootStat = policy.rootSymlinks === 'follow' ? statSync(root) : lstatSync(root);
  } catch (error) {
    if (isMissing(error)) return buildRepairResult(ctx, true);
    addError(ctx, root, 'dir', error);
    return buildRepairResult(ctx, false);
  }

  if (policy.rootSymlinks === 'reject' && rootStat.isSymbolicLink()) {
    addError(ctx, root, 'dir', new Error('is a symbolic link'));
    return buildRepairResult(ctx, false);
  }
  if (!rootStat.isDirectory()) {
    addError(ctx, root, 'dir', new Error('not a directory'));
    return buildRepairResult(ctx, false);
  }

  // Tighten the container first so an unreadable directory can be listed in
  // apply mode. An existing ancestor above the root is never touched.
  consider(ctx, root, 'dir', rootStat.mode);

  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch (error) {
    addError(ctx, root, 'dir', error);
    return buildRepairResult(ctx, false);
  }

  for (const name of names) {
    inspectNode(
      ctx,
      path.join(root, name),
      policy.child.kind,
      policy.child.missing,
      policy.child.children,
    );
  }

  return buildRepairResult(ctx, false);
}

/**
 * Tighten the selected paths below one root without following symlinks.
 * Callers declare only the root-symlink policy and the shape of each direct
 * child; the mode accounting and output entries stay shared.
 */
export function repairPrivateTree(
  root: string,
  policy: RepairPolicy,
  options: { apply: boolean } & RepairDeps,
): RepairResult {
  return scanRoot(createRepairContext(options), root, policy);
}
