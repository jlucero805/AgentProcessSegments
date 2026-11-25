import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { branchName, legacyBranchName } from '../src/clarify/worktree.js';
import { openDb } from '../src/db.js';
import type { State } from '../src/domain/request.js';
import { main, parseArgs } from '../src/maintenance/legacy-branches-cli.js';
import {
  applyMigrationEntries,
  groupCandidates,
  migrateRepo,
  parseWorktreeBranches,
  PRUNE_ACTIONS,
  retireLegacyBranch,
  ROW_MIGRATION_ACTIONS,
  type GitRunner,
  type LegacyBranchRow,
  type MigrationEntry,
} from '../src/maintenance/legacy-branches.js';
import { RequestRepository } from '../src/requests/repository.js';

function tempDir(): string {
  return tmpDir('legacy');
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

function refTip(repo: string, ref: string): string | null {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return null;
  }
}

const realGit: GitRunner = async (cwd, args) => git(cwd, args);

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

  it('reports orphan legacy refs but never deletes them by default', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/no-such-request');

    const entries = await migrateRepo({ repoPath: repo, rows: [], apply: true });

    expect(entries).toEqual([
      expect.objectContaining({ action: 'skip-orphan', legacyBranch: 'sbox/no-such-request' }),
    ]);
    expect(branchTip(repo, 'sbox/no-such-request')).not.toBeNull();
  });

  it('plans an orphan prune without mutating refs in a dry run', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/no-such-request');
    const tip = commitFile(repo, 'sbox/no-such-request', 'orphan.txt', 'orphan');
    const backupRef = `refs/sbox-pruned/no-such-request-${tip}`;

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [],
      pruneOrphans: true,
      apply: false,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        action: 'prune-orphan',
        applied: false,
        legacyBranch: 'sbox/no-such-request',
        backupRef,
      }),
    ]);
    expect(branchTip(repo, 'sbox/no-such-request')).toBe(tip);
    expect(refTip(repo, backupRef)).toBeNull();
  });

  it('archives and deletes an orphan ref only under apply', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/no-such-request');
    const tip = commitFile(repo, 'sbox/no-such-request', 'orphan.txt', 'orphan');
    const backupRef = `refs/sbox-pruned/no-such-request-${tip}`;

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [],
      pruneOrphans: true,
      apply: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({ action: 'prune-orphan', applied: true, backupRef }),
    ]);
    expect(branchTip(repo, 'sbox/no-such-request')).toBeNull();
    expect(refTip(repo, backupRef)).toBe(tip);

    const second = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [],
      pruneOrphans: true,
      apply: true,
    });
    expect(second).toHaveLength(0);
  });

  it('does not prune a ref whose id still has any request row', async () => {
    const repo = makeRepo();
    const id = 'req-still-known';
    createBranch(repo, legacyBranchName(id));

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [id],
      pruneOrphans: true,
      apply: true,
    });

    expect(entries).toHaveLength(0);
    expect(branchTip(repo, legacyBranchName(id))).not.toBeNull();
  });

  it('skips an orphan ref checked out in a linked worktree', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/checked-out-orphan');
    const linked = path.join(tempDir(), 'linked');
    git(repo, ['worktree', 'add', '-q', linked, 'sbox/checked-out-orphan']);

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [],
      pruneOrphans: true,
      apply: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        action: 'skip-orphan-checked-out',
        legacyBranch: 'sbox/checked-out-orphan',
      }),
    ]);
    expect(branchTip(repo, 'sbox/checked-out-orphan')).not.toBeNull();
  });

  it('leaves the branch intact when archiving the orphan tip fails', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/no-such-request');
    const tip = commitFile(repo, 'sbox/no-such-request', 'orphan.txt', 'orphan');
    const failingGit: GitRunner = async (cwd, args) => {
      if (args[0] === 'update-ref' && args[1] !== '-d') throw new Error('backup denied');
      return realGit(cwd, args);
    };

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [],
      pruneOrphans: true,
      apply: true,
      git: failingGit,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        action: 'error',
        applied: false,
        detail: expect.stringContaining('backup denied'),
      }),
    ]);
    expect(branchTip(repo, 'sbox/no-such-request')).toBe(tip);
  });

  it('keeps the archive when the orphan ref moves before deletion', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/no-such-request');
    const tip = commitFile(repo, 'sbox/no-such-request', 'orphan.txt', 'orphan');
    const backupRef = `refs/sbox-pruned/no-such-request-${tip}`;
    const failingGit: GitRunner = async (cwd, args) => {
      if (args[0] === 'update-ref' && args[1] === '-d') throw new Error('ref moved');
      return realGit(cwd, args);
    };

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [],
      pruneOrphans: true,
      apply: true,
      git: failingGit,
    });

    expect(entries).toEqual([
      expect.objectContaining({ action: 'error', applied: false, backupRef }),
    ]);
    expect(branchTip(repo, 'sbox/no-such-request')).toBe(tip);
    expect(refTip(repo, backupRef)).toBe(tip);
  });

  it('tolerates an existing identical backup ref and isolates prune failures', async () => {
    const repo = makeRepo();
    createBranch(repo, 'sbox/already-archived');
    const archivedTip = commitFile(repo, 'sbox/already-archived', 'one.txt', 'one');
    const archivedBackup = `refs/sbox-pruned/already-archived-${archivedTip}`;
    git(repo, ['update-ref', archivedBackup, archivedTip]);

    createBranch(repo, 'sbox/good-orphan');
    const goodTip = commitFile(repo, 'sbox/good-orphan', 'good.txt', 'good');
    createBranch(repo, 'sbox/bad-orphan');
    const badTip = commitFile(repo, 'sbox/bad-orphan', 'bad.txt', 'bad');

    const failingGit: GitRunner = async (cwd, args) => {
      if (args[0] === 'update-ref' && args[1] !== '-d' && args[1].includes('/bad-orphan-')) {
        throw new Error('backup denied');
      }
      return realGit(cwd, args);
    };

    const entries = await migrateRepo({
      repoPath: repo,
      rows: [],
      knownRequestIds: [],
      pruneOrphans: true,
      apply: true,
      git: failingGit,
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'prune-orphan', applied: true, legacyBranch: 'sbox/already-archived' }),
        expect.objectContaining({ action: 'prune-orphan', applied: true, legacyBranch: 'sbox/good-orphan' }),
        expect.objectContaining({ action: 'error', applied: false, legacyBranch: 'sbox/bad-orphan' }),
      ]),
    );
    expect(branchTip(repo, 'sbox/already-archived')).toBeNull();
    expect(branchTip(repo, 'sbox/good-orphan')).toBeNull();
    expect(branchTip(repo, 'sbox/bad-orphan')).toBe(badTip);
    expect(refTip(repo, `refs/sbox-pruned/good-orphan-${goodTip}`)).toBe(goodTip);
  });

  it('keeps PRUNE_ACTIONS separate from row migrations', () => {
    expect(PRUNE_ACTIONS).toEqual(['prune-orphan']);
    expect(ROW_MIGRATION_ACTIONS).not.toContain('prune-orphan');
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

describe('single-row legacy branch retirement', () => {
  it('renames a lone legacy ref for a terminal row', async () => {
    const repo = makeRepo();
    const id = 'req-single';
    createBranch(repo, legacyBranchName(id));
    const tip = commitFile(repo, legacyBranchName(id), 'work.txt', 'legacy');

    const entry = await retireLegacyBranch({
      repoPath: repo,
      row: row(id, 'done', repo),
      apply: true,
    });

    expect(entry).toMatchObject({ action: 'rename', applied: true });
    expect(branchTip(repo, legacyBranchName(id))).toBeNull();
    expect(branchTip(repo, branchName(id))).toBe(tip);
  });

  it('ignores a row that no longer stores the legacy branch', async () => {
    const repo = makeRepo();
    const id = 'req-canonical-single';
    createBranch(repo, legacyBranchName(id));

    const entry = await retireLegacyBranch({
      repoPath: repo,
      row: row(id, 'done', repo, branchName(id)),
      apply: true,
    });

    expect(entry).toBeNull();
    expect(branchTip(repo, legacyBranchName(id))).not.toBeNull();
  });

  it('reports a missing repo without throwing', async () => {
    const absent = path.join(tempDir(), 'missing');
    const entry = await retireLegacyBranch({
      repoPath: absent,
      row: row('req-absent', 'done', absent),
      apply: true,
    });

    expect(entry).toMatchObject({ action: 'skip-no-repo', requestId: 'req-absent' });
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

  it('applies rename and repair entries but skips non-row actions', () => {
    const db = openDb(':memory:');
    try {
      const repo = new RequestRepository(db);
      const renamed = makeRequest(repo, 'dropped');
      const repaired = makeRequest(repo, 'done');
      const diverged = makeRequest(repo, 'done');

      const entries: MigrationEntry[] = [
        {
          requestId: renamed.id,
          repo: '/repo',
          legacyBranch: legacyBranchName(renamed.id),
          canonicalBranch: branchName(renamed.id),
          action: 'rename',
          applied: true,
        },
        {
          requestId: repaired.id,
          repo: '/repo',
          legacyBranch: legacyBranchName(repaired.id),
          canonicalBranch: branchName(repaired.id),
          action: 'repair-db',
          applied: false,
        },
        {
          requestId: diverged.id,
          repo: '/repo',
          legacyBranch: legacyBranchName(diverged.id),
          canonicalBranch: branchName(diverged.id),
          action: 'skip-diverged',
          applied: false,
        },
      ];

      const missed: MigrationEntry[] = [];
      expect(applyMigrationEntries(repo, entries, (entry) => missed.push(entry))).toBe(2);
      expect(repo.require(renamed.id).branch).toBe(branchName(renamed.id));
      expect(repo.require(repaired.id).branch).toBe(branchName(repaired.id));
      expect(repo.require(diverged.id).branch).toBe(legacyBranchName(diverged.id));
      expect(missed).toEqual([]);
      expect(repo.require(renamed.id).updatedAt).toBe(renamed.updatedAt);
    } finally {
      db.close();
    }
  });

  it('reports a row that lost the guarded update race', () => {
    const db = openDb(':memory:');
    try {
      const repo = new RequestRepository(db);
      const request = makeRequest(repo, 'dropped');
      const stale: MigrationEntry = {
        requestId: request.id,
        repo: '/repo',
        legacyBranch: 'sbox/someone-else',
        canonicalBranch: branchName(request.id),
        action: 'rename',
        applied: true,
      };

      const missed: MigrationEntry[] = [];
      expect(applyMigrationEntries(repo, [stale], (entry) => missed.push(entry))).toBe(0);
      expect(missed).toEqual([stale]);
      expect(repo.require(request.id).branch).toBe(legacyBranchName(request.id));
    } finally {
      db.close();
    }
  });
});

describe('legacy branch CLI helpers', () => {
  it('defaults to a dry run and parses apply/prune/repo/db/help', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      pruneOrphans: false,
      repos: [],
      db: null,
      help: false,
    });

    const repoA = path.resolve('repo-a');
    const repoB = path.resolve('repo-b');
    const parsed = parseArgs([
      '--repo',
      repoA,
      '--apply',
      '--prune-orphans',
      '--repo',
      repoB,
      '--db',
      'brain.sqlite',
    ]);
    expect(parsed).toEqual({
      apply: true,
      pruneOrphans: true,
      repos: [repoA, repoB],
      db: path.resolve('brain.sqlite'),
      help: false,
    });

    expect(parseArgs(['--dry-run']).apply).toBe(false);
    expect(parseArgs(['--prune-orphans', '--dry-run'])).toMatchObject({
      apply: false,
      pruneOrphans: true,
    });
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

  it('protects a request id that is not a legacy candidate when pruning orphans', async () => {
    const repoDir = makeRepo();
    const dbPath = path.join(tempDir(), 'brain.sqlite');
    const db = openDb(dbPath);
    const requests = new RequestRepository(db);
    const request = requests.create({ title: 'already migrated', targetRepo: repoDir });
    requests.setBranch(request.id, branchName(request.id));
    db.close();
    createBranch(repoDir, legacyBranchName(request.id));
    const legacyTip = git(repoDir, ['rev-parse', `refs/heads/${legacyBranchName(request.id)}`]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main([
      '--apply',
      '--prune-orphans',
      '--repo',
      repoDir,
      '--db',
      dbPath,
    ]);
    log.mockRestore();

    expect(code).toBe(0);
    expect(branchTip(repoDir, legacyBranchName(request.id))).toBe(legacyTip);
    expect(refTip(repoDir, `refs/sbox-pruned/${request.id}-${legacyTip}`)).toBeNull();
  });

  it('archives and deletes an orphan through the CLI', async () => {
    const repoDir = makeRepo();
    const dbPath = path.join(tempDir(), 'brain.sqlite');
    openDb(dbPath).close();
    createBranch(repoDir, 'sbox/no-such-request');
    const tip = commitFile(repoDir, 'sbox/no-such-request', 'orphan.txt', 'orphan');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main([
      '--apply',
      '--prune-orphans',
      '--repo',
      repoDir,
      '--db',
      dbPath,
    ]);
    log.mockRestore();

    expect(code).toBe(0);
    expect(branchTip(repoDir, 'sbox/no-such-request')).toBeNull();
    expect(refTip(repoDir, `refs/sbox-pruned/no-such-request-${tip}`)).toBe(tip);
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
