import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ErrorSink } from '../logging/errors.js';

const exec = promisify(execFile);

export function branchName(requestId: string): string {
  return `aps/${requestId}`;
}

/** Branches created before the rebrand; reused so in-flight requests keep their checkout. */
export function legacyBranchName(requestId: string): string {
  return `sbox/${requestId}`;
}

export interface WorktreeInput {
  targetRepo: string | null;
  requestId: string;
  dataDir: string;
  scratchDir: string;
}

export interface EnsureWorktreeInput extends WorktreeInput {
  /** Error-only sink; a failed checkout is reported here and never blocks the turn. */
  errors?: ErrorSink;
}

export interface WorktreeResult {
  cwd: string;
  branch: string | null;
  isolated: boolean;
}

export function worktreePath(dataDir: string, requestId: string): string {
  return path.join(dataDir, 'worktrees', requestId);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** The branch a checkout is actually on, or null when it is detached or unreadable. */
async function checkedOutBranch(dir: string): Promise<string | null> {
  try {
    const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Give the agent a private checkout so two requests never write the same tree.
 * Any git problem falls back to the scratch workdir and is reported through the
 * optional sink rather than blocking the request.
 */
export async function ensureWorktree(input: EnsureWorktreeInput): Promise<WorktreeResult> {
  const { targetRepo, requestId, dataDir, scratchDir, errors } = input;
  const fallback: WorktreeResult = { cwd: scratchDir, branch: null, isolated: false };

  const failed = (
    stage: 'target-missing' | 'not-a-repo' | 'inspect' | 'worktree-add',
    error: unknown,
  ): WorktreeResult => {
    errors?.error('engine.worktree', error, { request: requestId, targetRepo, stage });
    return fallback;
  };

  if (!targetRepo) return fallback;
  if (!existsSync(targetRepo)) {
    return failed('target-missing', new Error('target repo does not exist'));
  }

  let stage: 'inspect' | 'worktree-add' = 'inspect';
  try {
    const inside = await git(targetRepo, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') {
      return failed('not-a-repo', new Error('target repo is not a git work tree'));
    }

    const repoRoot = await git(targetRepo, ['rev-parse', '--show-toplevel']);
    const dir = worktreePath(dataDir, requestId);

    if (existsSync(dir)) {
      const branch = await checkedOutBranch(dir);
      return { cwd: dir, branch: branch ?? branchName(requestId), isolated: true };
    }

    // Prefer the canonical prefix, but keep using a legacy branch when it is the
    // only one that exists. Renaming a branch under a live checkout would break it.
    const canonical = branchName(requestId);
    const legacy = legacyBranchName(requestId);
    let branch = canonical;
    let exists = await branchExists(repoRoot, canonical);
    if (!exists && (await branchExists(repoRoot, legacy))) {
      branch = legacy;
      exists = true;
    }

    stage = 'worktree-add';
    if (exists) {
      await git(repoRoot, ['worktree', 'add', dir, branch]);
    } else {
      await git(repoRoot, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
    }

    return { cwd: dir, branch, isolated: true };
  } catch (error) {
    return failed(stage, error);
  }
}

/**
 * The repository that owns a worktree's metadata. In a linked checkout,
 * `--show-toplevel` names the checkout itself, so resolve the common git dir
 * and use its parent when it is a `.git` directory. A bare repo is its own
 * common dir.
 */
async function commonRoot(cwd: string): Promise<string | null> {
  try {
    const common = await git(cwd, ['rev-parse', '--git-common-dir']);
    const resolved = path.isAbsolute(common) ? common : path.resolve(cwd, common);
    return path.basename(resolved) === '.git' ? path.dirname(resolved) : resolved;
  } catch {
    return null;
  }
}

/**
 * Remove one linked checkout and keep its branch. Throws when no repository
 * can be resolved or git refuses, so a caller that wants to retry or report
 * the failure can do so.
 */
export async function removeWorktreeAt(
  dir: string,
  repoHint?: string | null,
): Promise<void> {
  if (!existsSync(dir)) return;

  const root = (await commonRoot(dir)) ?? (repoHint ? await commonRoot(repoHint) : null);
  if (!root) throw new Error(`cannot resolve a git repository for ${dir}`);

  await git(root, ['worktree', 'remove', '--force', dir]);
  try {
    await git(root, ['worktree', 'prune']);
  } catch {
    // The checkout is gone; stale metadata is harmless and pruned next time.
  }
}

/** Drop stale worktree registrations for a repository. */
export async function pruneWorktreeRepo(repo: string): Promise<void> {
  try {
    const root = await commonRoot(repo);
    if (root) await git(root, ['worktree', 'prune']);
  } catch {
    // Repository maintenance must never fail a retention pass.
  }
}

/** Remove the checkout but keep the branch, since the work itself is the record. */
export async function removeWorktree(input: WorktreeInput): Promise<void> {
  const { targetRepo, requestId } = input;
  if (!targetRepo) return;

  const dir = worktreePath(input.dataDir, requestId);
  if (!existsSync(dir)) return;

  try {
    await removeWorktreeAt(dir, targetRepo);
  } catch {
    // A stale worktree is bookkeeping, never a reason to fail the transition.
  }
}
