import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pruneWorktreeRepo, removeWorktreeAt, worktreePath } from '../clarify/worktree.js';
import { isTerminal, type Request } from '../domain/request.js';
import { isReservedSessionId } from '../domain/sessions.js';
import type { ErrorSink } from '../logging/errors.js';
import type { RequestRepository } from '../requests/repository.js';
import { requestsDir } from '../config.js';
import type { SettingsStore } from '../settings.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArtifactPruneResult {
  deleted: number;
  /** Null when retention is disabled, so there is no cutoff to report. */
  cutoff: number | null;
}

export interface ArtifactRetentionResult {
  requestDirs: ArtifactPruneResult;
  worktrees: ArtifactPruneResult;
}

export interface ArtifactRetentionOptions {
  dataDir: string;
  repo: Pick<RequestRepository, 'get' | 'list'>;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  errors?: ErrorSink;
  /** True while a turn is live for the id; those artifacts are never touched. */
  isBusy?: (id: string) => boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  intervalMs?: number;
  batchSize?: number;
  /** Injectable removal for tests; defaults to fs.promises.rm. */
  removeDir?: (dir: string) => Promise<void>;
}

/**
 * Deletes per-request workdirs and leftover git checkouts for terminal
 * requests older than `retention.requestArtifactsDays`. Runs once at startup,
 * hourly after that, and again whenever settings change.
 */
export class ArtifactRetention {
  private readonly dataDir: string;
  private readonly repo: Pick<RequestRepository, 'get' | 'list'>;
  private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>;
  private readonly errors?: ErrorSink;
  private readonly busy: (id: string) => boolean;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly removeDir: (dir: string) => Promise<void>;

  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<ArtifactRetentionResult> | null = null;
  private stopping = false;

  constructor(options: ArtifactRetentionOptions) {
    this.dataDir = options.dataDir;
    this.repo = options.repo;
    this.settings = options.settings;
    this.errors = options.errors;
    this.busy = options.isBusy ?? (() => false);
    this.clock = options.now ?? (() => Date.now());
    this.intervalMs =
      options.intervalMs && options.intervalMs > 0 ? options.intervalMs : HOUR_MS;
    this.batchSize =
      options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
    this.removeDir =
      options.removeDir ??
      ((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.unsubscribe = this.settings.onChange(() => {
      void this.runOnce();
    });
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * One sweep. A concurrent call joins the in-flight pass rather than starting
   * a second one. Never rejects: failures are reported and retried next tick.
   */
  runOnce(now = this.clock()): Promise<ArtifactRetentionResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.prune(now).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async prune(now: number): Promise<ArtifactRetentionResult> {
    let days: number;
    try {
      days = this.settings.get().retention.requestArtifactsDays;
    } catch (error) {
      this.errors?.error('retention.artifacts', error, {
        requestDirs: 0,
        worktrees: 0,
        failures: 1,
        cutoff: null,
      });
      return {
        requestDirs: { deleted: 0, cutoff: null },
        worktrees: { deleted: 0, cutoff: null },
      };
    }

    if (days <= 0) {
      return {
        requestDirs: { deleted: 0, cutoff: null },
        worktrees: { deleted: 0, cutoff: null },
      };
    }

    const cutoff = now - days * DAY_MS;
    const result: ArtifactRetentionResult = {
      requestDirs: { deleted: 0, cutoff },
      worktrees: { deleted: 0, cutoff },
    };
    const failures: unknown[] = [];

    let rows: Map<string, Request>;
    try {
      rows = new Map(this.repo.list().map((row) => [row.id, row]));
    } catch (error) {
      failures.push(error);
      this.report(result, failures, cutoff);
      return result;
    }

    try {
      await this.sweepRequestDirs(rows, result.requestDirs, failures);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.sweepWorktrees(rows, result.worktrees, failures);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.pruneRepos(rows, cutoff);
    } catch (error) {
      failures.push(error);
    }

    this.report(result, failures, cutoff);
    return result;
  }

  private async sweepRequestDirs(
    rows: Map<string, Request>,
    result: ArtifactPruneResult,
    failures: unknown[],
  ): Promise<void> {
    let entries: string[];
    try {
      entries = (await readdir(requestsDir(this.dataDir), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (!isMissing(error)) failures.push(error);
      return;
    }

    let inspected = 0;
    for (const id of entries) {
      if (this.stopping) break;
      if (inspected > 0 && inspected % this.batchSize === 0) {
        await yieldToEventLoop();
        if (this.stopping) break;
      }
      inspected += 1;
      if (isReservedSessionId(id)) continue;

      const row = rows.get(id) ?? null;
      if (row && (!isTerminal(row.state) || this.busy(id))) continue;
      if (!row && !UUID.test(id)) continue;

      const dir = path.join(requestsDir(this.dataDir), id);
      const activity = await requestDirActivity(dir, row?.updatedAt ?? 0);
      if (!(activity < result.cutoff!)) continue;

      // Re-check the race-prone parts immediately before deleting.
      const current = this.repo.get(id);
      if (current && (!isTerminal(current.state) || this.busy(id))) continue;
      if (!current && !UUID.test(id)) continue;

      try {
        await this.removeDir(dir);
        result.deleted += 1;
      } catch (error) {
        failures.push(error);
      }
    }
  }

  private async sweepWorktrees(
    rows: Map<string, Request>,
    result: ArtifactPruneResult,
    failures: unknown[],
  ): Promise<void> {
    const root = path.join(this.dataDir, 'worktrees');
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (!isMissing(error)) failures.push(error);
      return;
    }

    let inspected = 0;
    for (const id of entries) {
      if (this.stopping) break;
      if (inspected > 0 && inspected % this.batchSize === 0) {
        await yieldToEventLoop();
        if (this.stopping) break;
      }
      inspected += 1;
      if (!UUID.test(id)) continue;

      const row = rows.get(id) ?? null;
      if (this.busy(id)) continue;
      if (row && !isTerminal(row.state) && row.targetRepo !== null) continue;

      const dir = worktreePath(this.dataDir, id);
      const activity = await worktreeActivity(dir, row?.updatedAt ?? 0);
      if (!(activity < result.cutoff!)) continue;

      // Re-check the race-prone parts immediately before deleting.
      const current = this.repo.get(id);
      if (current && !isTerminal(current.state) && current.targetRepo !== null) continue;
      if (this.busy(id)) continue;

      const hint = current?.targetRepo ?? row?.targetRepo ?? null;
      try {
        await removeWorktreeAt(dir, hint);
        result.deleted += 1;
      } catch {
        // git refused or the checkout is not a registered worktree. Removing
        // the directory is still the safe cleanup; a successful fallback is not
        // an error, only a failed one is.
        try {
          await this.removeDir(dir);
          result.deleted += 1;
        } catch (error) {
          failures.push(error);
        }
      }
      if (hint) await pruneWorktreeRepo(hint);
    }
  }

  private async pruneRepos(rows: Map<string, Request>, cutoff: number): Promise<void> {
    const repos = new Set<string>();
    for (const row of rows.values()) {
      if (!isTerminal(row.state) || row.targetRepo === null) continue;
      if (row.updatedAt >= cutoff || this.busy(row.id)) continue;
      if (existsSync(row.targetRepo)) repos.add(row.targetRepo);
    }
    for (const repo of repos) await pruneWorktreeRepo(repo);
  }

  private report(
    result: ArtifactRetentionResult,
    failures: unknown[],
    cutoff: number,
  ): void {
    if (failures.length === 0) return;
    this.errors?.error('retention.artifacts', failures[0], {
      requestDirs: result.requestDirs.deleted,
      worktrees: result.worktrees.deleted,
      failures: failures.length,
      cutoff,
    });
  }
}

async function requestDirActivity(dir: string, updatedAt: number): Promise<number> {
  const candidates = [updatedAt];
  for (const target of [dir, path.join(dir, 'transcript.json'), path.join(dir, 'session.json')]) {
    candidates.push(await mtime(target));
  }
  return Math.max(...candidates);
}

async function worktreeActivity(dir: string, updatedAt: number): Promise<number> {
  return Math.max(updatedAt, await mtime(dir));
}

async function mtime(target: string): Promise<number> {
  try {
    return (await stat(target)).mtimeMs;
  } catch {
    return 0;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
