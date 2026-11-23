import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchName, legacyBranchName } from '../src/clarify/worktree.js';
import { openDb } from '../src/db.js';
import type { State } from '../src/domain/request.js';
import { groupCandidates, parseArgs } from '../src/maintenance/legacy-branches-cli.js';
import {
  migrateRepo,
  parseWorktreeBranches,
  ROW_MIGRATION_ACTIONS,
  type LegacyBranchRow,
} from '../src/maintenance/legacy-branches.js';
import { RequestRepository } from '../src/requests/repository.js';

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'aps-legacy-'));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = tempDir();
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

function createBranch(repo: string, branch: string, from = 'HEAD'): void {
  git(repo, ['branch', branch, from]);
}

/** Commit one file on a branch without leaving it checked out in the main tree. */
function commitFile(repo: string, branch: string, name: string, body: string): string {
  const worktree = path.join(tempDir(), 'wt');
  git(repo, ['worktree', 'add', '-q', worktree, branch]);
  writeFileSync(path.join(worktree, name), body);
  git(worktree, ['add', name]);
  git(worktree, ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'extra']);
  const sha = git(worktree, ['rev-parse', 'HEAD']);
  git(repo, ['worktree', 'remove', '--force', worktree]);
  return sha;
}

function row(
  id: string,
  state: State,
  repo: string,
  branch: string | null = legacyBranchName(id),
): LegacyBranchRow {
  return { id, state, targetRepo: repo, branch };
}

describe('legacy branch migration', () => {
  it('parses worktrees and their checked-out branches', () => {
    const parsed = parseWorktreeBranches(
      [
        'worktree /repo',
        'HEAD 1111111',
        'branch refs/heads/main',
        '',
        'worktree /linked',
        'HEAD 2222222',
        'branch refs/heads/sbox/req-2',
        '',
        'worktree /detached',
        'HEAD 3333333',
        'detached',
        '',
        '',
      ].join('\n'),
    );

    expect(parsed.worktrees).toEqual(['/repo', '/linked', '/detached']);
    expect([...parsed.branches].sort()).toEqual(['main', 'sbox/req-2']);
  });

  it('skips every non-terminal request', async () => {
    const repo = makeRepo();
    const states: State[] = ['clarify', 'dispatch', 'review', 'merge', 'finalize'];
    const rows = states.map((state, index) => {
      const id = `live-${index}`;
      createBranch(repo, legacyBranchName(id));
      return row(id, state, repo);
    });

    const entries = await migrateRepo({ repoPath: repo, rows, apply: true });

    expect(entries.map((entry) => entry.action)).toEqual(states.map(() => 'skip-inflight'));
    for (const id of rows.map((item) => item.id)) {
      expect(branchTip(repo, legacyBranchName(id))).not.toBeNull();
      expect(branchTip(repo, branchName(id))).toBeNull();
    }
  });

  it('renames a lone legacy branch only under --apply', async () => {
    const repo = makeRepo();
    const id = 'req-rename';
    createBranch(repo, legacyBranchName(id));
    const tip = commitFile(repo, legacyBranchName(id), 'work.txt', 'legacy');

    const dry = await migrateRepo({ repoPath: repo, rows: [row(id, 'done', repo)], apply: false });
    expect(dry).toHaveLength(1);
    expect(dry[0]).toMatchObject({ action: 'rename', applied: false });
    expect(branchTip(repo, legacyBranchName(id))).toBe(tip);
    expect(branchTip(repo, branchName(id))).toBeNull();

    const applied = await migrateRepo({ repoPath: repo, rows: [row(id, 'done', repo)], apply: true });
    expect(applied[0]).toMatchObject({ action: 'rename', applied: true });
    expect(branchTip(repo, legacyBranchName(id))).toBeNull();
    expect(branchTip(repo, branchName(id))).toBe(tip);
  });

  it('deletes a legacy ref that is fully contained in the canonical branch', async () => {
    const repo = makeRepo();
    const id = 'req-contained';
    createBranch(repo, legacyBranchName(id));
    commitFile(repo, legacyBranchName(id), 'legacy.txt', 'legacy');
    createBranch(repo, branchName(id), legacyBranchName(id));
    const canonicalTip = commitFile(repo, branchName(id), 'canonical.txt', 'canonical');

    const entries = await migrateRepo({ repoPath: repo, rows: [row(id, 'dropped', repo)], apply: true });

    expect(entries[0]).toMatchObject({ action: 'delete-contained', applied: true });
    expect(branchTip(repo, legacyBranchName(id))).toBeNull();
    expect(branchTip(repo, branchName(id))).toBe(canonicalTip);
  });

  it('leaves diverged legacy and canonical branches for manual review', async () => {
    const repo = makeRepo();
    const id = 'req-diverged';
    createBranch(repo, legacyBranchName(id));
    const legacyTip = commitFile(repo, legacyBranchName(id), 'legacy.txt', 'legacy');
    createBranch(repo, branchName(id));
    const canonicalTip = commitFile(repo, branchName(id), 'canonical.txt', 'canonical');

    const entries = await migrateRepo({ repoPath: repo, rows: [row(id, 'done', repo)], apply: true });

    expect(entries[0]).toMatchObject({ action: 'skip-diverged', detail: 'manual review' });
    expect(branchTip(repo, legacyBranchName(id))).toBe(legacyTip);
    expect(branchTip(repo, branchName(id))).toBe(canonicalTip);
  });

  it('skips a legacy branch that is checked out in a worktree', async () => {
    const repo = makeRepo();
    const id = 'req-checkout';
    createBranch(repo, legacyBranchName(id));
    const linked = path.join(tempDir(), 'linked');
    git(repo, ['worktree', 'add', '-q', linked, legacyBranchName(id)]);

    const entries = await migrateRepo({ repoPath: repo, rows: [row(id, 'done', repo)], apply: true });

    expect(entries[0]).toMatchObject({ action: 'skip-checked-out' });
    expect(branchTip(repo, legacyBranchName(id))).not.toBeNull();
    expect(branchTip(repo, branchName(id))).toBeNull();
  });

  it('repairs the row when the legacy ref is gone but the canonical ref exists', async () => {
    const repo = makeRepo();
    const id = 'req-repair';
    createBranch(repo, branchName(id));

    const entries = await migrateRepo({ repoPath: repo, rows: [row(id, 'done', repo)], apply: true });

    expect(entries[0]).toMatchObject({ action: 'repair-db', applied: false });
    expect(branchTip(repo, branchName(id))).not.toBeNull();
  });

  it('reports a missing repo without aborting other repositories', async () => {
    const absent = path.join(tempDir(), 'missing');
    const entries = await migrateRepo({
      repoPath: absent,
      rows: [row('req-missing', 'done', absent)],
      apply: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({ action: 'skip-no-repo', requestId: 'req-missing' }),
    ]);
  });

  it('reports orphan legacy refs but never deletes them', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/no-such-request');

    const entries = await migrateRepo({ repoPath: repo, rows: [], apply: true });

    expect(entries).toEqual([
      expect.objectContaining({ action: 'skip-orphan', legacyBranch: 'sbox/no-such-request' }),
    ]);
    expect(branchTip(repo, 'sbox/no-such-request')).not.toBeNull();
  });

  it('ignores rows that do not store the matching legacy branch', async () => {
    const repo = makeRepo();
    const id = 'req-canonical';
    createBranch(repo, legacyBranchName(id));

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [row(id, 'done', repo, branchName(id))],
      apply: true,
    });

    expect(entries).toHaveLength(0);
    expect(branchTip(repo, legacyBranchName(id))).not.toBeNull();
  });
});

describe('request repository branch backfill', () => {
  function makeRequest(repo: RequestRepository, state: State): { id: string; updatedAt: number } {
    const request = repo.create({ title: 't' });
    const path: Record<State, State[]> = {
      clarify: [],
      dispatch: ['dispatch'],
      review: ['dispatch', 'review'],
      merge: ['dispatch', 'review', 'merge'],
      finalize: ['dispatch', 'review', 'finalize'],
      done: ['dispatch', 'review', 'finalize', 'done'],
      dropped: ['dropped'],
    };
    for (const step of path[state]) repo.transition(request.id, step);
    repo.setBranch(request.id, legacyBranchName(request.id));
    const stored = repo.require(request.id);
    return { id: request.id, updatedAt: stored.updatedAt };
  }

  it('rewrites a terminal row without touching updated_at', () => {
    const db = openDb(':memory:');
    try {
      const repo = new RequestRepository(db);
      const request = makeRequest(repo, 'dropped');

      expect(repo.migrateLegacyBranch(request.id, legacyBranchName(request.id), branchName(request.id))).toBe(true);
      const stored = repo.require(request.id);
      expect(stored.branch).toBe(branchName(request.id));
      expect(stored.updatedAt).toBe(request.updatedAt);
    } finally {
      db.close();
    }
  });

  it('refuses to rewrite a non-terminal row', () => {
    const db = openDb(':memory:');
    try {
      const repo = new RequestRepository(db);
      const request = makeRequest(repo, 'review');

      expect(repo.migrateLegacyBranch(request.id, legacyBranchName(request.id), branchName(request.id))).toBe(false);
      expect(repo.require(request.id).branch).toBe(legacyBranchName(request.id));
    } finally {
      db.close();
    }
  });

  it('refuses to rewrite a row whose stored value no longer matches', () => {
    const db = openDb(':memory:');
    try {
      const repo = new RequestRepository(db);
      const request = makeRequest(repo, 'dropped');

      expect(repo.migrateLegacyBranch(request.id, 'sbox/someone-else', branchName(request.id))).toBe(false);
      expect(repo.require(request.id).branch).toBe(legacyBranchName(request.id));
    } finally {
      db.close();
    }
  });
});

describe('legacy branch CLI helpers', () => {
  it('defaults to a dry run and parses apply/repo/db/help', () => {
    expect(parseArgs([])).toEqual({ apply: false, repos: [], db: null, help: false });

    const repoA = path.resolve('repo-a');
    const repoB = path.resolve('repo-b');
    const parsed = parseArgs(['--repo', repoA, '--apply', '--repo', repoB, '--db', 'brain.sqlite']);
    expect(parsed).toEqual({
      apply: true,
      repos: [repoA, repoB],
      db: path.resolve('brain.sqlite'),
      help: false,
    });

    expect(parseArgs(['--dry-run']).apply).toBe(false);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--repo'])).toThrow(/needs a path/);
    expect(() => parseArgs(['--db', '--apply'])).toThrow(/needs a path/);
  });

  it('groups candidates by resolved repository and keeps empty named repos', () => {
    const base = tempDir();
    const repoA = path.join(base, 'a');
    const repoB = path.join(base, 'b');
    const rows = [
      row('one', 'done', repoA),
      row('two', 'done', repoB),
      row('three', 'done', repoB),
    ];

    expect(groupCandidates(rows, [])).toEqual([
      { repo: repoA, rows: [rows[0]] },
      { repo: repoB, rows: [rows[1], rows[2]] },
    ]);
    expect(groupCandidates(rows, [repoB, 'repo-missing'])).toEqual([
      { repo: repoB, rows: [rows[1], rows[2]] },
      { repo: path.resolve('repo-missing'), rows: [] },
    ]);
  });
});

describe('legacy branch migration end to end', () => {
  it('renames the ref and rewrites the terminal row like the CLI does', async () => {
    const repoDir = makeRepo();
    const db = openDb(':memory:');
    try {
      const repo = new RequestRepository(db);
      const request = repo.create({ title: 'done work', targetRepo: repoDir });
      repo.transition(request.id, 'dropped');
      repo.setBranch(request.id, legacyBranchName(request.id));
      createBranch(repoDir, legacyBranchName(request.id));

      const rows: LegacyBranchRow[] = [
        {
          id: request.id,
          state: 'dropped',
          targetRepo: repoDir,
          branch: legacyBranchName(request.id),
        },
      ];
      const entries = await migrateRepo({ repoPath: repoDir, rows, apply: true });
      const pending = entries.filter((entry) => ROW_MIGRATION_ACTIONS.includes(entry.action));

      const updated = db.transaction(() =>
        pending.map((entry) =>
          repo.migrateLegacyBranch(
            entry.requestId as string,
            entry.legacyBranch,
            entry.canonicalBranch as string,
          ),
        ),
      )();

      expect(updated).toEqual([true]);
      expect(repo.require(request.id).branch).toBe(branchName(request.id));
      expect(branchTip(repoDir, branchName(request.id))).not.toBeNull();
      expect(branchTip(repoDir, legacyBranchName(request.id))).toBeNull();
    } finally {
      db.close();
    }
  });
});
