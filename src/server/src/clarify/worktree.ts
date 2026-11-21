import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function branchName(requestId: string): string {
  return `sbox/${requestId}`;
}

export interface WorktreeInput {
  targetRepo: string | null;
  requestId: string;
  dataDir: string;
  scratchDir: string;
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
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024 });
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

/**
 * Give the agent a private checkout so two requests never write the same tree.
 * Any git problem falls back to the scratch workdir rather than blocking the request.
 */
export async function ensureWorktree(input: WorktreeInput): Promise<WorktreeResult> {
  const { targetRepo, requestId, dataDir, scratchDir } = input;
  const fallback: WorktreeResult = { cwd: scratchDir, branch: null, isolated: false };

  if (!targetRepo || !existsSync(targetRepo)) return fallback;

  try {
    const inside = await git(targetRepo, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return fallback;

    const repoRoot = await git(targetRepo, ['rev-parse', '--show-toplevel']);
    const branch = branchName(requestId);
    const dir = worktreePath(dataDir, requestId);

    if (existsSync(dir)) return { cwd: dir, branch, isolated: true };

    if (await branchExists(repoRoot, branch)) {
      await git(repoRoot, ['worktree', 'add', dir, branch]);
    } else {
      await git(repoRoot, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
    }

    return { cwd: dir, branch, isolated: true };
  } catch {
    return fallback;
  }
}

/** Remove the checkout but keep the branch, since the work itself is the record. */
export async function removeWorktree(input: WorktreeInput): Promise<void> {
  const { targetRepo, requestId } = input;
  if (!targetRepo) return;

  const dir = worktreePath(input.dataDir, requestId);
  if (!existsSync(dir)) return;

  try {
    const repoRoot = await git(targetRepo, ['rev-parse', '--show-toplevel']);
    await git(repoRoot, ['worktree', 'remove', '--force', dir]);
    await git(repoRoot, ['worktree', 'prune']);
  } catch {
    // A stale worktree is bookkeeping, never a reason to fail the transition.
  }
}
