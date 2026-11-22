import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchName, ensureWorktree, removeWorktree } from '../src/clarify/worktree.js';

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'sbox-wt-'));
}

function makeRepo(): string {
  const dir = tempDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], {
    cwd: dir,
  });
  return dir;
}

function createBranch(repo: string, branch: string): string {
  execFileSync('git', ['-C', repo, 'branch', branch]);
  return execFileSync('git', ['-C', repo, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
}

function currentBranch(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
}

function branches(repo: string): string {
  return execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' });
}

describe('per-request git worktrees', () => {
  it('names new branches with the aps prefix', () => {
    expect(branchName('req-a')).toBe('aps/req-a');
  });

  it('gives each request an isolated checkout on its own branch', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const input = { dataDir: path.join(base, 'data'), scratchDir: path.join(base, 'scratch') };

    const a = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-a' });
    expect(a.isolated).toBe(true);
    expect(a.branch).toBe(branchName('req-a'));
    expect(existsSync(a.cwd)).toBe(true);

    writeFileSync(path.join(a.cwd, 'only-a.txt'), 'a');
    expect(existsSync(path.join(repo, 'only-a.txt'))).toBe(false);

    const b = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-b' });
    expect(b.cwd).not.toBe(a.cwd);
    expect(existsSync(path.join(b.cwd, 'only-a.txt'))).toBe(false);

    writeFileSync(path.join(b.cwd, 'only-b.txt'), 'b');
    expect(existsSync(path.join(a.cwd, 'only-b.txt'))).toBe(false);
  });

  it('reuses an existing checkout instead of recreating it', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const input = { dataDir: path.join(base, 'data'), scratchDir: path.join(base, 'scratch') };

    const first = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-c' });
    writeFileSync(path.join(first.cwd, 'kept.txt'), 'kept');
    const second = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-c' });

    expect(second.cwd).toBe(first.cwd);
    expect(existsSync(path.join(first.cwd, 'kept.txt'))).toBe(true);
  });

  it('removes the checkout and keeps the branch', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const input = { dataDir: path.join(base, 'data'), scratchDir: path.join(base, 'scratch') };

    const worktree = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-d' });
    await removeWorktree({ ...input, targetRepo: repo, requestId: 'req-d' });

    expect(existsSync(worktree.cwd)).toBe(false);
    expect(branches(repo)).toContain('aps/req-d');
  });

  it('reuses a legacy sbox branch instead of creating the new prefix', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const input = { dataDir: path.join(base, 'data'), scratchDir: path.join(base, 'scratch') };
    const legacySha = createBranch(repo, 'sbox/req-legacy');

    const first = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-legacy' });
    expect(first.isolated).toBe(true);
    expect(first.branch).toBe('sbox/req-legacy');
    expect(currentBranch(first.cwd)).toBe('sbox/req-legacy');

    const second = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-legacy' });
    expect(second.cwd).toBe(first.cwd);
    expect(second.branch).toBe('sbox/req-legacy');

    expect(branches(repo)).not.toContain('aps/req-legacy');
    const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'refs/heads/sbox/req-legacy'], {
      encoding: 'utf8',
    }).trim();
    expect(ref).toBe(legacySha);
  });

  it('prefers the canonical aps branch when both prefixes exist', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const input = { dataDir: path.join(base, 'data'), scratchDir: path.join(base, 'scratch') };
    const legacySha = createBranch(repo, 'sbox/req-both');
    createBranch(repo, 'aps/req-both');

    const worktree = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-both' });

    expect(worktree.branch).toBe('aps/req-both');
    expect(currentBranch(worktree.cwd)).toBe('aps/req-both');
    expect(branches(repo)).toContain('sbox/req-both');
    const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'refs/heads/sbox/req-both'], {
      encoding: 'utf8',
    }).trim();
    expect(ref).toBe(legacySha);
  });

  it('falls back to the scratch workdir without a repo or with a non-repo path', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const plain = tempDir();

    const noRepo = await ensureWorktree({
      targetRepo: null,
      requestId: 'req-e',
      dataDir: path.join(base, 'data'),
      scratchDir,
    });
    expect(noRepo).toEqual({ cwd: scratchDir, branch: null, isolated: false });

    const notGit = await ensureWorktree({
      targetRepo: plain,
      requestId: 'req-f',
      dataDir: path.join(base, 'data'),
      scratchDir,
    });
    expect(notGit.isolated).toBe(false);
    expect(notGit.cwd).toBe(scratchDir);
  });
});
