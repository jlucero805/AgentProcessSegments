import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_EVENT_COALESCE_MINUTES,
  DEFAULT_EVENT_NOTIFICATIONS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SMTP_PORT,
  EVENT_CHANNELS,
  MAX_BOT_TOKEN_LENGTH,
  MAX_BUDGET_USD,
  MAX_CHAT_DESTINATIONS,
  MAX_CHAT_LABEL_LENGTH,
  MAX_CHAT_ROUTES,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_EMAIL_RECIPIENTS,
  MAX_EVENT_COALESCE_MINUTES,
  MAX_EVENT_ROUTES,
  MIN_BOT_TOKEN_LENGTH,
  MIN_EVENT_COALESCE_MINUTES,
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
  type EventChannelSettings,
  type EventNotificationSettings,
  type EventRoute,
  type NotificationsSettings,
  type NotificationsView,
  type WebhookSettings,
} from './domain/budget.js';
import { EVENT_NOTIFICATION_KINDS } from './domain/notifications.js';
import type { SettingsWarning } from './domain/settings-warnings.js';
import type { ErrorSink } from './logging/errors.js';
import type { MasterConfig } from './master/types.js';
import {
  DEFAULT_BUDGET_ALERTS_RETENTION_DAYS,
  DEFAULT_CELL_SUMMARIES_RETENTION_DAYS,
  DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_EVENTS_RETENTION_DAYS,
  DEFAULT_REQUEST_ARTIFACTS_RETENTION_DAYS,
  DEFAULT_SPEND_CAP_OVERRIDES_RETENTION_DAYS,
  MAX_BUDGET_ALERTS_RETENTION_DAYS,
  MAX_CELL_SUMMARIES_RETENTION_DAYS,
  MAX_MASTER_EVENTS_RETENTION_DAYS,
  MAX_NOTIFICATION_EVENTS_RETENTION_DAYS,
  MAX_REQUEST_ARTIFACTS_RETENTION_DAYS,
  MAX_SPEND_CAP_OVERRIDES_RETENTION_DAYS,
  type RetentionSettings,
} from './retention/settings.js';
import { SUMMARY_DERIVED_NOTE, type SummaryConfig } from './summary/types.js';
import {
  DEFAULT_USAGE_RETENTION_DAYS,
  MAX_USAGE_RETENTION_DAYS,
  type UsageSettings,
} from './usage/settings.js';
import { writePrivateFile } from './util/files.js';
import { jsonParseReason } from './util/json.js';
import { createPreservedCopy, listPreservedCopies } from './util/preserved-copies.js';

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
  budgetAlertsDays: z.number().int().min(0).max(MAX_BUDGET_ALERTS_RETENTION_DAYS),
  notificationEventsDays: z.number().int().min(0).max(MAX_NOTIFICATION_EVENTS_RETENTION_DAYS),
  spendCapOverridesDays: z.number().int().min(0).max(MAX_SPEND_CAP_OVERRIDES_RETENTION_DAYS),
}) satisfies z.ZodType<RetentionSettings>;

const webhookSchema: z.ZodType<WebhookSettings, unknown> = z
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

const emailSchema: z.ZodType<EmailSettings, unknown> = z
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
): z.ZodType<ChatSettings, unknown> {
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

const eventChannelSchema: z.ZodType<EventChannelSettings, unknown> = z.object({
  webhook: z.boolean().default(false),
  email: z.boolean().default(false),
});

const eventRouteSchema: z.ZodType<EventRoute, unknown> = z.object({
  kind: z.enum(EVENT_NOTIFICATION_KINDS),
  channel: z.enum(EVENT_CHANNELS),
  cellId: z.string().min(1).max(64),
});

const eventRoutesSchema = z
  .array(eventRouteSchema)
  .max(MAX_EVENT_ROUTES)
  .superRefine((routes, ctx) => {
    const seen = new Set<string>();
    routes.forEach((route, index) => {
      const key = `${route.kind}\u0000${route.channel}\u0000${route.cellId}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'duplicate event route',
        });
      }
      seen.add(key);
    });
  });

const eventsSchema: z.ZodType<EventNotificationSettings, unknown> = z.object({
  failedTurns: eventChannelSchema.default(() => ({
    ...DEFAULT_EVENT_NOTIFICATIONS.failedTurns,
  })),
  masterErrors: eventChannelSchema.default(() => ({
    ...DEFAULT_EVENT_NOTIFICATIONS.masterErrors,
  })),
  summaryFailures: eventChannelSchema.default(() => ({
    ...DEFAULT_EVENT_NOTIFICATIONS.summaryFailures,
  })),
  spendOverrides: eventChannelSchema.default(() => ({
    ...DEFAULT_EVENT_NOTIFICATIONS.spendOverrides,
  })),
  coalesceMinutes: z
    .number()
    .int()
    .min(MIN_EVENT_COALESCE_MINUTES)
    .max(MAX_EVENT_COALESCE_MINUTES)
    .default(DEFAULT_EVENT_COALESCE_MINUTES),
  routes: eventRoutesSchema.default(() => []),
});

const notificationsSchema: z.ZodType<NotificationsSettings, unknown> = z.object({
  webhook: webhookSchema.default(() => ({ ...DEFAULT_NOTIFICATIONS.webhook })),
  email: emailSchema,
  slack: chatProviderSchema('slack').default(() => structuredClone(DEFAULT_CHAT_SETTINGS)),
  discord: chatProviderSchema('discord').default(() => structuredClone(DEFAULT_CHAT_SETTINGS)),
  events: eventsSchema.default(() => ({
    failedTurns: { ...DEFAULT_EVENT_NOTIFICATIONS.failedTurns },
    masterErrors: { ...DEFAULT_EVENT_NOTIFICATIONS.masterErrors },
    summaryFailures: { ...DEFAULT_EVENT_NOTIFICATIONS.summaryFailures },
    spendOverrides: { ...DEFAULT_EVENT_NOTIFICATIONS.spendOverrides },
    coalesceMinutes: DEFAULT_EVENT_NOTIFICATIONS.coalesceMinutes,
    routes: [],
  })),
});

const webhookPatchSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().max(2048).nullable().optional(),
  format: z.enum(WEBHOOK_FORMATS).optional(),
  secret: z.string().min(16).max(256).nullable().optional(),
});

const emailPatchSchema: z.ZodType<Partial<EmailSettings>, unknown> = z.object({
  enabled: z.boolean().optional(),
  host: z.string().max(253).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().min(1).max(MAX_EMAIL_ADDRESS_LENGTH).nullable().optional(),
  password: z.string().min(1).max(1024).nullable().optional(),
  from: z.string().max(MAX_EMAIL_ADDRESS_LENGTH).nullable().optional(),
  to: z.array(z.string().max(MAX_EMAIL_ADDRESS_LENGTH)).max(MAX_EMAIL_RECIPIENTS).optional(),
});

const chatPatchSchema: z.ZodType<Partial<ChatSettings>, unknown> = z.object({
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

const eventChannelPatchSchema = z.object({
  webhook: z.boolean().optional(),
  email: z.boolean().optional(),
});

const eventsPatchSchema = z.object({
  failedTurns: eventChannelPatchSchema.optional(),
  masterErrors: eventChannelPatchSchema.optional(),
  summaryFailures: eventChannelPatchSchema.optional(),
  spendOverrides: eventChannelPatchSchema.optional(),
  coalesceMinutes: z
    .number()
    .int()
    .min(MIN_EVENT_COALESCE_MINUTES)
    .max(MAX_EVENT_COALESCE_MINUTES)
    .optional(),
  routes: eventRoutesSchema.optional(),
});


const settingsSchema = z.object({
  master: masterSchema,
  summary: summarySchema,
  usage: usageSchema.default({ retentionDays: DEFAULT_USAGE_RETENTION_DAYS }),
  retention: retentionSchema.default({
    masterEventsDays: DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
    cellSummariesDays: DEFAULT_CELL_SUMMARIES_RETENTION_DAYS,
    requestArtifactsDays: DEFAULT_REQUEST_ARTIFACTS_RETENTION_DAYS,
    budgetAlertsDays: DEFAULT_BUDGET_ALERTS_RETENTION_DAYS,
    notificationEventsDays: DEFAULT_NOTIFICATION_EVENTS_RETENTION_DAYS,
    spendCapOverridesDays: DEFAULT_SPEND_CAP_OVERRIDES_RETENTION_DAYS,
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
    budgetAlertsDays: DEFAULT_BUDGET_ALERTS_RETENTION_DAYS,
    notificationEventsDays: DEFAULT_NOTIFICATION_EVENTS_RETENTION_DAYS,
    spendCapOverridesDays: DEFAULT_SPEND_CAP_OVERRIDES_RETENTION_DAYS,
  },
  budget: { ...DEFAULT_BUDGET_SETTINGS },
  notifications: {
    webhook: { ...DEFAULT_NOTIFICATIONS.webhook },
    email: { ...DEFAULT_NOTIFICATIONS.email, to: [] },
    slack: structuredClone(DEFAULT_NOTIFICATIONS.slack),
    discord: structuredClone(DEFAULT_NOTIFICATIONS.discord),
    events: {
      failedTurns: { ...DEFAULT_EVENT_NOTIFICATIONS.failedTurns },
      masterErrors: { ...DEFAULT_EVENT_NOTIFICATIONS.masterErrors },
      summaryFailures: { ...DEFAULT_EVENT_NOTIFICATIONS.summaryFailures },
      spendOverrides: { ...DEFAULT_EVENT_NOTIFICATIONS.spendOverrides },
      coalesceMinutes: DEFAULT_EVENT_NOTIFICATIONS.coalesceMinutes,
      routes: [],
    },
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
      events: {
        failedTurns: { ...settings.notifications.events.failedTurns },
        masterErrors: { ...settings.notifications.events.masterErrors },
        summaryFailures: { ...settings.notifications.events.summaryFailures },
        spendOverrides: { ...settings.notifications.events.spendOverrides },
        coalesceMinutes: settings.notifications.events.coalesceMinutes,
        routes: settings.notifications.events.routes.map((route) => ({ ...route })),
      },
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
        events: eventsPatchSchema.optional(),
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

/** One warning for a file every block had to be reset from. */
function wholeFileWarning(reason: string): SettingsWarning {
  return { block: null, message: `${reason}; all settings loaded as defaults` };
}

/** A block or notification channel that recovers to its own defaults when invalid. */
type SettingsUnitName =
  | 'master'
  | 'summary'
  | 'usage'
  | 'retention'
  | 'budget'
  | `notifications.${keyof NotificationsSettings}`;

interface SettingsUnit {
  /** Stable name reported with `settings.invalid`, such as `notifications.webhook`. */
  readonly name: SettingsUnitName;
  /** Where the value lives in the merged settings object. */
  readonly section: 'top' | 'notifications';
  readonly key: string;
  readonly schema: z.ZodTypeAny;
  /** The whole unit is replaced with this default when it fails validation. */
  readonly fallback: unknown;
}

/**
 * Validation units, ordered as the settings object. Each notification channel is
 * its own unit so a bad SMTP port cannot reset a saved webhook URL or secret.
 */
const settingsUnits: readonly SettingsUnit[] = [
  {
    name: 'master',
    section: 'top',
    key: 'master',
    schema: masterSchema,
    fallback: DEFAULT_SETTINGS.master,
  },
  {
    name: 'summary',
    section: 'top',
    key: 'summary',
    schema: summarySchema,
    fallback: DEFAULT_SETTINGS.summary,
  },
  {
    name: 'usage',
    section: 'top',
    key: 'usage',
    schema: usageSchema,
    fallback: DEFAULT_SETTINGS.usage,
  },
  {
    name: 'retention',
    section: 'top',
    key: 'retention',
    schema: retentionSchema,
    fallback: DEFAULT_SETTINGS.retention,
  },
  {
    name: 'budget',
    section: 'top',
    key: 'budget',
    schema: budgetSchema,
    fallback: DEFAULT_SETTINGS.budget,
  },
  {
    name: 'notifications.webhook',
    section: 'notifications',
    key: 'webhook',
    schema: webhookSchema,
    fallback: DEFAULT_SETTINGS.notifications.webhook,
  },
  {
    name: 'notifications.email',
    section: 'notifications',
    key: 'email',
    schema: emailSchema,
    fallback: DEFAULT_SETTINGS.notifications.email,
  },
  {
    name: 'notifications.slack',
    section: 'notifications',
    key: 'slack',
    schema: chatProviderSchema('slack'),
    fallback: DEFAULT_SETTINGS.notifications.slack,
  },
  {
    name: 'notifications.discord',
    section: 'notifications',
    key: 'discord',
    schema: chatProviderSchema('discord'),
    fallback: DEFAULT_SETTINGS.notifications.discord,
  },
  {
    name: 'notifications.events',
    section: 'notifications',
    key: 'events',
    schema: eventsSchema,
    fallback: DEFAULT_SETTINGS.notifications.events,
  },
];

/** Read one unit's merged value; a non-object parent makes every child invalid. */
function settingsUnitValue(candidate: Record<string, unknown>, unit: SettingsUnit): unknown {
  const container = unit.section === 'top' ? candidate : candidate.notifications;
  return isPlainObject(container) ? container[unit.key] : undefined;
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
 * Unknown keys are stripped. Every block and notification channel validates on
 * its own: one invalid unit falls back to its defaults while the rest of the
 * file loads intact. An unreadable or unparseable file falls back to all
 * defaults. Loading never writes, so the operator's file is untouched until a
 * patch saves a valid value; that first save copies an unusable file aside
 * first, so recovery never destroys the operator's original bytes.
 */
export class SettingsStore {
  private cached: AppSettings | null = null;
  private readonly listeners = new Set<(settings: AppSettings) => void>();
  /** Set when the loaded file was unusable; the next save preserves its bytes. */
  private preserveSource = false;
  /** Copy made by the last save of an unusable file, kept for the UI. */
  private preservedFilePath: string | null = null;
  /** Units reset to defaults by the load that produced the cached settings. */
  private loadWarnings: SettingsWarning[] = [];

  constructor(
    readonly path: string,
    private readonly errors?: ErrorSink,
  ) {}

  get(): AppSettings {
    if (!this.cached) this.cached = this.load();
    return this.cached;
  }

  /** Units reset to defaults by this load, or [] for a valid or missing file. */
  warnings(): SettingsWarning[] {
    this.get();
    return this.loadWarnings.map((warning) => ({ ...warning }));
  }

  /**
   * Path of the copy this process made when a save replaced an unusable file, or
   * null when no save has needed one. In-memory only; it is not a config key.
   */
  preservedPath(): string | null {
    return this.preservedFilePath;
  }

  /**
   * Existing preserved copies next to this settings file, newest first. Paths
   * only; a missing or unreadable directory has no copies. The copy this process
   * made is first when it is among them, even if the clock moved backwards.
   */
  preservedCopies(): string[] {
    return listPreservedCopies(this.path, { newest: this.preservedFilePath });
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
        events: {
          failedTurns: {
            ...current.notifications.events.failedTurns,
            ...(parsed.notifications?.events?.failedTurns ?? {}),
          },
          masterErrors: {
            ...current.notifications.events.masterErrors,
            ...(parsed.notifications?.events?.masterErrors ?? {}),
          },
          summaryFailures: {
            ...current.notifications.events.summaryFailures,
            ...(parsed.notifications?.events?.summaryFailures ?? {}),
          },
          spendOverrides: {
            ...current.notifications.events.spendOverrides,
            ...(parsed.notifications?.events?.spendOverrides ?? {}),
          },
          coalesceMinutes:
            parsed.notifications?.events?.coalesceMinutes ??
            current.notifications.events.coalesceMinutes,
          routes: (
            parsed.notifications?.events?.routes ??
            current.notifications.events.routes
          ).map((route) => ({ ...route })),
        },
      },
    });
    this.write(next);
    this.cached = next;
    // The save persists valid values and preserves the unusable original, so
    // the recovery warnings no longer describe the stored file.
    this.loadWarnings = [];
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): AppSettings {
    this.loadWarnings = [];

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.preserveSource = true;
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
        this.loadWarnings = [wholeFileWarning(`could not be read (${code})`)];
        this.errors?.error('settings.unreadable', error, { path: this.path });
        console.warn(`ignoring unreadable settings at ${this.path}: ${String(error)}`);
      }
      return structuredClone(DEFAULT_SETTINGS);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.preserveSource = true;
      this.loadWarnings = [wholeFileWarning('is not valid JSON')];
      const reason = jsonParseReason(error);
      this.errors?.error('settings.unreadable', new Error(reason), {
        path: this.path,
        reason: 'invalid-json',
      });
      console.warn(`ignoring unreadable settings at ${this.path}: ${reason}`);
      return structuredClone(DEFAULT_SETTINGS);
    }

    if (!isPlainObject(parsed)) {
      this.preserveSource = true;
      const error = new Error('settings must be a JSON object');
      this.loadWarnings = [wholeFileWarning('must be a JSON object')];
      this.errors?.error('settings.invalid', error, {
        path: this.path,
        reason: 'not-an-object',
      });
      console.warn(`ignoring invalid settings at ${this.path}: ${error.message}`);
      return structuredClone(DEFAULT_SETTINGS);
    }

    // Merge every present block over its default so an upgrade or a partial
    // hand-edited file keeps the saved values (budget included) and gains new
    // defaults. A `null` inside a nullable field is preserved; a `null` whole
    // block means "use the default block".
    const candidate = mergeSettings(DEFAULT_SETTINGS, parsed);
    return this.recover(candidate);
  }

  /**
   * Validate each unit independently and replace only the ones that fail, so a
   * typo in one block cannot silently discard the rest of the file. Unrelated
   * blocks keep their saved values; an invalid unit loads as its default and is
   * reported once. Nothing is written.
   */
  private recover(candidate: Record<string, unknown>): AppSettings {
    const recovered: Record<string, unknown> = {};
    const notifications: Record<string, unknown> = {};

    for (const unit of settingsUnits) {
      const result = unit.schema.safeParse(settingsUnitValue(candidate, unit));
      let value: unknown;
      if (result.success) {
        value = result.data;
      } else {
        this.preserveSource = true;
        value = structuredClone(unit.fallback);
        this.loadWarnings.push({ block: unit.name, message: result.error.message });
        this.errors?.error('settings.invalid', new Error(result.error.message), {
          path: this.path,
          block: unit.name,
        });
        console.warn(
          `ignoring invalid settings block ${unit.name} at ${this.path}: ${result.error.message}`,
        );
      }
      if (unit.section === 'top') recovered[unit.key] = value;
      else notifications[unit.key] = value;
    }
    recovered.notifications = notifications;

    // Safety net: a new block or cross-block rule that slips past the units
    // above still loads as all defaults instead of a partial object.
    const result = settingsSchema.safeParse(recovered);
    if (!result.success) {
      this.preserveSource = true;
      // Every block is now at its defaults, so the per-unit warnings are moot.
      this.loadWarnings = [wholeFileWarning('failed whole-file validation')];
      this.errors?.error('settings.invalid', new Error(result.error.message), {
        path: this.path,
      });
      console.warn(`ignoring invalid settings at ${this.path}: ${result.error.message}`);
      return structuredClone(DEFAULT_SETTINGS);
    }
    return result.data;
  }

  /**
   * Copy an unusable file aside before the first save replaces it. The copy is
   * the exact original bytes (it can hold credentials), owner-only, and never
   * overwrites an earlier copy. A failed copy aborts the save so the file is
   * never destroyed without one.
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
      this.errors?.error('settings.backupFailed', error, { path: this.path });
      throw error;
    }

    let backup: string;
    try {
      backup = createPreservedCopy(this.path, raw);
    } catch (error) {
      this.errors?.error('settings.backupFailed', error, { path: this.path });
      throw error;
    }

    this.preservedFilePath = backup;
    this.preserveSource = false;
    console.warn(`preserving unusable settings at ${this.path} as ${backup}`);
  }

  private write(settings: AppSettings): void {
    this.preserveUnusableSource();
    writePrivateFile(this.path, `${JSON.stringify(settings, null, 2)}\n`);
  }
}
