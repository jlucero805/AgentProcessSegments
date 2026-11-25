import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { branchName, legacyBranchName } from '../clarify/worktree.js';
import { isTerminal, type State } from '../domain/request.js';
import type { ErrorSink } from '../logging/errors.js';

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

export interface CandidateGroup {
  repo: string;
  rows: LegacyBranchRow[];
}

/** The row-update seam shared by the CLI, the sweeper, and terminal cleanup. */
export interface BranchRowWriter {
  migrateLegacyBranch(id: string, from: string, to: string): boolean;
}

/** A checkout prepared once so several rows can share the git probes. */
export interface PreparedRepo {
  repo: string;
  /** Branches checked out in any worktree, or null when the checkout is unusable. */
  checkedOut: Set<string> | null;
  /** Set alongside a null `checkedOut`; labels every row in the checkout. */
  failure: { action: 'skip-no-repo' | 'error'; detail: string } | null;
}

export interface DecideLegacyRowInput {
  repo: PreparedRepo;
  row: LegacyBranchRow;
  apply: boolean;
  git?: GitRunner;
}

export interface RetireLegacyBranchInput {
  repoPath: string;
  row: LegacyBranchRow;
  apply: boolean;
  git?: GitRunner;
}

export interface RetireLegacyBranchForRequestInput {
  repo: BranchRowWriter;
  row: LegacyBranchRow;
  errors?: ErrorSink;
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
 * Resolve a checkout once for a batch of rows. A missing or unreadable git
 * checkout is reported as a `failure` rather than thrown.
 */
export async function prepareRepo(
  repoPath: string,
  git: GitRunner = runGit,
): Promise<PreparedRepo> {
  const repo = path.resolve(repoPath);

  let inside = false;
  if (existsSync(repo)) {
    try {
      inside = (await git(repo, ['rev-parse', '--is-inside-work-tree'])) === 'true';
    } catch {
      inside = false;
    }
  }

  if (!inside) {
    return {
      repo,
      checkedOut: null,
      failure: { action: 'skip-no-repo', detail: `${repo} is not a readable git work tree` },
    };
  }

  try {
    const listed = await git(repo, ['worktree', 'list', '--porcelain']);
    return { repo, checkedOut: parseWorktreeBranches(listed).branches, failure: null };
  } catch (error) {
    return {
      repo,
      checkedOut: null,
      failure: { action: 'error', detail: `cannot read worktrees: ${message(error)}` },
    };
  }
}

/**
 * Decide (and optionally apply) one legacy row in an already-prepared
 * checkout. The row must already be a `sbox/<id>` candidate.
 */
export async function decideLegacyRow(input: DecideLegacyRowInput): Promise<MigrationEntry> {
  const git = input.git ?? runGit;
  const { repo, row, apply } = input;
  const checkedOut = repo.checkedOut;

  if (!checkedOut) {
    const failure = repo.failure ?? {
      action: 'skip-no-repo' as const,
      detail: `${repo.repo} is not a readable git work tree`,
    };
    return entry(repo.repo, row, failure.action, false, failure.detail);
  }

  if (!isTerminal(row.state)) {
    return entry(repo.repo, row, 'skip-inflight', false, `state ${row.state}`);
  }

  const legacy = legacyBranchName(row.id);
  const canonical = branchName(row.id);

  if (checkedOut.has(legacy)) {
    return entry(repo.repo, row, 'skip-checked-out', false);
  }

  try {
    const legacyExists = await refExists(git, repo.repo, legacy);
    const canonicalExists = await refExists(git, repo.repo, canonical);

    if (!legacyExists) {
      return canonicalExists
        ? entry(repo.repo, row, 'repair-db', false, 'legacy ref gone, canonical exists')
        : entry(repo.repo, row, 'skip-missing', false);
    }

    if (!canonicalExists) {
      if (apply) await git(repo.repo, ['branch', '-m', legacy, canonical]);
      return entry(repo.repo, row, 'rename', apply);
    }

    if (!(await isAncestor(git, repo.repo, legacy, canonical))) {
      return entry(repo.repo, row, 'skip-diverged', false, 'manual review');
    }

    if (apply) await git(repo.repo, ['branch', '-D', legacy]);
    return entry(repo.repo, row, 'delete-contained', apply);
  } catch (error) {
    return entry(repo.repo, row, 'error', false, message(error));
  }
}

/**
 * Split legacy rows into per-repository buckets. Named repos are always
 * included, even with no rows, so their orphan `sbox/*` refs get reported.
 */
export function groupCandidates(rows: LegacyBranchRow[], repos: string[]): CandidateGroup[] {
  const named = [...new Set(repos.map((repo) => path.resolve(repo)))];
  if (named.length > 0) {
    return named.map((repo) => ({
      repo,
      rows: rows.filter(
        (row) => row.targetRepo !== null && path.resolve(row.targetRepo) === repo,
      ),
    }));
  }

  const groups = new Map<string, LegacyBranchRow[]>();
  for (const row of rows) {
    if (row.targetRepo === null) continue;
    const repo = path.resolve(row.targetRepo);
    const bucket = groups.get(repo);
    if (bucket) bucket.push(row);
    else groups.set(repo, [row]);
  }
  return [...groups]
    .map(([repo, bucket]) => ({ repo, rows: bucket }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * Decide (and optionally apply) the disposition of every legacy branch in one
 * checkout. One failing branch never stops the others; failures surface as
 * `error` entries. Orphan `sbox/*` refs are reported and never touched.
 */
export async function migrateRepo(input: MigrateRepoInput): Promise<MigrationEntry[]> {
  const git = input.git ?? runGit;
  const prepared = await prepareRepo(input.repoPath, git);
  const knownIds = new Set(input.rows.map((row) => row.id));
  const candidates = input.rows.filter((row) => row.branch === legacyBranchName(row.id));

  if (!prepared.checkedOut) {
    const failure = prepared.failure ?? {
      action: 'skip-no-repo' as const,
      detail: `${prepared.repo} is not a readable git work tree`,
    };
    if (candidates.length === 0) {
      // A named repo with no candidates still reports a missing work tree so an
      // operator can see the `--repo` they asked about. An unreadable worktree
      // list only matters when there is a row to act on.
      return failure.action === 'skip-no-repo'
        ? [
            {
              requestId: null,
              repo: prepared.repo,
              legacyBranch: '',
              canonicalBranch: null,
              action: failure.action,
              applied: false,
              detail: failure.detail,
            },
          ]
        : [];
    }
    return candidates.map((row) => entry(prepared.repo, row, failure.action, false, failure.detail));
  }

  const entries: MigrationEntry[] = [];
  for (const row of candidates) {
    entries.push(await decideLegacyRow({ repo: prepared, row, apply: input.apply, git }));
  }

  try {
    const listed = await git(prepared.repo, [
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
        repo: prepared.repo,
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

/**
 * Apply the row updates for migration entries. Returns how many rows changed;
 * a guarded update that loses a race is reported through `onMiss`.
 */
export function applyMigrationEntries(
  repo: BranchRowWriter,
  entries: MigrationEntry[],
  onMiss?: (entry: MigrationEntry) => void,
): number {
  let changed = 0;
  for (const entry of entries) {
    if (!ROW_MIGRATION_ACTIONS.includes(entry.action)) continue;
    if (entry.requestId === null || entry.canonicalBranch === null) continue;
    if (repo.migrateLegacyBranch(entry.requestId, entry.legacyBranch, entry.canonicalBranch)) {
      changed += 1;
    } else {
      onMiss?.(entry);
    }
  }
  return changed;
}

/** Log only outcomes an operator needs to see; routine skips stay quiet. */
export function logActionableEntry(
  errors: ErrorSink | undefined,
  entry: MigrationEntry,
  phase: string,
): void {
  if (!errors) return;
  if (entry.action !== 'error' && entry.action !== 'skip-diverged') return;
  errors.error('maintenance.legacy-branches', new Error(entry.detail ?? entry.action), {
    requestId: entry.requestId,
    repo: entry.repo,
    action: entry.action,
    phase,
  });
}

/**
 * Retire one row without a repo-wide batch. Returns null for a row that does
 * not store `sbox/<id>`, so callers can invoke this unconditionally.
 */
export async function retireLegacyBranch(
  input: RetireLegacyBranchInput,
): Promise<MigrationEntry | null> {
  if (input.row.branch !== legacyBranchName(input.row.id)) return null;

  const git = input.git ?? runGit;
  const prepared = await prepareRepo(input.repoPath, git);
  return decideLegacyRow({ repo: prepared, row: input.row, apply: input.apply, git });
}

/**
 * Best-effort terminal cleanup. Applies the ref change and the row update, logs
 * only actionable outcomes, and never throws into the caller.
 */
export async function retireLegacyBranchForRequest(
  input: RetireLegacyBranchForRequestInput,
): Promise<MigrationEntry | null> {
  const { row } = input;
  if (
    row.targetRepo === null ||
    !isTerminal(row.state) ||
    row.branch !== legacyBranchName(row.id)
  ) {
    return null;
  }

  try {
    const result = await retireLegacyBranch({
      repoPath: row.targetRepo,
      row,
      apply: true,
      ...(input.git ? { git: input.git } : {}),
    });
    if (!result) return null;

    applyMigrationEntries(input.repo, [result], (missed) => {
      input.errors?.error(
        'maintenance.legacy-branches',
        new Error('request row changed during the run'),
        {
          requestId: missed.requestId,
          repo: missed.repo,
          action: missed.action,
          phase: 'transition',
        },
      );
    });
    logActionableEntry(input.errors, result, 'transition');
    return result;
  } catch (error) {
    input.errors?.error('maintenance.legacy-branches', error, {
      requestId: row.id,
      repo: row.targetRepo,
      phase: 'transition',
    });
    return null;
  }
}
