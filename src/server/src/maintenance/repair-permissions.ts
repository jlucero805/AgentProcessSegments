import {
  chmodSync,
  lstatSync,
  readdirSync,
  statSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { requestsDir } from '../config.js';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const SESSION_FILES = ['session.json', 'transcript.json', 'mcp-config.json'] as const;

export type RepairAction = 'tighten' | 'private' | 'skip' | 'error';

export interface RepairEntry {
  path: string;
  kind: 'dir' | 'file' | 'other';
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
  /** True when the data dir has no `requests/` tree at all. */
  rootMissing: boolean;
}

export interface RepairDeps {
  chmod?: (file: string, mode: number) => void;
}

interface Context {
  entries: RepairEntry[];
  tightened: number;
  private: number;
  skipped: number;
  failed: number;
  apply: boolean;
  chmod: (file: string, mode: number) => void;
  seen: Set<string>;
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

function addSkip(ctx: Context, target: string, kind: RepairEntry['kind'], detail: string): void {
  const targetMode = kind === 'file' ? PRIVATE_FILE_MODE : PRIVATE_DIR_MODE;
  ctx.entries.push({ path: target, kind, mode: null, target: targetMode, action: 'skip', detail });
  ctx.skipped += 1;
}

function addError(ctx: Context, target: string, kind: RepairEntry['kind'], error: unknown): void {
  ctx.entries.push({
    path: target,
    kind,
    mode: null,
    target: kind === 'file' ? PRIVATE_FILE_MODE : PRIVATE_DIR_MODE,
    action: 'error',
    detail: errorDetail(error),
  });
  ctx.failed += 1;
}

function consider(ctx: Context, target: string, kind: 'dir' | 'file', mode: number): void {
  if (ctx.seen.has(target)) return;
  ctx.seen.add(target);

  const current = mode & 0o777;
  const wanted = kind === 'dir' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;

  if (current === wanted) {
    ctx.entries.push({ path: target, kind, mode: current, target: wanted, action: 'private' });
    ctx.private += 1;
    return;
  }

  if (!ctx.apply) {
    ctx.entries.push({ path: target, kind, mode: current, target: wanted, action: 'tighten' });
    ctx.tightened += 1;
    return;
  }

  try {
    ctx.chmod(target, wanted);
    ctx.entries.push({ path: target, kind, mode: current, target: wanted, action: 'tighten' });
    ctx.tightened += 1;
  } catch (error) {
    if (isMissing(error)) {
      addSkip(ctx, target, kind, 'vanished');
    } else {
      ctx.entries.push({
        path: target,
        kind,
        mode: current,
        target: wanted,
        action: 'error',
        detail: errorDetail(error),
      });
      ctx.failed += 1;
    }
  }
}

/**
 * Inspect one known path. Missing artifacts are silent because sessions do not
 * all have a Claude config or scratch checkout.
 */
function inspect(
  ctx: Context,
  target: string,
  kind: 'dir' | 'file',
): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (!isMissing(error)) addError(ctx, target, kind, error);
    return false;
  }

  if (stat.isSymbolicLink()) {
    addSkip(ctx, target, kind, 'symlink');
    return false;
  }
  if (kind === 'dir' && !stat.isDirectory()) {
    addSkip(ctx, target, kind, 'not a directory');
    return false;
  }
  if (kind === 'file' && !stat.isFile()) {
    addSkip(ctx, target, kind, 'not a regular file');
    return false;
  }

  consider(ctx, target, kind, stat.mode);
  return true;
}

function scanSession(ctx: Context, sessionDir: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(sessionDir);
  } catch (error) {
    if (isMissing(error)) addSkip(ctx, sessionDir, 'dir', 'vanished');
    else addError(ctx, sessionDir, 'dir', error);
    return;
  }

  if (stat.isSymbolicLink()) {
    addSkip(ctx, sessionDir, 'dir', 'symlink');
    return;
  }
  if (!stat.isDirectory()) {
    addSkip(ctx, sessionDir, 'dir', 'not a directory');
    return;
  }

  consider(ctx, sessionDir, 'dir', stat.mode);

  inspect(ctx, path.join(sessionDir, 'cwd'), 'dir');
  const opencode = path.join(sessionDir, 'opencode');
  if (inspect(ctx, opencode, 'dir')) {
    inspect(ctx, path.join(opencode, 'opencode.json'), 'file');
  }
  for (const name of SESSION_FILES) {
    inspect(ctx, path.join(sessionDir, name), 'file');
  }
}

/**
 * Tighten every existing request/session workdir to the owner-only layout from
 * D58. This never recurses into `cwd/` checkouts and never creates paths.
 */
export function repairPermissions(
  dataDir: string,
  options: { apply: boolean } & RepairDeps,
): RepairResult {
  const ctx: Context = {
    entries: [],
    tightened: 0,
    private: 0,
    skipped: 0,
    failed: 0,
    apply: options.apply,
    chmod: options.chmod ?? chmodSync,
    seen: new Set<string>(),
  };
  const root = requestsDir(dataDir);

  let rootStat: Stats;
  try {
    rootStat = statSync(root);
  } catch (error) {
    if (isMissing(error)) {
      return {
        entries: ctx.entries,
        tightened: 0,
        private: 0,
        skipped: 0,
        failed: 0,
        rootMissing: true,
      };
    }
    addError(ctx, root, 'dir', error);
    return {
      entries: ctx.entries,
      tightened: ctx.tightened,
      private: ctx.private,
      skipped: ctx.skipped,
      failed: ctx.failed,
      rootMissing: false,
    };
  }

  if (!rootStat.isDirectory()) {
    addError(ctx, root, 'dir', new Error('not a directory'));
    return {
      entries: ctx.entries,
      tightened: ctx.tightened,
      private: ctx.private,
      skipped: ctx.skipped,
      failed: ctx.failed,
      rootMissing: false,
    };
  }

  consider(ctx, root, 'dir', rootStat.mode);

  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch (error) {
    addError(ctx, root, 'dir', error);
    return {
      entries: ctx.entries,
      tightened: ctx.tightened,
      private: ctx.private,
      skipped: ctx.skipped,
      failed: ctx.failed,
      rootMissing: false,
    };
  }

  for (const name of names) {
    scanSession(ctx, path.join(root, name));
  }

  return {
    entries: ctx.entries,
    tightened: ctx.tightened,
    private: ctx.private,
    skipped: ctx.skipped,
    failed: ctx.failed,
    rootMissing: false,
  };
}
