import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { ErrorSink } from '../logging/errors.js';
import { writePrivateFile } from '../util/files.js';
import { jsonParseReason } from '../util/json.js';
import type { ProcessConfig } from './definition.js';
import { normalizeProcess, processPatchSchema, processSchema } from './defaults.js';

/** Preserved copies kept per process file; older ones are pruned after a save. */
const MAX_PRESERVED_COPIES = 5;

/** Order preserved names by the embedded UTC stamp, then the numeric suffix. */
function preservedCopyOrder(name: string, prefix: string): [string, number] {
  const match = /^(.*?)(?:-(\d+))?$/.exec(name.slice(prefix.length));
  return [match?.[1] ?? name.slice(prefix.length), match?.[2] ? Number(match[2]) : 0];
}

/**
 * Persistent process definitions, separate from the scheduler's master policy.
 * Missing or invalid files fall back to a policy derived from the current master
 * settings until the operator saves a valid one.
 */
export class ProcessStore {
  private cached: ProcessConfig | null = null;
  private readonly listeners = new Set<(process: ProcessConfig) => void>();
  /** Set when the loaded file was unusable; the next save preserves its bytes. */
  private preserveSource = false;

  constructor(
    readonly path: string,
    private readonly fallback: () => ProcessConfig,
    private readonly errors?: ErrorSink,
  ) {}

  get(): ProcessConfig {
    if (this.cached) return this.cached;
    const loaded = this.load();
    if (loaded) {
      this.cached = loaded;
      return loaded;
    }
    return structuredClone(this.fallback());
  }

  patch(input: unknown): ProcessConfig {
    const parsed = processPatchSchema.parse(input);
    const next = processSchema.parse({ version: 1, segments: parsed.segments });
    // Load before writing so a save that is the first operation still notices
    // an unusable file on disk and preserves it.
    this.get();
    this.write(next);
    this.cached = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (process: ProcessConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): ProcessConfig | null {
    this.preserveSource = false;

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.preserveSource = true;
        this.errors?.error('process.unreadable', error, { path: this.path });
        console.warn(`ignoring unreadable process config at ${this.path}: ${String(error)}`);
      }
      return null;
    }

    try {
      const result = processSchema.safeParse(normalizeProcess(JSON.parse(raw)));
      if (!result.success) {
        this.preserveSource = true;
        this.errors?.error('process.invalid', new Error(result.error.message), {
          path: this.path,
        });
        console.warn(`ignoring invalid process config at ${this.path}: ${result.error.message}`);
        return null;
      }
      return result.data;
    } catch (error) {
      this.preserveSource = true;
      // V8 can quote the input in a parse error, and process.json holds
      // operator-authored prompts, so report the position only.
      const reason = jsonParseReason(error);
      this.errors?.error('process.unreadable', new Error(reason), {
        path: this.path,
        reason: 'invalid-json',
      });
      console.warn(`ignoring unreadable process config at ${this.path}: ${reason}`);
      return null;
    }
  }

  /**
   * Copy an unusable file aside before the first save replaces it. The copy is
   * the exact original bytes, owner-only, and never overwrites an earlier copy.
   * A failed copy aborts the save so the file is never destroyed without one.
   */
  private preserveUnusableSource(): string | null {
    if (!this.preserveSource) return null;

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.preserveSource = false;
        return null;
      }
      this.errors?.error('process.backupFailed', error, { path: this.path });
      throw error;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backup = `${this.path}.invalid-${stamp}`;
    for (let suffix = 1; existsSync(backup); suffix += 1) {
      backup = `${this.path}.invalid-${stamp}-${suffix}`;
    }

    try {
      writePrivateFile(backup, raw);
    } catch (error) {
      this.errors?.error('process.backupFailed', error, { path: this.path });
      throw error;
    }

    this.preserveSource = false;
    console.warn(`preserving unusable process config at ${this.path} as ${backup}`);
    return backup;
  }

  /**
   * Keep a bounded number of preserved copies. Only regular files with this
   * process file's exact prefix are candidates; pruning is best-effort and
   * never fails the save that triggered it.
   */
  private prunePreservedCopies(newest: string | null): void {
    const dir = path.dirname(this.path);
    const prefix = `${path.basename(this.path)}.invalid-`;
    const newestName = newest ? path.basename(newest) : null;

    let copies: Array<{ name: string; stamp: string; suffix: number }>;
    try {
      copies = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
        .map((entry) => {
          const [stamp, suffix] = preservedCopyOrder(entry.name, prefix);
          return { name: entry.name, stamp, suffix };
        });
    } catch (error) {
      this.errors?.error('process.pruneFailed', error, { path: this.path });
      return;
    }

    copies.sort((left, right) => {
      // The copy just written is the newest operation even if the clock moved
      // backwards, so never let name ordering make it the first to go.
      if (left.name === newestName) return 1;
      if (right.name === newestName) return -1;
      if (left.stamp !== right.stamp) return left.stamp < right.stamp ? -1 : 1;
      return left.suffix - right.suffix;
    });

    const excess = copies.length - MAX_PRESERVED_COPIES;
    if (excess <= 0) return;

    for (const { name } of copies.slice(0, excess)) {
      const copy = path.join(dir, name);
      try {
        unlinkSync(copy);
      } catch (error) {
        this.errors?.error('process.pruneFailed', error, { path: this.path, copy });
      }
    }
  }

  private write(config: ProcessConfig): void {
    const preserved = this.preserveUnusableSource();
    writePrivateFile(this.path, `${JSON.stringify(config, null, 2)}\n`);
    // Prune only after the replacement succeeds, so a failed save never
    // removes a preserved copy.
    this.prunePreservedCopies(preserved);
  }
}
