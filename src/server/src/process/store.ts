import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ErrorSink } from '../logging/errors.js';
import type { ProcessConfig } from './definition.js';
import { processPatchSchema, processSchema } from './defaults.js';

/**
 * Persistent process definitions, separate from the scheduler's master policy.
 * Missing or invalid files fall back to a policy derived from the current master
 * settings until the operator saves a valid one.
 */
export class ProcessStore {
  private cached: ProcessConfig | null = null;
  private readonly listeners = new Set<(process: ProcessConfig) => void>();

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
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.errors?.error('process.unreadable', error, { path: this.path });
        console.warn(`ignoring unreadable process config at ${this.path}: ${String(error)}`);
      }
      return null;
    }

    try {
      const result = processSchema.safeParse(JSON.parse(raw));
      if (!result.success) {
        this.errors?.error('process.invalid', new Error(result.error.message), {
          path: this.path,
        });
        console.warn(`ignoring invalid process config at ${this.path}: ${result.error.message}`);
        return null;
      }
      return result.data;
    } catch (error) {
      this.errors?.error('process.unreadable', error, { path: this.path });
      console.warn(`ignoring unreadable process config at ${this.path}: ${String(error)}`);
      return null;
    }
  }

  private write(config: ProcessConfig): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
