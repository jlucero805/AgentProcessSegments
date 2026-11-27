import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it } from 'vitest';
import {
  branchName,
  ensureWorktree,
  removeWorktree,
  removeWorktreeAt,
} from '../src/clarify/worktree.js';
import { ErrorLogger, type ErrorSink } from '../src/logging/errors.js';

function tempDir(): string {
  return tmpDir('wt');
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

interface ErrorCall {
  source: string;
  error: unknown;
  context: Record<string, unknown>;
}

function recordingSink(): { calls: ErrorCall[]; errors: ErrorSink } {
  const calls: ErrorCall[] = [];
  return {
    calls,
    errors: {
      error: (source, error, context) => calls.push({ source, error, context: context ?? {} }),
    },
  };
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

  it('falls back silently when a request has no target repo', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const { calls, errors } = recordingSink();

    const result = await ensureWorktree({
      targetRepo: null,
      requestId: 'req-e',
      dataDir: path.join(base, 'data'),
      scratchDir,
      errors,
    });

    expect(result).toEqual({ cwd: scratchDir, branch: null, isolated: false });
    expect(calls).toEqual([]);
  });

  it('logs a missing target path and falls back to the scratch workdir', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const absent = path.join(base, 'absent');
    const { calls, errors } = recordingSink();

    const result = await ensureWorktree({
      targetRepo: absent,
      requestId: 'req-missing',
      dataDir: path.join(base, 'data'),
      scratchDir,
      errors,
    });

    expect(result).toEqual({ cwd: scratchDir, branch: null, isolated: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: 'engine.worktree',
      context: { request: 'req-missing', targetRepo: absent, stage: 'target-missing' },
    });
    expect((calls[0]?.error as Error).message).toContain('does not exist');
  });

  it('logs a non-repo target and falls back to the scratch workdir', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const plain = tempDir();
    const { calls, errors } = recordingSink();

    const result = await ensureWorktree({
      targetRepo: plain,
      requestId: 'req-plain',
      dataDir: path.join(base, 'data'),
      scratchDir,
      errors,
    });

    expect(result).toEqual({ cwd: scratchDir, branch: null, isolated: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: 'engine.worktree',
      context: { request: 'req-plain', targetRepo: plain, stage: 'inspect' },
    });
    expect((calls[0]?.error as Error).message).toContain('not a git repository');
  });

  it('treats a bare repository as not a work tree', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const bare = tempDir();
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    const { calls, errors } = recordingSink();

    const result = await ensureWorktree({
      targetRepo: bare,
      requestId: 'req-bare',
      dataDir: path.join(base, 'data'),
      scratchDir,
      errors,
    });

    expect(result).toEqual({ cwd: scratchDir, branch: null, isolated: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: 'engine.worktree',
      context: { request: 'req-bare', targetRepo: bare, stage: 'not-a-repo' },
    });
    expect((calls[0]?.error as Error).message).toContain('not a git work tree');
  });

  it('logs a worktree add failure and falls back to the scratch workdir', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const unborn = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: unborn });
    const { calls, errors } = recordingSink();

    const result = await ensureWorktree({
      targetRepo: unborn,
      requestId: 'req-unborn',
      dataDir: path.join(base, 'data'),
      scratchDir,
      errors,
    });

    expect(result).toEqual({ cwd: scratchDir, branch: null, isolated: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: 'engine.worktree',
      context: { request: 'req-unborn', targetRepo: unborn, stage: 'worktree-add' },
    });
    expect((calls[0]?.error as Error).message).toContain('invalid reference: HEAD');
  });

  it('writes one NDJSON record for a failed checkout', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const unborn = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: unborn });
    const file = path.join(base, 'errors.log');
    const logger = new ErrorLogger(file);

    const result = await ensureWorktree({
      targetRepo: unborn,
      requestId: 'req-ndjson',
      dataDir: path.join(base, 'data'),
      scratchDir,
      errors: logger,
    });

    expect(result).toEqual({ cwd: scratchDir, branch: null, isolated: false });
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as {
      source?: string;
      message?: string;
      context?: Record<string, unknown>;
    };
    expect(record.source).toBe('engine.worktree');
    expect(record.message).toContain('invalid reference: HEAD');
    expect(record.context).toMatchObject({
      request: 'req-ndjson',
      targetRepo: unborn,
      stage: 'worktree-add',
    });
  });

  it('does not log a successful checkout', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const { calls, errors } = recordingSink();

    const result = await ensureWorktree({
      targetRepo: repo,
      requestId: 'req-ok',
      dataDir: path.join(base, 'data'),
      scratchDir: path.join(base, 'scratch'),
      errors,
    });

    expect(result.isolated).toBe(true);
    expect(calls).toEqual([]);
  });

  it('falls back without an error sink', async () => {
    const base = tempDir();
    const scratchDir = path.join(base, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const plain = tempDir();

    const result = await ensureWorktree({
      targetRepo: plain,
      requestId: 'req-no-sink',
      dataDir: path.join(base, 'data'),
      scratchDir,
    });

    expect(result).toEqual({ cwd: scratchDir, branch: null, isolated: false });
  });
});

describe('worktree removal helper', () => {
  it('removes a linked checkout through its common repository and keeps the branch', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const input = { dataDir: path.join(base, 'data'), scratchDir: path.join(base, 'scratch') };
    const worktree = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-rm' });

    await removeWorktreeAt(worktree.cwd, repo);

    expect(existsSync(worktree.cwd)).toBe(false);
    expect(branches(repo)).toContain('aps/req-rm');
  });

  it('resolves the common repository from the checkout when no hint is given', async () => {
    const repo = makeRepo();
    const base = tempDir();
    const input = { dataDir: path.join(base, 'data'), scratchDir: path.join(base, 'scratch') };
    const worktree = await ensureWorktree({ ...input, targetRepo: repo, requestId: 'req-orphan' });

    await removeWorktreeAt(worktree.cwd, null);

    expect(existsSync(worktree.cwd)).toBe(false);
    expect(branches(repo)).toContain('aps/req-orphan');
  });

  it('throws for a plain directory and removeWorktree still swallows its failure', async () => {
    const plain = tempDir();
    await expect(removeWorktreeAt(plain, null)).rejects.toThrow();

    const dataDir = path.join(tempDir(), 'data');
    const scratchDir = path.join(tempDir(), 'scratch');
    const dir = path.join(dataDir, 'worktrees', 'req-plain');
    mkdirSync(dir, { recursive: true });

    await expect(
      removeWorktree({
        targetRepo: tempDir(),
        requestId: 'req-plain',
        dataDir,
        scratchDir,
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });
});
