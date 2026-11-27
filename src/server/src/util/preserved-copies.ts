import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { writePrivateFile } from './files.js';

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

/** Options for {@link createPreservedCopy}. */
export interface PreservedCopyCreateOptions {
  /** Noun for the success warning, e.g. `settings` or `process config`. */
  label: string;
  /** Called once when the source cannot be read or the copy cannot be written. */
  onError?: (error: unknown) => void;
}

/**
 * Copy `file` beside itself as `<file>.invalid-<UTC>[-n]`, owner-only and never
 * overwriting an existing copy. Returns the copy path, or null when the source no
 * longer exists. Reports a read or write failure through `onError` and rethrows so
 * the caller can refuse the save that would have replaced it; the source is never
 * modified.
 */
export function createPreservedCopy(
  file: string,
  options: PreservedCopyCreateOptions,
): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    options.onError?.(error);
    throw error;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let copy = `${file}.invalid-${stamp}`;
  for (let suffix = 1; existsSync(copy); suffix += 1) {
    copy = `${file}.invalid-${stamp}-${suffix}`;
  }

  try {
    writePrivateFile(copy, raw);
  } catch (error) {
    options.onError?.(error);
    throw error;
  }

  console.warn(`preserving unusable ${options.label} at ${file} as ${copy}`);
  return copy;
}

/** Order preserved names by the embedded UTC stamp, then the numeric suffix. */
function preservedCopyOrder(name: string, prefix: string): [string, number] {
  const match = /^(.*?)(?:-(\d+))?$/.exec(name.slice(prefix.length));
  return [match?.[1] ?? name.slice(prefix.length), match?.[2] ? Number(match[2]) : 0];
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
