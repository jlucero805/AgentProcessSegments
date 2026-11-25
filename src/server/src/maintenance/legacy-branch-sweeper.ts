import { legacyBranchName } from '../clarify/worktree.js';
import { isTerminal } from '../domain/request.js';
import type { ErrorSink } from '../logging/errors.js';
import type { RequestRepository } from '../requests/repository.js';
import {
  applyMigrationEntries,
  groupCandidates,
  logActionableEntry,
  migrateRepo,
  ROW_MIGRATION_ACTIONS,
  type GitRunner,
  type LegacyBranchRow,
  type MigrationEntry,
} from './legacy-branches.js';

const HOUR_MS = 60 * 60 * 1000;

export interface LegacyBranchSweepResult {
  repos: number;
  migrated: number;
  skipped: number;
  errors: number;
}

export interface LegacyBranchSweeperOptions {
  repo: Pick<RequestRepository, 'list' | 'migrateLegacyBranch'>;
  errors?: ErrorSink;
  /** True while a turn is live for the id; those rows are never touched. */
  isBusy?: (id: string) => boolean;
  /** Injectable interval for tests; defaults to one hour. */
  intervalMs?: number;
  /** Injectable git for failure tests; defaults to the real runner. */
  git?: GitRunner;
}

/**
 * Retires legacy `sbox/<id>` branches on terminal rows that the inline
 * transition hook did not handle: rows that were already terminal when this
 * shipped, and rows whose transition-time git work failed. Runs once at
 * startup and hourly after that. Never rejects; failures are reported and
 * retried on the next pass.
 */
export class LegacyBranchSweeper {
  private readonly repo: Pick<RequestRepository, 'list' | 'migrateLegacyBranch'>;
  private readonly errors?: ErrorSink;
  private readonly busy: (id: string) => boolean;
  private readonly intervalMs: number;
  private readonly git?: GitRunner;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<LegacyBranchSweepResult> | null = null;
  private stopping = false;

  constructor(options: LegacyBranchSweeperOptions) {
    this.repo = options.repo;
    this.errors = options.errors;
    this.busy = options.isBusy ?? (() => false);
    this.intervalMs =
      options.intervalMs && options.intervalMs > 0 ? options.intervalMs : HOUR_MS;
    this.git = options.git;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    // Fire-and-forget: a first sweep must not delay readiness.
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep. A concurrent call joins the in-flight pass. Never rejects. */
  runOnce(): Promise<LegacyBranchSweepResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.sweep().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async sweep(): Promise<LegacyBranchSweepResult> {
    const result: LegacyBranchSweepResult = { repos: 0, migrated: 0, skipped: 0, errors: 0 };

    let rows: LegacyBranchRow[];
    try {
      rows = this.repo
        .list()
        .filter(
          (request) =>
            isTerminal(request.state) &&
            request.targetRepo !== null &&
            request.branch === legacyBranchName(request.id) &&
            !this.busy(request.id),
        )
        .map((request) => ({
          id: request.id,
          state: request.state,
          targetRepo: request.targetRepo,
          branch: request.branch,
        }));
    } catch (error) {
      this.errors?.error('maintenance.legacy-branches', error, { phase: 'sweep-list' });
      return result;
    }

    for (const group of groupCandidates(rows, [])) {
      if (this.stopping) break;
      result.repos += 1;
      try {
        const entries = await migrateRepo({
          repoPath: group.repo,
          rows: group.rows,
          apply: true,
          ...(this.git ? { git: this.git } : {}),
        });

        applyMigrationEntries(this.repo, entries, (missed) => {
          this.errors?.error(
            'maintenance.legacy-branches',
            new Error('request row changed during the run'),
            {
              requestId: missed.requestId,
              repo: missed.repo,
              action: missed.action,
              phase: 'sweep',
            },
          );
        });
        for (const entry of entries) logActionableEntry(this.errors, entry, 'sweep');
        this.record(entries, result);
      } catch (error) {
        result.errors += 1;
        this.errors?.error('maintenance.legacy-branches', error, {
          repo: group.repo,
          phase: 'sweep',
        });
      }
    }

    return result;
  }

  private record(entries: MigrationEntry[], result: LegacyBranchSweepResult): void {
    for (const entry of entries) {
      if (ROW_MIGRATION_ACTIONS.includes(entry.action)) result.migrated += 1;
      else if (entry.action === 'error') result.errors += 1;
      else result.skipped += 1;
    }
  }
}
