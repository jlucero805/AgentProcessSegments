import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { branchName, legacyBranchName } from '../clarify/worktree.js';
import { isTerminal, type State } from '../domain/request.js';

const exec = promisify(execFile);

/** A request row with only the fields the migration decides on. */
export interface LegacyBranchRow {
  id: string;
  state: State;
  targetRepo: string | null;
  branch: string | null;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export type MigrationAction =
  | 'rename'
  | 'delete-contained'
  | 'repair-db'
  | 'skip-inflight'
  | 'skip-checked-out'
  | 'skip-diverged'
  | 'skip-missing'
  | 'skip-orphan'
  | 'skip-no-repo'
  | 'error';

export interface MigrationEntry {
  requestId: string | null;
  repo: string;
  legacyBranch: string;
  canonicalBranch: string | null;
  action: MigrationAction;
  /** True only when this run mutated a ref. `repair-db` never does. */
  applied: boolean;
  detail?: string;
}

export interface MigrateRepoInput {
  repoPath: string;
  rows: LegacyBranchRow[];
  apply: boolean;
  git?: GitRunner;
}

/** Results whose ref work (if any) lets the CLI update `requests.branch`. */
export const ROW_MIGRATION_ACTIONS: readonly MigrationAction[] = [
  'rename',
  'delete-contained',
  'repair-db',
];

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

/** Branch names currently checked out, from `git worktree list --porcelain`. */
export function parseWorktreeBranches(porcelain: string): {
  worktrees: string[];
  branches: Set<string>;
} {
  const worktrees: string[] = [];
  const branches = new Set<string>();
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktrees.push(line.slice('worktree '.length).trim());
    } else if (line.startsWith('branch refs/heads/')) {
      branches.add(line.slice('branch refs/heads/'.length).trim());
    }
  }
  return { worktrees, branches };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? Number((error as { code: unknown }).code)
    : undefined;
}

async function refExists(git: GitRunner, repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** True when `ancestor` is reachable from `descendant`; rethrows real git failures. */
async function isAncestor(
  git: GitRunner,
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(repo, [
      'merge-base',
      '--is-ancestor',
      `refs/heads/${ancestor}`,
      `refs/heads/${descendant}`,
    ]);
    return true;
  } catch (error) {
    // `merge-base --is-ancestor` exits 1 for "no", not for a broken invocation.
    if (exitCode(error) === 1) return false;
    throw error;
  }
}

function entry(
  repo: string,
  row: LegacyBranchRow,
  action: MigrationAction,
  applied: boolean,
  detail?: string,
): MigrationEntry {
  return {
    requestId: row.id,
    repo,
    legacyBranch: legacyBranchName(row.id),
    canonicalBranch: branchName(row.id),
    action,
    applied,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Decide (and optionally apply) the disposition of every legacy branch in one
 * checkout. One failing branch never stops the others; failures surface as
 * `error` entries. Orphan `sbox/*` refs are reported and never touched.
 */
export async function migrateRepo(input: MigrateRepoInput): Promise<MigrationEntry[]> {
  const git = input.git ?? runGit;
  const repo = path.resolve(input.repoPath);
  const knownIds = new Set(input.rows.map((row) => row.id));
  const candidates = input.rows.filter((row) => row.branch === legacyBranchName(row.id));

  let inside = false;
  if (existsSync(repo)) {
    try {
      inside = (await git(repo, ['rev-parse', '--is-inside-work-tree'])) === 'true';
    } catch {
      inside = false;
    }
  }

  if (!inside) {
    const detail = `${repo} is not a readable git work tree`;
    if (candidates.length === 0) {
      return [
        {
          requestId: null,
          repo,
          legacyBranch: '',
          canonicalBranch: null,
          action: 'skip-no-repo',
          applied: false,
          detail,
        },
      ];
    }
    return candidates.map((row) => entry(repo, row, 'skip-no-repo', false, detail));
  }

  let checkedOut: Set<string>;
  try {
    const listed = await git(repo, ['worktree', 'list', '--porcelain']);
    checkedOut = parseWorktreeBranches(listed).branches;
  } catch (error) {
    const detail = `cannot read worktrees: ${message(error)}`;
    return candidates.map((row) => entry(repo, row, 'error', false, detail));
  }

  const entries: MigrationEntry[] = [];
  for (const row of candidates) {
    if (!isTerminal(row.state)) {
      entries.push(entry(repo, row, 'skip-inflight', false, `state ${row.state}`));
      continue;
    }

    const legacy = legacyBranchName(row.id);
    const canonical = branchName(row.id);

    if (checkedOut.has(legacy)) {
      entries.push(entry(repo, row, 'skip-checked-out', false));
      continue;
    }

    try {
      const legacyExists = await refExists(git, repo, legacy);
      const canonicalExists = await refExists(git, repo, canonical);

      if (!legacyExists) {
        entries.push(
          canonicalExists
            ? entry(repo, row, 'repair-db', false, 'legacy ref gone, canonical exists')
            : entry(repo, row, 'skip-missing', false),
        );
        continue;
      }

      if (!canonicalExists) {
        if (input.apply) await git(repo, ['branch', '-m', legacy, canonical]);
        entries.push(entry(repo, row, 'rename', input.apply));
        continue;
      }

      if (!(await isAncestor(git, repo, legacy, canonical))) {
        entries.push(entry(repo, row, 'skip-diverged', false, 'manual review'));
        continue;
      }

      if (input.apply) await git(repo, ['branch', '-D', legacy]);
      entries.push(entry(repo, row, 'delete-contained', input.apply));
    } catch (error) {
      entries.push(entry(repo, row, 'error', false, message(error)));
    }
  }

  try {
    const listed = await git(repo, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/sbox/',
    ]);
    for (const ref of listed.split('\n').map((line) => line.trim())) {
      if (!ref.startsWith('sbox/')) continue;
      const id = ref.slice('sbox/'.length);
      if (knownIds.has(id)) continue;
      entries.push({
        requestId: null,
        repo,
        legacyBranch: ref,
        canonicalBranch: null,
        action: 'skip-orphan',
        applied: false,
      });
    }
  } catch {
    // Orphan reporting is informational; a repo without the ref namespace is fine.
  }

  return entries;
}
