/**
 * Spend-budget contract shared by the server and the SPA. Keep this module free
 * of Node-only imports so `src/web/src/types.ts` can re-export it for Vite.
 */
import type {
  EventDeliverySnapshot,
  NotificationEventKind,
} from './notifications.js';
import type { UsageTotals } from '../usage/types.js';

export const BUDGET_SCOPES = ['overall', 'cell'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_THRESHOLDS = ['warning', 'exceeded'] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

export const SPEND_PAUSE_REASONS = ['cap_reached', 'unknown_cost'] as const;
export type SpendPauseReason = (typeof SPEND_PAUSE_REASONS)[number];

export type BudgetState = 'ok' | 'warning' | 'exceeded' | 'unknown';

/** The operator-editable brain-level budget policy. */
export interface BudgetSettings {
  /** Null disables the overall budget. */
  monthlyUsd: number | null;
  /** Warning percentage for every budget; 100 means only the exceeded alert. */
  alertAtPercent: number;
  /** When true, new work is paused once cap spend reaches the overall budget. */
  pauseOnExceeded: boolean;
  /** When true, new work is also paused while any current-month turn has unknown cost. */
  pauseOnUnknownCost: boolean;
}

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  monthlyUsd: null,
  alertAtPercent: 80,
  pauseOnExceeded: false,
  pauseOnUnknownCost: false,
};

export const MAX_BUDGET_USD = 1_000_000;

/** Known-cost totals for one budget period. Kept narrow so tests can fake it. */
export type BudgetUsageTotals = Pick<
  UsageTotals,
  'turns' | 'costUsd' | 'estimatedCostUsd' | 'unpricedTurns' | 'unknownCostTurns'
>;

export interface BudgetStatus {
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  label: string;
  periodStart: number;
  periodEnd: number;
  budgetUsd: number;
  /** Known cost only. Zero when nothing is priced. */
  spendUsd: number;
  /** max(0, budgetUsd - spendUsd); an upper bound when spend is a lower bound. */
  remainingUsd: number;
  percentUsed: number;
  pricedTurns: number;
  unknownCostTurns: number;
  spendIsLowerBound: boolean;
  state: BudgetState;
  /** True when this scope pauses new work at the budget. */
  pauseOnExceeded: boolean;
  /** True when unknown cost also pauses this scope. */
  pauseOnUnknownCost: boolean;
  /** Reported plus estimated cost; used by hard caps only. */
  capSpendUsd: number;
  /** True when an unpriced turn makes cap spend a lower bound. */
  capSpendIsLowerBound: boolean;
  /** Turns with neither a reported nor an estimated cost. */
  unpricedTurns: number;
  /** True when this scope is currently refusing new work. */
  paused: boolean;
  /** Why this scope is paused, or null when it is not. */
  pauseReason: SpendPauseReason | null;
  /** Active override exempting this scope (its own or an overall one), or null. */
  overrideId: string | null;
  /** Expiry of that override, or null. */
  overrideExpiresAt: number | null;
}

/** A scope that is currently refusing new work because of a hard cap. */
export interface SpendPause {
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  label: string;
  /** Why the cap refuses work. */
  reason: SpendPauseReason;
  periodStart: number;
  periodEnd: number;
  budgetUsd: number;
  spendUsd: number;
  spendIsLowerBound: boolean;
  unpricedTurns: number;
  percentUsed: number;
}

/** A time-boxed operator release of a hard-cap pause. */
export interface SpendCapOverride {
  id: string;
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  periodStart: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  note: string | null;
  revokedAt: number | null;
}

export interface BudgetAlert {
  id: string;
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  threshold: BudgetThreshold;
  alertAtPercent: number;
  budgetUsd: number;
  spendUsd: number;
  unknownCostTurns: number;
  periodStart: number;
  createdAt: number;
  acknowledgedAt: number | null;
}

export interface BudgetsResponse {
  periodStart: number;
  periodEnd: number;
  alertAtPercent: number;
  /** Overall first, then cells by name. Only configured budgets appear. */
  statuses: BudgetStatus[];
  /** Unacknowledged alerts for the current period only. */
  alerts: BudgetAlert[];
  /** Scopes at their hard cap; an active override may be admitting them. */
  pauses: SpendPause[];
  /** Active overrides for the current period. Overall first, then cells by name. */
  overrides: SpendCapOverride[];
}

export const WEBHOOK_FORMATS = ['json', 'slack', 'discord'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Outbound budget-alert webhook policy. The secret is never returned by the API. */
export interface WebhookSettings {
  enabled: boolean;
  url: string | null;
  format: WebhookFormat;
  secret: string | null;
}

/** A webhook patch may omit any field; omitted fields keep their stored value. */
export type WebhookPatch = Partial<WebhookSettings>;

export const CHAT_PROVIDERS = ['slack', 'discord'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export const MAX_CHAT_DESTINATIONS = 50;
export const MAX_CHAT_ROUTES = 200;
export const MAX_CHAT_LABEL_LENGTH = 80;
export const MIN_BOT_TOKEN_LENGTH = 16;
export const MAX_BOT_TOKEN_LENGTH = 512;

export interface ChatDestination {
  channelId: string;
  label: string | null;
}

export interface ChatRoute {
  cellId: string;
  channelId: string;
}

/** Outbound budget-alert chat policy. The bot token is never returned by the API. */
export interface ChatSettings {
  enabled: boolean;
  botToken: string | null;
  destinations: ChatDestination[];
  defaultChannelId: string | null;
  routes: ChatRoute[];
}

/** A chat patch may omit any field; omitted fields keep their stored value. */
export type ChatPatch = Partial<ChatSettings>;
export type SlackSettings = ChatSettings;
export type DiscordSettings = ChatSettings;

export const DELIVERY_CHANNELS = ['webhook', 'email', 'slack', 'discord'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
/** The stored delivery format. Email rows store `email`, chat rows `chat`, webhooks keep theirs. */
export type DeliveryFormat = WebhookFormat | 'email' | 'chat';

export const DEFAULT_SMTP_PORT = 587;
export const MAX_EMAIL_RECIPIENTS = 10;
export const MAX_EMAIL_ADDRESS_LENGTH = 320;

/** Outbound budget-alert email policy. The password is never returned by the API. */
export interface EmailSettings {
  enabled: boolean;
  host: string | null;
  port: number;
  /** True uses implicit TLS (usually 465); false requires STARTTLS off loopback. */
  secure: boolean;
  username: string | null;
  password: string | null;
  from: string | null;
  to: string[];
}

/** An email patch may omit any field; omitted fields keep their stored value. */
export type EmailPatch = Partial<EmailSettings>;

export interface EmailView {
  enabled: boolean;
  host: string | null;
  port: number;
  secure: boolean;
  username: string | null;
  password: null;
  passwordSet: boolean;
  from: string | null;
  to: string[];
}

/** Which webhook/email channels receive one operational event kind. */
export interface EventChannelSettings {
  webhook: boolean;
  email: boolean;
}

export const EVENT_CHANNELS = ['webhook', 'email'] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** One optional cell allowlist entry for an event kind/channel pair. */
export interface EventRoute {
  kind: NotificationEventKind;
  channel: EventChannel;
  cellId: string;
}

export const DEFAULT_EVENT_COALESCE_MINUTES = 60;
export const MIN_EVENT_COALESCE_MINUTES = 1;
export const MAX_EVENT_COALESCE_MINUTES = 1440;
export const MAX_EVENT_ROUTES = 200;

export interface EventNotificationSettings {
  failedTurns: EventChannelSettings;
  masterErrors: EventChannelSettings;
  summaryFailures: EventChannelSettings;
  /** Fixed window length for coalescing one failure signature. */
  coalesceMinutes: number;
  /** Optional per-kind/channel cell allowlists; empty means every cell. */
  routes: EventRoute[];
}

export interface NotificationsSettings {
  webhook: WebhookSettings;
  email: EmailSettings;
  slack: ChatSettings;
  discord: ChatSettings;
  events: EventNotificationSettings;
}

/** The API view: secrets are always redacted and `*Set` reports their presence. */
export interface WebhookView {
  enabled: boolean;
  url: string | null;
  format: WebhookFormat;
  secret: null;
  secretSet: boolean;
}

export interface ChatView {
  enabled: boolean;
  botToken: null;
  botTokenSet: boolean;
  destinations: ChatDestination[];
  defaultChannelId: string | null;
  routes: ChatRoute[];
}

export interface NotificationsView {
  webhook: WebhookView;
  email: EmailView;
  slack: ChatView;
  discord: ChatView;
  events: EventNotificationSettings;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  enabled: false,
  botToken: null,
  destinations: [],
  defaultChannelId: null,
  routes: [],
};

export const DEFAULT_EVENT_NOTIFICATIONS: EventNotificationSettings = {
  failedTurns: { webhook: false, email: false },
  masterErrors: { webhook: false, email: false },
  summaryFailures: { webhook: false, email: false },
  coalesceMinutes: DEFAULT_EVENT_COALESCE_MINUTES,
  routes: [],
};

export const DEFAULT_NOTIFICATIONS: NotificationsSettings = {
  webhook: { enabled: false, url: null, format: 'json', secret: null },
  email: {
    enabled: false,
    host: null,
    port: DEFAULT_SMTP_PORT,
    secure: false,
    username: null,
    password: null,
    from: null,
    to: [],
  },
  slack: { ...DEFAULT_CHAT_SETTINGS, destinations: [], routes: [] },
  discord: { ...DEFAULT_CHAT_SETTINGS, destinations: [], routes: [] },
  events: {
    failedTurns: { ...DEFAULT_EVENT_NOTIFICATIONS.failedTurns },
    masterErrors: { ...DEFAULT_EVENT_NOTIFICATIONS.masterErrors },
    summaryFailures: { ...DEFAULT_EVENT_NOTIFICATIONS.summaryFailures },
    coalesceMinutes: DEFAULT_EVENT_NOTIFICATIONS.coalesceMinutes,
    routes: [],
  },
};

/** True when email has enough settings to attempt a send. */
export function emailDeliveryConfigured(email: EmailSettings): boolean {
  return email.host !== null && email.from !== null && email.to.length > 0;
}

/**
 * The cells explicitly allowed for one event kind/channel pair. `null` means the
 * pair has no routes and therefore follows the all-cells default.
 */
export function eventRouteCells(
  settings: EventNotificationSettings,
  kind: NotificationEventKind,
  channel: EventChannel,
): string[] | null {
  const routes = settings.routes.filter(
    (route) => route.kind === kind && route.channel === channel,
  );
  return routes.length === 0 ? null : routes.map((route) => route.cellId);
}

/** True when the kind/channel boolean and any cell allowlist permit this event. */
export function eventRouteAllows(
  settings: EventNotificationSettings,
  kind: NotificationEventKind,
  channel: EventChannel,
  cellId: string | null,
): boolean {
  const route =
    kind === 'turn.failed'
      ? settings.failedTurns
      : kind === 'master.error'
        ? settings.masterErrors
        : settings.summaryFailures;
  if (!route[channel]) return false;
  const cells = eventRouteCells(settings, kind, channel);
  return cells === null || (cellId !== null && cells.includes(cellId));
}

/** True when a chat provider has the token and route needed to attempt a send. */
export function chatDeliveryConfigured(settings: ChatSettings): boolean {
  const channels = new Set(
    settings.destinations.map((destination) => destination.channelId),
  );
  const hasDefault =
    settings.defaultChannelId !== null && channels.has(settings.defaultChannelId);
  const hasRoute = settings.routes.some((route) => channels.has(route.channelId));
  return settings.botToken !== null && channels.size > 0 && (hasDefault || hasRoute);
}

const SLACK_CHANNEL_RE = /^[A-Z0-9]{6,32}$/;
const DISCORD_CHANNEL_RE = /^\d{17,20}$/;

/** Validate a provider channel ID without resolving it against the provider. */
export function chatChannelIdError(provider: ChatProvider, value: string): string | null {
  if (value === '') return 'is required';
  if (/\s/.test(value)) return 'must not contain whitespace';
  if (provider === 'slack') {
    return SLACK_CHANNEL_RE.test(value)
      ? null
      : 'must be a Slack channel ID (uppercase letters and digits)';
  }
  return DISCORD_CHANNEL_RE.test(value)
    ? null
    : 'must be a Discord channel ID (numeric snowflake)';
}

/** Validate a pasted bot token without assuming a provider prefix. */
export function chatBotTokenError(value: string): string | null {
  if (value.length < MIN_BOT_TOKEN_LENGTH || value.length > MAX_BOT_TOKEN_LENGTH) {
    return `must be ${MIN_BOT_TOKEN_LENGTH} to ${MAX_BOT_TOKEN_LENGTH} characters`;
  }
  if (/\s/.test(value)) return 'must not contain whitespace';
  return null;
}

/** Stable outbox identity for one provider channel. */
export function chatDestinationId(provider: ChatProvider, channelId: string): string {
  return `${provider}:${channelId}`;
}

/**
 * Resolve one alert to the provider's default or cell route. Returns null when
 * the scope is unrouted or the route points at an unconfigured destination.
 */
export function resolveChatChannel(
  settings: ChatSettings,
  scope: BudgetScope,
  cellId: string | null,
): string | null {
  const configured = new Set(settings.destinations.map((destination) => destination.channelId));
  if (scope === 'cell' && cellId !== null) {
    const route = settings.routes.find((candidate) => candidate.cellId === cellId);
    if (route) return configured.has(route.channelId) ? route.channelId : null;
  }
  if (settings.defaultChannelId !== null && configured.has(settings.defaultChannelId)) {
    return settings.defaultChannelId;
  }
  return null;
}

export const DELIVERY_STATUSES = [
  'pending',
  'delivering',
  'delivered',
  'failed',
  'skipped',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** The alert fields copied into a delivery-history row. */
export interface DeliveryAlertSnapshot {
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  threshold: BudgetThreshold;
  alertAtPercent: number;
  budgetUsd: number;
  spendUsd: number;
  unknownCostTurns: number;
  periodStart: number;
  createdAt: number;
  acknowledgedAt: number | null;
}

export type DeliveryHistorySource = 'budget' | 'event';

interface DeliveryHistoryBase {
  id: string;
  source: DeliveryHistorySource;
  channel: DeliveryChannel;
  format: DeliveryFormat;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  canResend: boolean;
}

export interface BudgetDeliveryHistoryItem extends DeliveryHistoryBase {
  source: 'budget';
  alertId: string;
  alert: DeliveryAlertSnapshot;
}

export interface EventDeliveryHistoryItem extends DeliveryHistoryBase {
  source: 'event';
  event: EventDeliverySnapshot;
}

/** One safe delivery-history row: no destination, secret, recipient, or payload. */
export type DeliveryHistoryItem = BudgetDeliveryHistoryItem | EventDeliveryHistoryItem;

export interface DeliveryHistoryQuery {
  source?: DeliveryHistorySource;
  kind?: NotificationEventKind;
  channel?: DeliveryChannel;
  status?: DeliveryStatus;
  alertId?: string;
  /** Inclusive created-at lower bound in epoch milliseconds. */
  from?: number;
  /** Exclusive created-at upper bound in epoch milliseconds. */
  to?: number;
  limit?: number;
  offset?: number;
}

export interface DeliveryHistoryResponse {
  deliveries: DeliveryHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export type ResendBlockReason =
  | 'already_delivered'
  | 'alert_deleted'
  | 'alert_acknowledged'
  | 'not_current_period'
  | 'event_disabled'
  | 'channel_disabled'
  | 'channel_unconfigured';

export type ResendBlock = ResendBlockReason | 'in_flight';

export interface ResendGuardInput {
  status: DeliveryStatus;
  /** False when the alert row no longer exists; the delivery is history-only. */
  alertExists: boolean;
  acknowledgedAt: number | null;
  periodStart: number;
  currentPeriodStart: number;
  channelEnabled: boolean;
  channelConfigured: boolean;
}

/**
 * Decide whether a failed or skipped delivery may be resent. `null` means
 * resendable; `in_flight` is already scheduled and is an idempotent no-op.
 * Delivered rows are immutable so an alert can never be sent twice.
 */
export function resendBlockReason(input: ResendGuardInput): ResendBlock | null {
  if (input.status === 'delivered') return 'already_delivered';
  if (input.status === 'pending' || input.status === 'delivering') return 'in_flight';
  if (!input.alertExists) return 'alert_deleted';
  if (input.acknowledgedAt !== null) return 'alert_acknowledged';
  if (input.periodStart !== input.currentPeriodStart) return 'not_current_period';
  if (!input.channelEnabled) return 'channel_disabled';
  if (!input.channelConfigured) return 'channel_unconfigured';
  return null;
}

export interface EventResendGuardInput {
  status: DeliveryStatus;
  eventEnabled: boolean;
  channelEnabled: boolean;
  channelConfigured: boolean;
}

/**
 * Decide whether a failed or skipped operational-event delivery may be resent.
 * The event route is checked as well as the channel so a resend cannot bypass
 * an operator's per-kind opt-out.
 */
export function eventResendBlockReason(input: EventResendGuardInput): ResendBlock | null {
  if (input.status === 'delivered') return 'already_delivered';
  if (input.status === 'pending' || input.status === 'delivering') return 'in_flight';
  if (!input.eventEnabled) return 'event_disabled';
  if (!input.channelEnabled) return 'channel_disabled';
  if (!input.channelConfigured) return 'channel_unconfigured';
  return null;
}

const WEBHOOK_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SMTP_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+$/;

/** A local SMTP relay may stay plaintext, matching the webhook loopback exception. */
export function isLoopbackSmtpHost(host: string): boolean {
  return SMTP_LOOPBACK_HOSTS.has(host.trim().toLowerCase().replace(/^\[|\]$/g, ''));
}

/** Validate an SMTP hostname or IP literal without resolving it. */
export function smtpHostError(value: string): string | null {
  const host = value.trim();
  if (host === '') return 'is required';
  if (host.length > 253) return 'must be at most 253 characters';
  if (/\s/.test(host) || host.includes('/') || host.includes('@')) {
    return 'must be a hostname or IP address';
  }
  return null;
}

/**
 * Validate one email address. `from` also accepts `Display Name <addr@domain>`;
 * recipients use `emailRecipientsError`, which rejects display names.
 */
export function emailAddressError(value: string): string | null {
  const raw = value.trim();
  if (raw === '') return 'is required';
  if (raw.length > MAX_EMAIL_ADDRESS_LENGTH) {
    return `must be at most ${MAX_EMAIL_ADDRESS_LENGTH} characters`;
  }
  const angled = /^(.*)<([^<>]*)>\s*$/.exec(raw);
  if (angled) {
    const display = angled[1]?.trim() ?? '';
    const address = angled[2]?.trim() ?? '';
    if (display === '') return 'must include a display name before the address';
    if (display.length > 128) return 'must have a display name of at most 128 characters';
    if (!EMAIL_ADDRESS_RE.test(address)) return 'must contain a valid email address';
    return null;
  }
  if (!EMAIL_ADDRESS_RE.test(raw)) return 'must be a valid email address';
  return null;
}

/** Validate the recipient list: plain addresses, unique, at most ten. */
export function emailRecipientsError(to: string[]): string | null {
  if (to.length === 0) return 'at least one recipient is required';
  if (to.length > MAX_EMAIL_RECIPIENTS) {
    return `must have at most ${MAX_EMAIL_RECIPIENTS} recipients`;
  }
  const seen = new Set<string>();
  for (const raw of to) {
    const value = raw.trim();
    if (value.includes('<') || value.includes('>')) {
      return 'recipients must be plain email addresses';
    }
    const problem = emailAddressError(value);
    if (problem) return problem;
    const key = value.toLowerCase();
    if (seen.has(key)) return 'recipients must be unique';
    seen.add(key);
  }
  return null;
}

/**
 * Validate an operator-supplied webhook URL. https is required except for a
 * loopback collector, which is useful for local testing.
 */
export function webhookUrlError(value: string): string | null {
  if (value.length > 2048) return 'must be at most 2048 characters';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'must use http or https';
  }
  if (url.username !== '' || url.password !== '') {
    return 'must not contain credentials';
  }
  if (url.hash !== '') return 'must not contain a fragment';
  if (url.protocol === 'http:' && !WEBHOOK_LOOPBACK_HOSTS.has(url.hostname)) {
    return 'http is only allowed for localhost or loopback addresses';
  }
  return null;
}

const alertMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** Human-readable alert sentence shared by the banner and outbound delivery. */
export function budgetAlertText(alert: BudgetAlert): string {
  const label = alert.scope === 'overall' ? 'Overall spend' : alert.cellName ?? 'Cell spend';
  const spend =
    alert.unknownCostTurns > 0
      ? `at least ${alertMoney.format(alert.spendUsd)}`
      : alertMoney.format(alert.spendUsd);
  if (alert.threshold === 'exceeded') {
    return `${label} is over its ${alertMoney.format(alert.budgetUsd)} monthly budget (${spend}).`;
  }
  return `${label} reached ${alert.alertAtPercent.toFixed(0)}% of its ${alertMoney.format(alert.budgetUsd)} monthly budget (${spend}).`;
}

const alertMonth = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const CHAT_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** A browser-usable Usage link, omitted for the default loopback brain URL. */
export function chatUsageUrl(brainUrl: string | null | undefined): string | null {
  if (brainUrl === null || brainUrl === undefined || brainUrl.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(brainUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (CHAT_LOOPBACK_HOSTS.has(host)) return null;
  return new URL('?page=usage', url).toString();
}

/** Keep provider message bodies under their documented hard limits. */
export function truncateChatText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export interface BudgetChatTextOptions {
  event?: BudgetAlertEvent['event'];
  brainUrl?: string | null;
}

/** Multi-line chat body shared by Slack and Discord. */
export function budgetChatText(
  alert: BudgetAlert,
  options: BudgetChatTextOptions = {},
): string {
  const lines = [
    budgetAlertText(alert).replace(/[<>]/g, ''),
    '',
    `Threshold: ${alert.threshold} (${alert.alertAtPercent.toFixed(0)}%)`,
    `Period: ${alertMonth.format(new Date(alert.periodStart))} (UTC)`,
    `Unpriced turns: ${alert.unknownCostTurns}`,
    `Alert: ${alert.id}`,
  ];
  const usage = chatUsageUrl(options.brainUrl);
  if (usage !== null) lines.push(`Usage: ${usage}`);
  if (options.event === 'budget.test') {
    lines.unshift('Test budget alert from Agent Process Segments.', '');
  }
  return lines.join('\n');
}

export interface BudgetAlertEvent {
  version: 1;
  event: 'budget.alert' | 'budget.test';
  alert: {
    id: string;
    scope: BudgetScope;
    cellId: string | null;
    cellName: string | null;
    threshold: BudgetThreshold;
    alertAtPercent: number;
    budgetUsd: number;
    spendUsd: number;
    spendIsLowerBound: boolean;
    unknownCostTurns: number;
    periodStart: number;
    periodEnd: number;
    createdAt: number;
  };
  text: string;
}

/** Build the stable JSON event sent to a webhook. */
export function budgetAlertEvent(
  alert: BudgetAlert,
  event: BudgetAlertEvent['event'] = 'budget.alert',
): BudgetAlertEvent {
  return {
    version: 1,
    event,
    alert: {
      id: alert.id,
      scope: alert.scope,
      cellId: alert.cellId,
      cellName: alert.cellName,
      threshold: alert.threshold,
      alertAtPercent: alert.alertAtPercent,
      budgetUsd: alert.budgetUsd,
      spendUsd: alert.spendUsd,
      spendIsLowerBound: alert.unknownCostTurns > 0,
      unknownCostTurns: alert.unknownCostTurns,
      periodStart: alert.periodStart,
      periodEnd: budgetPeriod(alert.periodStart).end,
      createdAt: alert.createdAt,
    },
    text: budgetAlertText(alert),
  };
}

/** Subject line shared by the email channel and its test message. */
export function budgetAlertSubject(
  alert: BudgetAlert,
  event: BudgetAlertEvent['event'] = 'budget.alert',
): string {
  if (event === 'budget.test') return '[APS] Test budget alert';
  const label = alert.scope === 'overall' ? 'Overall' : alert.cellName ?? 'Cell';
  if (alert.threshold === 'exceeded') {
    return `[APS] ${label} over budget (${alertMoney.format(alert.budgetUsd)})`;
  }
  return `[APS] ${label} budget warning (${alert.alertAtPercent.toFixed(0)}%)`;
}

/** Plain-text email body: the alert sentence, its UTC period, and the alert id. */
export function budgetEmailText(
  alert: BudgetAlert,
  event: BudgetAlertEvent['event'] = 'budget.alert',
): string {
  const period = budgetPeriod(alert.periodStart);
  const lines = [
    budgetAlertText(alert),
    '',
    `Period: ${new Date(period.start).toISOString()} to ${new Date(period.end).toISOString()} (UTC)`,
    `Alert: ${alert.id}`,
  ];
  if (event === 'budget.test') {
    lines.unshift('This is a test budget alert from Agent Process Segments.', '');
  }
  return lines.join('\n');
}

export interface BudgetPeriod {
  start: number;
  end: number;
}

/** UTC calendar month containing `now`. */
export function budgetPeriod(now: number): BudgetPeriod {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start, end };
}

export interface BudgetStatusInput {
  scope: BudgetScope;
  cellId: string | null;
  cellName: string | null;
  budgetUsd: number;
  alertAtPercent: number;
  period: BudgetPeriod;
  totals: BudgetUsageTotals;
  pauseOnExceeded?: boolean;
  pauseOnUnknownCost?: boolean;
}

export function budgetStatus(input: BudgetStatusInput): BudgetStatus {
  const {
    scope,
    cellId,
    cellName,
    budgetUsd,
    alertAtPercent,
    period,
    totals,
    pauseOnExceeded = false,
    pauseOnUnknownCost = false,
  } = input;
  const pricedTurns = Math.max(0, totals.turns - totals.unknownCostTurns);
  const spendUsd = totals.costUsd ?? 0;
  const spendIsLowerBound = totals.unknownCostTurns > 0;
  const percentUsed = budgetUsd > 0 ? (spendUsd / budgetUsd) * 100 : 0;
  const capSpendUsd = spendUsd + (totals.estimatedCostUsd ?? 0);
  const capSpendIsLowerBound = totals.unpricedTurns > 0;
  const pauseReason: SpendPauseReason | null = !pauseOnExceeded
    ? null
    : capSpendUsd >= budgetUsd
      ? 'cap_reached'
      : pauseOnUnknownCost && totals.unpricedTurns > 0
        ? 'unknown_cost'
        : null;
  const paused = pauseReason !== null;

  let state: BudgetState;
  if (totals.turns > 0 && pricedTurns === 0) {
    state = 'unknown';
  } else if (spendUsd >= budgetUsd) {
    state = 'exceeded';
  } else if (
    alertAtPercent < 100 &&
    spendUsd >= (budgetUsd * alertAtPercent) / 100
  ) {
    state = 'warning';
  } else {
    state = 'ok';
  }

  return {
    scope,
    cellId,
    cellName,
    label: scope === 'overall' ? 'Overall' : cellName ?? 'Cell',
    periodStart: period.start,
    periodEnd: period.end,
    budgetUsd,
    spendUsd,
    remainingUsd: Math.max(0, budgetUsd - spendUsd),
    percentUsed,
    pricedTurns,
    unknownCostTurns: totals.unknownCostTurns,
    spendIsLowerBound,
    state,
    pauseOnExceeded,
    pauseOnUnknownCost,
    capSpendUsd,
    capSpendIsLowerBound,
    unpricedTurns: totals.unpricedTurns,
    paused,
    pauseReason,
    overrideId: null,
    overrideExpiresAt: null,
  };
}

/** Convert a paused status into the admission payload. */
export function spendPause(status: BudgetStatus): SpendPause {
  return {
    scope: status.scope,
    cellId: status.cellId,
    cellName: status.cellName,
    label: status.label,
    reason: status.pauseReason ?? 'cap_reached',
    periodStart: status.periodStart,
    periodEnd: status.periodEnd,
    budgetUsd: status.budgetUsd,
    spendUsd: status.capSpendUsd,
    spendIsLowerBound: status.capSpendIsLowerBound,
    unpricedTurns: status.unpricedTurns,
    percentUsed: status.capSpendUsd > 0 ? (status.capSpendUsd / status.budgetUsd) * 100 : 0,
  };
}

/** The highest alert threshold crossed by a status, or null. */
export function budgetAlertThreshold(status: BudgetStatus): BudgetThreshold | null {
  if (status.state === 'exceeded') return 'exceeded';
  if (status.state === 'warning') return 'warning';
  return null;
}
