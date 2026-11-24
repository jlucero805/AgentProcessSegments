import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SMTP_PORT,
  MAX_BOT_TOKEN_LENGTH,
  MAX_BUDGET_USD,
  MAX_CHAT_DESTINATIONS,
  MAX_CHAT_LABEL_LENGTH,
  MAX_CHAT_ROUTES,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_EMAIL_RECIPIENTS,
  MIN_BOT_TOKEN_LENGTH,
  WEBHOOK_FORMATS,
  chatBotTokenError,
  chatChannelIdError,
  emailAddressError,
  emailRecipientsError,
  smtpHostError,
  webhookUrlError,
  type BudgetSettings,
  type ChatProvider,
  type ChatSettings,
  type ChatView,
  type EmailSettings,
  type NotificationsSettings,
  type NotificationsView,
  type WebhookSettings,
} from './domain/budget.js';
import type { ErrorSink } from './logging/errors.js';
import type { MasterConfig } from './master/types.js';
import {
  DEFAULT_CELL_SUMMARIES_RETENTION_DAYS,
  DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
  DEFAULT_REQUEST_ARTIFACTS_RETENTION_DAYS,
  MAX_CELL_SUMMARIES_RETENTION_DAYS,
  MAX_MASTER_EVENTS_RETENTION_DAYS,
  MAX_REQUEST_ARTIFACTS_RETENTION_DAYS,
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
  pauseOnUnknownCost: z.boolean(),
}) satisfies z.ZodType<BudgetSettings>;

const retentionSchema = z.object({
  masterEventsDays: z.number().int().min(0).max(MAX_MASTER_EVENTS_RETENTION_DAYS),
  cellSummariesDays: z.number().int().min(0).max(MAX_CELL_SUMMARIES_RETENTION_DAYS),
  requestArtifactsDays: z.number().int().min(0).max(MAX_REQUEST_ARTIFACTS_RETENTION_DAYS),
}) satisfies z.ZodType<RetentionSettings>;

const webhookSchema: z.ZodType<WebhookSettings, z.ZodTypeDef, unknown> = z
  .object({
    enabled: z.boolean().default(false),
    url: z.string().max(2048).nullable().default(null),
    format: z.enum(WEBHOOK_FORMATS).default('json'),
    secret: z.string().min(16).max(256).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.url === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'a webhook URL is required when delivery is enabled',
      });
      return;
    }
    if (value.url === null) return;
    const problem = webhookUrlError(value.url);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: problem });
    }
  });

const emailSchema: z.ZodType<EmailSettings, z.ZodTypeDef, unknown> = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().max(253).nullable().default(null),
    port: z.number().int().min(1).max(65535).default(DEFAULT_SMTP_PORT),
    secure: z.boolean().default(false),
    username: z.string().min(1).max(MAX_EMAIL_ADDRESS_LENGTH).nullable().default(null),
    password: z.string().min(1).max(1024).nullable().default(null),
    from: z.string().max(MAX_EMAIL_ADDRESS_LENGTH).nullable().default(null),
    to: z.array(z.string().max(MAX_EMAIL_ADDRESS_LENGTH)).max(MAX_EMAIL_RECIPIENTS).default([]),
  })
  .superRefine((value, ctx) => {
    const host = value.host === null ? null : value.host.trim();
    if (host === null) {
      if (value.enabled) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: 'is required' });
      }
    } else {
      const problem = smtpHostError(host);
      if (problem) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: problem });
      }
    }

    const from = value.from === null ? null : value.from.trim();
    if (from === null) {
      if (value.enabled) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'is required' });
      }
    } else {
      const problem = emailAddressError(from);
      if (problem) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: problem });
      }
    }

    if (value.to.length === 0) {
      if (value.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['to'],
          message: 'at least one recipient is required',
        });
      }
    } else {
      const problem = emailRecipientsError(value.to);
      if (problem) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: problem });
      }
    }

    if ((value.username === null) !== (value.password === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'username and password must be set together',
      });
    }
  });

const chatDestinationSchema = z.object({
  channelId: z.string().max(64),
  label: z.string().min(1).max(MAX_CHAT_LABEL_LENGTH).nullable().default(null),
});

const chatRouteSchema = z.object({
  cellId: z.string().min(1).max(64),
  channelId: z.string().max(64),
});

function chatProviderSchema(
  provider: ChatProvider,
): z.ZodType<ChatSettings, z.ZodTypeDef, unknown> {
  return z
    .object({
      enabled: z.boolean().default(false),
      botToken: z
        .string()
        .min(MIN_BOT_TOKEN_LENGTH)
        .max(MAX_BOT_TOKEN_LENGTH)
        .nullable()
        .default(null),
      destinations: z.array(chatDestinationSchema).max(MAX_CHAT_DESTINATIONS).default([]),
      defaultChannelId: z.string().max(64).nullable().default(null),
      routes: z.array(chatRouteSchema).max(MAX_CHAT_ROUTES).default([]),
    })
    .superRefine((value, ctx) => {
      if (value.enabled && value.botToken === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['botToken'],
          message: 'a bot token is required when delivery is enabled',
        });
      }
      if (value.botToken !== null) {
        const problem = chatBotTokenError(value.botToken);
        if (problem) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['botToken'], message: problem });
        }
      }

      const destinations = new Set<string>();
      value.destinations.forEach((destination, index) => {
        const problem = chatChannelIdError(provider, destination.channelId);
        if (problem) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['destinations', index, 'channelId'],
            message: problem,
          });
        }
        if (destinations.has(destination.channelId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['destinations', index, 'channelId'],
            message: 'destinations must be unique',
          });
        }
        destinations.add(destination.channelId);
      });

      if (value.defaultChannelId !== null && !destinations.has(value.defaultChannelId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultChannelId'],
          message: 'must name a configured destination',
        });
      }

      const routeCells = new Set<string>();
      value.routes.forEach((route, index) => {
        if (routeCells.has(route.cellId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['routes', index, 'cellId'],
            message: 'each cell may have only one route',
          });
        }
        routeCells.add(route.cellId);
        if (!destinations.has(route.channelId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['routes', index, 'channelId'],
            message: 'must name a configured destination',
          });
        }
      });

      if (value.enabled) {
        if (value.destinations.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['destinations'],
            message: 'at least one destination is required',
          });
        }
        if (value.defaultChannelId === null && value.routes.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['defaultChannelId'],
            message: 'a default destination or a cell route is required',
          });
        }
      }
    });
}

const notificationsSchema: z.ZodType<NotificationsSettings, z.ZodTypeDef, unknown> = z.object({
  webhook: webhookSchema.default(() => ({ ...DEFAULT_NOTIFICATIONS.webhook })),
  email: emailSchema,
  slack: chatProviderSchema('slack').default(() => structuredClone(DEFAULT_CHAT_SETTINGS)),
  discord: chatProviderSchema('discord').default(() => structuredClone(DEFAULT_CHAT_SETTINGS)),
});

const webhookPatchSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().max(2048).nullable().optional(),
  format: z.enum(WEBHOOK_FORMATS).optional(),
  secret: z.string().min(16).max(256).nullable().optional(),
});

const emailPatchSchema: z.ZodType<Partial<EmailSettings>, z.ZodTypeDef, unknown> = z.object({
  enabled: z.boolean().optional(),
  host: z.string().max(253).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().min(1).max(MAX_EMAIL_ADDRESS_LENGTH).nullable().optional(),
  password: z.string().min(1).max(1024).nullable().optional(),
  from: z.string().max(MAX_EMAIL_ADDRESS_LENGTH).nullable().optional(),
  to: z.array(z.string().max(MAX_EMAIL_ADDRESS_LENGTH)).max(MAX_EMAIL_RECIPIENTS).optional(),
});

const chatPatchSchema: z.ZodType<Partial<ChatSettings>, z.ZodTypeDef, unknown> = z.object({
  enabled: z.boolean().optional(),
  botToken: z
    .string()
    .min(MIN_BOT_TOKEN_LENGTH)
    .max(MAX_BOT_TOKEN_LENGTH)
    .nullable()
    .optional(),
  destinations: z.array(chatDestinationSchema).max(MAX_CHAT_DESTINATIONS).optional(),
  defaultChannelId: z.string().max(64).nullable().optional(),
  routes: z.array(chatRouteSchema).max(MAX_CHAT_ROUTES).optional(),
});

const settingsSchema = z.object({
  master: masterSchema,
  summary: summarySchema,
  usage: usageSchema.default({ retentionDays: DEFAULT_USAGE_RETENTION_DAYS }),
  retention: retentionSchema.default({
    masterEventsDays: DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
    cellSummariesDays: DEFAULT_CELL_SUMMARIES_RETENTION_DAYS,
    requestArtifactsDays: DEFAULT_REQUEST_ARTIFACTS_RETENTION_DAYS,
  }),
  // A legacy config with only `master`/`summary` loads with the default budget.
  budget: budgetSchema.default(() => ({ ...DEFAULT_BUDGET_SETTINGS })),
  notifications: notificationsSchema.default(() => structuredClone(DEFAULT_NOTIFICATIONS)),
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
    cellSummariesDays: DEFAULT_CELL_SUMMARIES_RETENTION_DAYS,
    requestArtifactsDays: DEFAULT_REQUEST_ARTIFACTS_RETENTION_DAYS,
  },
  budget: { ...DEFAULT_BUDGET_SETTINGS },
  notifications: {
    webhook: { ...DEFAULT_NOTIFICATIONS.webhook },
    email: { ...DEFAULT_NOTIFICATIONS.email, to: [] },
    slack: structuredClone(DEFAULT_NOTIFICATIONS.slack),
    discord: structuredClone(DEFAULT_NOTIFICATIONS.discord),
  },
};

export type RedactedSettings = Omit<AppSettings, 'notifications'> & {
  notifications: NotificationsView;
};

function redactChat(chat: ChatSettings): ChatView {
  return {
    enabled: chat.enabled,
    botToken: null,
    botTokenSet: chat.botToken !== null,
    destinations: chat.destinations.map((destination) => ({ ...destination })),
    defaultChannelId: chat.defaultChannelId,
    routes: chat.routes.map((route) => ({ ...route })),
  };
}

/** The HTTP view of settings: never expose a stored webhook secret, SMTP password, or bot token. */
export function redactSettings(settings: AppSettings): RedactedSettings {
  const webhook = settings.notifications.webhook;
  const email = settings.notifications.email;
  return {
    ...settings,
    notifications: {
      webhook: {
        enabled: webhook.enabled,
        url: webhook.url,
        format: webhook.format,
        secret: null,
        secretSet: webhook.secret !== null,
      },
      email: {
        enabled: email.enabled,
        host: email.host,
        port: email.port,
        secure: email.secure,
        username: email.username,
        password: null,
        passwordSet: email.password !== null,
        from: email.from,
        to: [...email.to],
      },
      slack: redactChat(settings.notifications.slack),
      discord: redactChat(settings.notifications.discord),
    },
  };
}

export const settingsPatchSchema = z
  .object({
    master: masterSchema.partial().optional(),
    summary: summarySchema.partial().optional(),
    usage: usageSchema.partial().optional(),
    retention: retentionSchema.partial().optional(),
    budget: budgetSchema.partial().optional(),
    notifications: z
      .object({
        webhook: webhookPatchSchema.optional(),
        email: emailPatchSchema.optional(),
        slack: chatPatchSchema.optional(),
        discord: chatPatchSchema.optional(),
      })
      .partial()
      .optional(),
  })
  .refine(
    (value) =>
      value.master !== undefined ||
      value.summary !== undefined ||
      value.usage !== undefined ||
      value.retention !== undefined ||
      value.budget !== undefined ||
      value.notifications !== undefined,
    {
      message: 'at least one settings block is required',
    },
  );

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a saved settings value over its default. Present objects merge field by
 * field; arrays and scalars replace the default. A `null` whole block means
 * "use the default block", while a `null` inside a nullable field is a value
 * and is preserved. Keys absent from the default are dropped; the schema would
 * strip them anyway.
 */
function mergeSettings<T>(defaults: T, saved: unknown): T {
  if (saved === undefined) return structuredClone(defaults);
  if (!isPlainObject(defaults)) return saved as T;
  if (saved === null) return structuredClone(defaults);
  if (!isPlainObject(saved)) return saved as T;

  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    merged[key] = mergeSettings(defaults[key], saved[key]);
  }
  return merged as unknown as T;
}

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
      notifications: {
        webhook: {
          ...current.notifications.webhook,
          ...(parsed.notifications?.webhook ?? {}),
        },
        email: {
          ...current.notifications.email,
          ...(parsed.notifications?.email ?? {}),
        },
        slack: {
          ...current.notifications.slack,
          ...(parsed.notifications?.slack ?? {}),
        },
        discord: {
          ...current.notifications.discord,
          ...(parsed.notifications?.discord ?? {}),
        },
      },
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
      const source = isPlainObject(parsed) ? parsed : null;
      // Merge every present block over its default so an upgrade or a partial
      // hand-edited file keeps the saved values (budget included) and gains new
      // defaults. A `null` inside a nullable field is preserved; a `null` whole
      // block means "use the default block". Only an invalid value below falls
      // back to the full defaults.
      const candidate = mergeSettings(DEFAULT_SETTINGS, source);
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
