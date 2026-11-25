import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchName, legacyBranchName } from '../src/clarify/worktree.js';
import { openDb } from '../src/db.js';
import type { State } from '../src/domain/request.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { LegacyBranchSweeper } from '../src/maintenance/legacy-branch-sweeper.js';
import type { GitRunner } from '../src/maintenance/legacy-branches.js';
import { RequestRepository } from '../src/requests/repository.js';
import { tmpDir } from './tmp.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = tmpDir('sweeper');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  );
  return dir;
}

function branchTip(repo: string, branch: string): string | null {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    return null;
  }
}

function makeRequest(
  repo: RequestRepository,
  state: State,
  targetRepo: string | null,
  legacy = true,
): { id: string } {
  const request = repo.create({ title: 'Sweep me', targetRepo });
  if (state === 'dropped') repo.transition(request.id, 'dropped');
  else if (state === 'dispatch') repo.transition(request.id, 'dispatch');
  if (legacy) repo.setBranch(request.id, legacyBranchName(request.id));
  return request;
}

function errorSink(): { errors: ErrorSink; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    errors: {
      error: (source, error, context) => calls.push({ source, error, ...(context ?? {}) }),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('legacy branch sweeper', () => {
  it('catches up terminal rows and leaves live or canonical rows alone', async () => {
    const repoDir = makeRepo();
    const db = openDb(':memory:');
    try {
      const requests = new RequestRepository(db);
      const done = makeRequest(requests, 'dropped', repoDir);
      const live = makeRequest(requests, 'dispatch', repoDir);
      const canonical = makeRequest(requests, 'dropped', repoDir, false);
      requests.setBranch(canonical.id, branchName(canonical.id));
      const noRepo = makeRequest(requests, 'dropped', null);

      git(repoDir, ['branch', legacyBranchName(done.id)]);
      git(repoDir, ['branch', legacyBranchName(live.id)]);
      git(repoDir, ['branch', legacyBranchName(canonical.id)]);
      git(repoDir, ['branch', legacyBranchName(noRepo.id)]);

      const sweeper = new LegacyBranchSweeper({ repo: requests });
      const result = await sweeper.runOnce();

      expect(result.migrated).toBe(1);
      expect(branchTip(repoDir, legacyBranchName(done.id))).toBeNull();
      expect(branchTip(repoDir, branchName(done.id))).not.toBeNull();
      expect(requests.require(done.id).branch).toBe(branchName(done.id));

      expect(branchTip(repoDir, legacyBranchName(live.id))).not.toBeNull();
      expect(branchTip(repoDir, branchName(live.id))).toBeNull();
      expect(requests.require(live.id).branch).toBe(legacyBranchName(live.id));

      expect(branchTip(repoDir, legacyBranchName(canonical.id))).not.toBeNull();
      expect(requests.require(canonical.id).branch).toBe(branchName(canonical.id));
    } finally {
      db.close();
    }
  });

  it('skips a row with a live turn', async () => {
    const repoDir = makeRepo();
    const db = openDb(':memory:');
    try {
      const requests = new RequestRepository(db);
      const request = makeRequest(requests, 'dropped', repoDir);
      git(repoDir, ['branch', legacyBranchName(request.id)]);

      const sweeper = new LegacyBranchSweeper({
        repo: requests,
        isBusy: (id) => id === request.id,
      });
      const result = await sweeper.runOnce();

      expect(result.migrated).toBe(0);
      expect(branchTip(repoDir, legacyBranchName(request.id))).not.toBeNull();
      expect(requests.require(request.id).branch).toBe(legacyBranchName(request.id));
    } finally {
      db.close();
    }
  });

  it('logs a git failure and still resolves', async () => {
    const repoDir = makeRepo();
    const db = openDb(':memory:');
    try {
      const requests = new RequestRepository(db);
      const request = makeRequest(requests, 'dropped', repoDir);
      git(repoDir, ['branch', legacyBranchName(request.id)]);

      const { errors, calls } = errorSink();
      const failingGit: GitRunner = async (cwd, args) => {
        if (args[0] === 'worktree') throw new Error('boom');
        return git(cwd, args);
      };
      const sweeper = new LegacyBranchSweeper({ repo: requests, errors, git: failingGit });

      const result = await sweeper.runOnce();

      expect(result.errors).toBe(1);
      expect(branchTip(repoDir, legacyBranchName(request.id))).not.toBeNull();
      expect(calls).toEqual([
        expect.objectContaining({
          source: 'maintenance.legacy-branches',
          action: 'error',
          phase: 'sweep',
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('joins a concurrent run instead of starting a second sweep', async () => {
    const db = openDb(':memory:');
    try {
      const requests = new RequestRepository(db);
      const sweeper = new LegacyBranchSweeper({ repo: requests });

      const first = sweeper.runOnce();
      const second = sweeper.runOnce();

      expect(second).toBe(first);
      await first;
    } finally {
      db.close();
    }
  });

  it('stops scheduling passes after stop()', async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => []);
    const sweeper = new LegacyBranchSweeper({
      repo: { list, migrateLegacyBranch: () => true },
      intervalMs: 1000,
    });

    sweeper.start();
    expect(list).toHaveBeenCalledTimes(1);
    await sweeper.runOnce();
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(list).toHaveBeenCalledTimes(1);
  });
});
