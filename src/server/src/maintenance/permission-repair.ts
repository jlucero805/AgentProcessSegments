import { chmodSync, lstatSync, type Stats } from 'node:fs';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export type RepairAction = 'tighten' | 'private' | 'skip' | 'error';
export type RepairKind = 'dir' | 'file';

export interface RepairEntry {
  path: string;
  kind: RepairKind;
  mode: number | null;
  target: number;
  action: RepairAction;
  detail?: string;
}

export interface RepairResult {
  entries: RepairEntry[];
  /** Entries changed now, or pending when `apply` is false. */
  tightened: number;
  private: number;
  skipped: number;
  failed: number;
  /** True when the scan root does not exist. */
  rootMissing: boolean;
}

export interface RepairDeps {
  chmod?: (file: string, mode: number) => void;
}

export interface RootOptions {
  /**
   * A root is inspected with `lstat` and never followed. `skip` records a
   * symlinked root as a skip and lets the caller keep walking; the default
   * `refuse` records an error and stops.
   */
  symlinks?: 'refuse' | 'skip';
}

export interface ChildOptions {
  /** `skip` records a child that vanished between `readdir` and `lstat`. */
  missing?: 'silent' | 'skip';
}

/** Render a POSIX mode as four octal digits, such as `0700`. */
export function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function wantedMode(kind: RepairKind): number {
  return kind === 'dir' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;
}

/**
 * One owner-only permission repair. Each maintenance command describes its tree
 * with this scanner, which owns the mode decision, the symlink and kind checks,
 * the `ENOENT` policy, the dry-run accounting, and the chmod itself. Nothing
 * else under `maintenance/` should call `chmod` directly.
 */
export class PermissionRepair {
  private readonly entries: RepairEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly apply: boolean;
  private readonly chmod: (file: string, mode: number) => void;
  private tightened = 0;
  private privateCount = 0;
  private skipped = 0;
  private failed = 0;

  constructor(options: { apply: boolean } & RepairDeps) {
    this.apply = options.apply;
    this.chmod = options.chmod ?? chmodSync;
  }

  /**
   * Inspect the scan root. `missing` means there is nothing to traverse and the
   * caller should return `result(true)`; `failed` means an error entry was
   * already recorded.
   */
  root(target: string, options: RootOptions = {}): 'ok' | 'missing' | 'failed' {
    let stat: Stats;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if (isMissing(error)) return 'missing';
      this.error(target, 'dir', error);
      return 'failed';
    }

    if (stat.isSymbolicLink()) {
      if (options.symlinks === 'skip') {
        this.skip(target, 'dir', 'symlink');
        return 'ok';
      }
      this.error(target, 'dir', new Error('is a symbolic link'));
      return 'failed';
    }
    if (!stat.isDirectory()) {
      this.error(target, 'dir', new Error('not a directory'));
      return 'failed';
    }

    this.consider(target, 'dir', stat.mode);
    return 'ok';
  }

  /** Inspect a direct directory child. Returns true when it is a directory. */
  dir(target: string, options: ChildOptions = {}): boolean {
    return this.inspect(target, 'dir', options);
  }

  /** Inspect a direct file child. Returns true when it is a regular file. */
  file(target: string, options: ChildOptions = {}): boolean {
    return this.inspect(target, 'file', options);
  }

  /** Record a failure that no single child owns, such as a failed `readdir`. */
  error(target: string, kind: RepairKind, error: unknown): void {
    this.entries.push({
      path: target,
      kind,
      mode: null,
      target: wantedMode(kind),
      action: 'error',
      detail: errorDetail(error),
    });
    this.failed += 1;
  }

  result(rootMissing: boolean): RepairResult {
    return {
      entries: this.entries,
      tightened: this.tightened,
      private: this.privateCount,
      skipped: this.skipped,
      failed: this.failed,
      rootMissing,
    };
  }

  private inspect(target: string, kind: RepairKind, options: ChildOptions): boolean {
    let stat: Stats;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if (!isMissing(error)) {
        this.error(target, kind, error);
      } else if (options.missing === 'skip') {
        this.skip(target, kind, 'vanished');
      }
      return false;
    }

    if (stat.isSymbolicLink()) {
      this.skip(target, kind, 'symlink');
      return false;
    }
    if (kind === 'dir' && !stat.isDirectory()) {
      this.skip(target, kind, 'not a directory');
      return false;
    }
    if (kind === 'file' && !stat.isFile()) {
      this.skip(target, kind, 'not a regular file');
      return false;
    }

    this.consider(target, kind, stat.mode);
    return true;
  }

  private skip(target: string, kind: RepairKind, detail: string): void {
    this.entries.push({
      path: target,
      kind,
      mode: null,
      target: wantedMode(kind),
      action: 'skip',
      detail,
    });
    this.skipped += 1;
  }

  private consider(target: string, kind: RepairKind, mode: number): void {
    if (this.seen.has(target)) return;
    this.seen.add(target);

    const current = mode & 0o777;
    const wanted = wantedMode(kind);

    if (current === wanted) {
      this.entries.push({ path: target, kind, mode: current, target: wanted, action: 'private' });
      this.privateCount += 1;
      return;
    }

    if (!this.apply) {
      this.entries.push({ path: target, kind, mode: current, target: wanted, action: 'tighten' });
      this.tightened += 1;
      return;
    }

    try {
      this.chmod(target, wanted);
      this.entries.push({ path: target, kind, mode: current, target: wanted, action: 'tighten' });
      this.tightened += 1;
    } catch (error) {
      if (isMissing(error)) {
        this.skip(target, kind, 'vanished');
      } else {
        this.entries.push({
          path: target,
          kind,
          mode: current,
          target: wanted,
          action: 'error',
          detail: errorDetail(error),
        });
        this.failed += 1;
      }
    }
  }
}
