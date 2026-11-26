import { existsSync, readFileSync } from 'node:fs';
import type { ErrorSink } from '../logging/errors.js';
import { writePrivateFile } from '../util/files.js';
import type { ProcessConfig } from './definition.js';
import { normalizeProcess, processPatchSchema, processSchema } from './defaults.js';

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
      this.errors?.error('process.unreadable', error, { path: this.path });
      console.warn(`ignoring unreadable process config at ${this.path}: ${String(error)}`);
      return null;
    }
  }

  /**
   * Copy an unusable file aside before the first save replaces it. The copy is
   * the exact original bytes, owner-only, and never overwrites an earlier copy.
   * A failed copy aborts the save so the file is never destroyed without one.
   */
  private preserveUnusableSource(): void {
    if (!this.preserveSource) return;

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.preserveSource = false;
        return;
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
  }

  private write(config: ProcessConfig): void {
    this.preserveUnusableSource();
    writePrivateFile(this.path, `${JSON.stringify(config, null, 2)}\n`);
  }
}
