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

describe('per-request git worktrees', () => {
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
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' });
    expect(branches).toContain('sbox/req-d');
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
