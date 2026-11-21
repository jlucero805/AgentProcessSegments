import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MasterConfig } from './master/types.js';

export const DEFAULT_MASTER_PROMPT = [
  'You are the cell master reviewing an implementation request.',
  'If you are blocked on a decision, record the decision in the request context with',
  '`update_request`, then continue implementing instead of waiting.',
  'If the implementation is complete, finish your reply with the exact line:',
  'READY FOR REVIEW',
  'Do not ask the human questions. Keep the request moving.',
].join(' ');

// Compile-time guard: the runtime schema and the shared contract cannot drift.
const masterSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(24 * 60),
  idleMinutes: z.number().int().min(1).max(24 * 60),
  autoReview: z.boolean(),
  includeUnassigned: z.boolean(),
  prompt: z.string().min(1).max(8000),
}) satisfies z.ZodType<MasterConfig>;

const settingsSchema = z.object({ master: masterSchema });

export type MasterSettings = MasterConfig;
export type AppSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  master: {
    enabled: true,
    intervalMinutes: 5,
    idleMinutes: 10,
    autoReview: true,
    includeUnassigned: true,
    prompt: DEFAULT_MASTER_PROMPT,
  },
};

export const settingsPatchSchema = z.object({ master: masterSchema.partial() });

/**
 * Persistent app settings, separate from the brain's environment/path config.
 * Unknown keys are stripped; an invalid file falls back to defaults until the
 * operator saves a valid one.
 */
export class SettingsStore {
  private cached: AppSettings | null = null;
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(readonly path: string) {}

  get(): AppSettings {
    if (!this.cached) this.cached = this.load();
    return this.cached;
  }

  patch(input: unknown): AppSettings {
    const parsed = settingsPatchSchema.parse(input);
    const current = this.get();
    const next = settingsSchema.parse({
      master: { ...current.master, ...(parsed.master ?? {}) },
    });
    this.write(next);
    this.cached = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): AppSettings {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }

    try {
      const result = settingsSchema.safeParse(JSON.parse(raw));
      if (!result.success) {
        console.warn(`ignoring invalid settings at ${this.path}: ${result.error.message}`);
        return structuredClone(DEFAULT_SETTINGS);
      }
      return result.data;
    } catch (error) {
      console.warn(`ignoring unreadable settings at ${this.path}: ${String(error)}`);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private write(settings: AppSettings): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
