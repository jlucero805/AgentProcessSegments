import {
  chmodSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';

/** Options for {@link createPreservedCopy}. */
export interface PreservedCopyCreateOptions {
  /** Clock used for the name; injectable so tests need no fake timers. */
  now?: Date;
}

/** Options for {@link listPreservedCopies}. */
export interface PreservedCopyListOptions {
  /**
   * Absolute path of the copy this process just made. It sorts first when it
   * appears in the list, even if the clock moved backwards.
   */
  newest?: string | null;
  /** Called once when the directory cannot be read; the result is then empty. */
  onError?: (error: unknown) => void;
}

/** Prefix shared by preserved siblings of `file`, such as `config.json.invalid-`. */
export function preservedCopyPrefix(file: string): string {
  return `${path.basename(file)}.invalid-`;
}

/** Order preserved names by the embedded UTC stamp, then the numeric suffix. */
function preservedCopyOrder(name: string, prefix: string): [string, number] {
  const match = /^(.*?)(?:-(\d+))?$/.exec(name.slice(prefix.length));
  return [match?.[1] ?? name.slice(prefix.length), match?.[2] ? Number(match[2]) : 0];
}

/** Best-effort removal of a partially written copy; a missing path is ignored. */
function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // The candidate may not exist, or may already be gone.
  }
}

/**
 * Write `contents` beside `file` as the next `<file>.invalid-<UTC>[-N]` copy.
 * Creation is exclusive, so an existing copy is never overwritten even when
 * another writer picks the same stamp. A failed create removes its partial file.
 */
export function createPreservedCopy(
  file: string,
  contents: string,
  options: PreservedCopyCreateOptions = {},
): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const base = `${file}.invalid-${stamp}`;

  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    try {
      writeFileSync(candidate, contents, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      removeQuietly(candidate);
      throw error;
    }

    try {
      chmodSync(candidate, 0o600);
    } catch (error) {
      removeQuietly(candidate);
      throw error;
    }
    return candidate;
  }
}

/**
 * Existing preserved copies of `file`, newest first. Only regular files with the
 * exact prefix are candidates; a missing or unreadable directory has no copies.
 * Paths only: the copies are never read back.
 */
export function listPreservedCopies(
  file: string,
  options: PreservedCopyListOptions = {},
): string[] {
  const dir = path.dirname(file);
  const prefix = preservedCopyPrefix(file);

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    options.onError?.(error);
    return [];
  }

  const copies = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => {
      const [stamp, suffix] = preservedCopyOrder(entry.name, prefix);
      return { name: entry.name, stamp, suffix };
    })
    .sort((left, right) => {
      if (left.stamp !== right.stamp) return left.stamp < right.stamp ? 1 : -1;
      return right.suffix - left.suffix;
    })
    .map(({ name }) => path.join(dir, name));

  if (!options.newest) return copies;
  const newest = path.join(dir, path.basename(options.newest));
  if (!copies.includes(newest)) return copies;
  return [newest, ...copies.filter((copy) => copy !== newest)];
}
