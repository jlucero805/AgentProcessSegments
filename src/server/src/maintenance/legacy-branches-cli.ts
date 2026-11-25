import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacyBranchName } from '../clarify/worktree.js';
import { loadConfig } from '../config.js';
import { RequestRepository } from '../requests/repository.js';
import {
  applyMigrationEntries,
  groupCandidates,
  migrateRepo,
  ROW_MIGRATION_ACTIONS,
  type LegacyBranchRow,
  type MigrationEntry,
} from './legacy-branches.js';

export interface CliOptions {
  apply: boolean;
  repos: string[];
  db: string | null;
  help: boolean;
}

export function usage(): string {
  return [
    'Usage: npm run migrate:branches -- [--apply] [--repo DIR]... [--db FILE]',
    '',
    'Migrates legacy sbox/<request-id> branches to aps/<request-id> once the',
    'request is done or dropped. Dry run by default; nothing changes without --apply.',
    '',
    '  --apply        rename/delete refs and rewrite requests.branch',
    '  --repo DIR     limit work to this repository (repeatable; default: all',
    '                 repositories referenced by legacy request rows)',
    '  --db FILE      SQLite database (default: APS_DB or the configured default)',
    '  --help, -h     show this text',
    '',
    'Safety: non-terminal requests, checked-out branches, and diverged',
    'aps/sbox pairs are always skipped. Orphan sbox/* refs are report-only.',
  ].join('\n');
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, repos: [], db: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--repo' || arg === '--db') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a path`);
      if (arg === '--repo') options.repos.push(path.resolve(value));
      else options.db = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  options.repos = [...new Set(options.repos)];
  return options;
}

function describe(entry: MigrationEntry, apply: boolean): string {
  const repo = `[${entry.repo}]`;
  switch (entry.action) {
    case 'rename':
      return `${entry.applied ? 'renamed        ' : 'would rename   '} ${entry.legacyBranch} -> ${entry.canonicalBranch}  ${repo}`;
    case 'delete-contained':
      return `${entry.applied ? 'deleted        ' : 'would delete   '} ${entry.legacyBranch} (contained in ${entry.canonicalBranch})  ${repo}`;
    case 'repair-db':
      return `${apply ? 'repaired row   ' : 'would repair   '} request ${entry.requestId}: ${entry.legacyBranch} ref is gone, ${entry.canonicalBranch} exists  ${repo}`;
    case 'skip-inflight':
      return `skip in-flight  request ${entry.requestId} (${entry.detail ?? 'not terminal'})  ${repo}`;
    case 'skip-checked-out':
      return `skip checkout   ${entry.legacyBranch} is checked out in a worktree  ${repo}`;
    case 'skip-diverged':
      return `skip diverged   ${entry.legacyBranch} and ${entry.canonicalBranch} both exist; manual review  ${repo}`;
    case 'skip-missing':
      return `skip missing    ${entry.legacyBranch} and ${entry.canonicalBranch} are both absent  ${repo}`;
    case 'skip-orphan':
      return `skip orphan     ${entry.legacyBranch} has no request row  ${repo}`;
    case 'skip-no-repo':
      return `skip repo       ${repo} is not a git work tree`;
    case 'error':
      return `error           ${entry.legacyBranch}: ${entry.detail ?? 'unknown error'}  ${repo}`;
  }
}

function printEntries(entries: MigrationEntry[], apply: boolean): number {
  for (const entry of entries) console.log(describe(entry, apply));

  const changes = entries.filter((entry) => ROW_MIGRATION_ACTIONS.includes(entry.action));
  const errors = entries.filter((entry) => entry.action === 'error').length;
  const skipped = entries.filter((entry) => entry.action.startsWith('skip-')).length;

  console.log('');
  console.log(
    `${changes.length} branch(es) ${apply ? 'migrated' : 'pending'}, ` +
      `${skipped} skipped, ${errors} error(s)`,
  );
  if (!apply && changes.length > 0) console.log('Re-run with --apply to make these changes.');
  return errors;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 1;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const dbPath = options.db ?? loadConfig().dbPath;
  if (!existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    return 1;
  }

  // Open directly rather than through openDb(): migrate()/reconcile() would
  // write to a live brain's database and reset a working request to idle.
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  if (!options.apply) db.pragma('query_only = ON');

  try {
    const hasRequests = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'requests'")
      .get();
    if (!hasRequests) {
      console.error(`${dbPath} has no requests table; is this the brain database?`);
      return 1;
    }

    const repo = new RequestRepository(db);
    const rows: LegacyBranchRow[] = repo
      .list()
      .filter((request) => request.targetRepo !== null && request.branch === legacyBranchName(request.id))
      .map((request) => ({
        id: request.id,
        state: request.state,
        targetRepo: request.targetRepo,
        branch: request.branch,
      }));

    const groups = groupCandidates(rows, options.repos);
    if (groups.length === 0) {
      console.log('No legacy sbox/<request-id> branches found in the database.');
      return 0;
    }

    const entries: MigrationEntry[] = [];
    for (const group of groups) {
      const repoEntries = await migrateRepo({
        repoPath: group.repo,
        rows: group.rows,
        apply: options.apply,
      });
      entries.push(...repoEntries);
    }

    let failures = printEntries(entries, options.apply);
    if (options.apply) {
      try {
        const run = db.transaction(() =>
          applyMigrationEntries(repo, entries, (entry) => {
            console.error(
              `warning: request ${entry.requestId} was not updated; its row changed during the run`,
            );
          }),
        );
        run();
      } catch (error) {
        console.error(
          `database update failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        failures += 1;
      }
    }
    return failures > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
