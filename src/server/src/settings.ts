import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_BUDGET_SETTINGS,
  MAX_BUDGET_USD,
  type BudgetSettings,
} from './domain/budget.js';
import type { ErrorSink } from './logging/errors.js';
import type { MasterConfig } from './master/types.js';
import {
  DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
  MAX_MASTER_EVENTS_RETENTION_DAYS,
  type RetentionSettings,
} from './retention/settings.js';
import { SUMMARY_DERIVED_NOTE, type SummaryConfig } from './summary/types.js';
import {
  DEFAULT_USAGE_RETENTION_DAYS,
  MAX_USAGE_RETENTION_DAYS,
  type UsageSettings,
} from './usage/settings.js';

export const DEFAULT_MASTER_PROMPT = [
  'You are the cell master reviewing an implementation request.',
  'If you are blocked on a decision, record the decision in the request context with',
  '`update_request`, then continue implementing instead of waiting.',
  'If the implementation is complete, finish your reply with the exact line:',
  'READY FOR REVIEW',
  'Do not ask the human questions. Keep the request moving.',
].join('\n');

export const DEFAULT_SUMMARY_PROMPT = [
  'Write a concise markdown scorecard from the facts in this message.',
  'Use only the supplied numbers; never invent data or estimate activity.',
  'Use these sections: Summary, Throughput, Pipeline, Automation, Risks, Trend.',
  'Compare this window with the previous-window totals when they are useful.',
  'Keep it under 400 words. If the window is quiet, say so in one short paragraph.',
  'End with this exact line:',
  SUMMARY_DERIVED_NOTE,
  'Do not ask questions. Do not edit tickets. Call a read-only board tool only when a',
  'needed fact is missing from the snapshot.',
].join('\n');

// Compile-time guard: the runtime schema and the shared contract cannot drift.
const masterSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(24 * 60),
  idleMinutes: z.number().int().min(1).max(24 * 60),
  autoReview: z.boolean(),
  prompt: z.string().min(1).max(8000),
}) satisfies z.ZodType<MasterConfig>;

const summarySchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60),
  windowMinutes: z.number().int().min(1).max(7 * 24 * 60),
  prompt: z.string().min(1).max(8000),
}) satisfies z.ZodType<SummaryConfig>;

const usageSchema = z.object({
  retentionDays: z.number().int().min(0).max(MAX_USAGE_RETENTION_DAYS),
}) satisfies z.ZodType<UsageSettings>;

const budgetSchema = z.object({
  monthlyUsd: z.number().positive().max(MAX_BUDGET_USD).nullable(),
  alertAtPercent: z.number().int().min(1).max(100),
  pauseOnExceeded: z.boolean(),
}) satisfies z.ZodType<BudgetSettings>;

const retentionSchema = z.object({
  masterEventsDays: z.number().int().min(0).max(MAX_MASTER_EVENTS_RETENTION_DAYS),
}) satisfies z.ZodType<RetentionSettings>;

const settingsSchema = z.object({
  master: masterSchema,
  summary: summarySchema,
  usage: usageSchema.default({ retentionDays: DEFAULT_USAGE_RETENTION_DAYS }),
  retention: retentionSchema.default({
    masterEventsDays: DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
  }),
  // A legacy config with only `master`/`summary` loads with the default budget.
  budget: budgetSchema.default(() => ({ ...DEFAULT_BUDGET_SETTINGS })),
});

export type MasterSettings = MasterConfig;
export type SummarySettings = SummaryConfig;
export type AppSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  master: {
    enabled: true,
    intervalMinutes: 5,
    idleMinutes: 10,
    autoReview: true,
    prompt: DEFAULT_MASTER_PROMPT,
  },
  summary: {
    enabled: true,
    intervalMinutes: 6 * 60,
    windowMinutes: 6 * 60,
    prompt: DEFAULT_SUMMARY_PROMPT,
  },
  usage: {
    retentionDays: DEFAULT_USAGE_RETENTION_DAYS,
  },
  retention: {
    masterEventsDays: DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
  },
  budget: { ...DEFAULT_BUDGET_SETTINGS },
};

export const settingsPatchSchema = z
  .object({
    master: masterSchema.partial().optional(),
    summary: summarySchema.partial().optional(),
    usage: usageSchema.partial().optional(),
    retention: retentionSchema.partial().optional(),
    budget: budgetSchema.partial().optional(),
  })
  .refine(
    (value) =>
      value.master !== undefined ||
      value.summary !== undefined ||
      value.usage !== undefined ||
      value.retention !== undefined ||
      value.budget !== undefined,
    {
      message: 'at least one settings block is required',
    },
  );

/**
 * Persistent app settings, separate from the brain's environment/path config.
 * Unknown keys are stripped; an invalid file falls back to defaults until the
 * operator saves a valid one.
 */
export class SettingsStore {
  private cached: AppSettings | null = null;
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(
    readonly path: string,
    private readonly errors?: ErrorSink,
  ) {}

  get(): AppSettings {
    if (!this.cached) this.cached = this.load();
    return this.cached;
  }

  patch(input: unknown): AppSettings {
    const parsed = settingsPatchSchema.parse(input);
    const current = this.get();
    const next = settingsSchema.parse({
      ...current,
      master: { ...current.master, ...(parsed.master ?? {}) },
      summary: { ...current.summary, ...(parsed.summary ?? {}) },
      usage: { ...current.usage, ...(parsed.usage ?? {}) },
      retention: { ...current.retention, ...(parsed.retention ?? {}) },
      budget: { ...current.budget, ...(parsed.budget ?? {}) },
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
      const parsed: unknown = JSON.parse(raw);
      const source =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
      // Files written before a later block existed carry only `master`. Merge
      // each present block over the defaults so an upgrade does not silently
      // reset operator customizations.
      const savedBudget = source?.['budget'];
      const candidate = {
        master: source?.['master'] ?? DEFAULT_SETTINGS.master,
        summary: source?.['summary'] ?? DEFAULT_SETTINGS.summary,
        usage: source?.['usage'] ?? DEFAULT_SETTINGS.usage,
        retention: source?.['retention'] ?? DEFAULT_SETTINGS.retention,
        // Merge the budget block over defaults so a file written before
        // `pauseOnExceeded` existed still loads, and so a saved budget is not
        // silently reset on restart.
        budget: {
          ...DEFAULT_SETTINGS.budget,
          ...(typeof savedBudget === 'object' && savedBudget !== null ? savedBudget : {}),
        },
      };
      const result = settingsSchema.safeParse(candidate);
      if (!result.success) {
        this.errors?.error('settings.invalid', new Error(result.error.message), {
          path: this.path,
        });
        console.warn(`ignoring invalid settings at ${this.path}: ${result.error.message}`);
        return structuredClone(DEFAULT_SETTINGS);
      }
      return result.data;
    } catch (error) {
      this.errors?.error('settings.unreadable', error, { path: this.path });
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
