import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { CellRepository } from '../cells/repository.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';
import {
  DELIVERY_CHANNELS,
  budgetAlertEvent,
  budgetAlertSubject,
  budgetEmailText,
  budgetPeriod,
  CHAT_PROVIDERS,
  chatDeliveryConfigured,
  chatDestinationId,
  emailDeliveryConfigured,
  resendBlockReason,
  type BudgetAlert,
  type BudgetAlertEvent,
  type ChatProvider,
  type ChatSettings,
  type DeliveryChannel,
  type DeliveryFormat,
  type DeliveryHistoryItem,
  type DeliveryHistoryQuery,
  type DeliveryHistoryResponse,
  type DeliveryStatus,
  type EmailSettings,
  type EventChannelSettings,
  type ResendBlockReason,
  type WebhookFormat,
  type WebhookSettings,
} from '../domain/budget.js';
import {
  EVENT_NOTIFICATION_KINDS,
  type MasterErrorNotification,
  type NotificationEventEnvelope,
  type NotificationEventKind,
  type TurnFailureNotification,
  masterErrorEnvelope,
  notificationEventEmailText,
  notificationEventSubject,
  turnFailedEnvelope,
} from '../domain/notifications.js';
import type { BudgetAlertRecord } from '../usage/budget-alerts.js';
import type { BudgetAlertRepository } from '../usage/budget-alerts.js';
import type {
  BudgetAlertDeliveryRepository,
  DeliveryAlertRecord,
  DeliveryHistoryFilter,
  DeliveryRecord,
} from '../usage/budget-deliveries.js';
import {
  createEmailSender,
  emailDestinationHash,
  emailErrorReason,
  type EmailMessage,
  type EmailSendLike,
} from '../usage/budget-email.js';
import {
  chatDestinationHash,
  chatRequest,
  chatText,
  classifyChatResponse,
  readChatBody,
  resolveChatTarget,
  type ChatDecision,
  type ChatTarget,
} from '../usage/budget-chat.js';
import type {
  EventDeliveryRecord,
  NotificationEventDeliveryRepository,
} from './event-deliveries.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_NOTIFY_INTERVAL_MS = 60_000;
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;
export const DEFAULT_NOTIFY_MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const PRUNE_AGE_MS = 400 * 24 * 60 * 60_000;
const DEFAULT_BATCH_SIZE = 20;

export interface NotificationServiceDeps {
  deliveries: BudgetAlertDeliveryRepository;
  events: NotificationEventDeliveryRepository;
  alerts: BudgetAlertRepository;
  cells: Pick<CellRepository, 'list'>;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  errors?: ErrorSink;
  send?: FetchLike;
  sendEmail?: EmailSendLike;
  brainUrl?: string | null;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  batchSize?: number;
}

export interface WebhookStatus {
  enabled: boolean;
  configured: boolean;
  format: WebhookFormat;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

export interface EmailStatus {
  enabled: boolean;
  configured: boolean;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

export interface ChatDestinationStatus {
  channelId: string;
  label: string | null;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

export interface ChatStatus {
  enabled: boolean;
  configured: boolean;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
  destinations: ChatDestinationStatus[];
}

export interface EventKindStatus {
  pending: number;
  failed: number;
}

export interface EventNotificationStatus {
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
  byKind: Record<NotificationEventKind, EventKindStatus>;
}

export interface NotificationStatusResponse {
  webhook: WebhookStatus;
  email: EmailStatus;
  slack: ChatStatus;
  discord: ChatStatus;
  events: EventNotificationStatus;
}

export interface WebhookTestResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
}

export type EmailTestResult = WebhookTestResult;

export type ResendDeliveryResult =
  | { ok: true; delivery: DeliveryHistoryItem }
  | { ok: false; reason: 'not_found' | ResendBlockReason | 'internal' };

/** The current route for one channel, including the identity rows are enqueued under. */
interface ChannelRoute {
  enabled: boolean;
  configured: boolean;
  format: DeliveryFormat;
  hash: string;
}

/** The identity a delivery was enqueued for. Never returned or logged. */
export function destinationHash(webhook: WebhookSettings): string {
  return createHash('sha256')
    .update(`${webhook.url ?? ''}\n${webhook.format}\n${webhook.secret ?? ''}`)
    .digest('hex');
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Stable Message-ID so a retried alert is recognizable to mail clients. */
function messageIdFor(alertId: string): string {
  return `<budget-${alertId.replace(/[^A-Za-z0-9._-]/g, '')}@aps.local>`;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function headerValue(response: Response, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

function retryAfterMs(response: Response, now: number): number | null {
  const raw = headerValue(response, 'retry-after');
  if (raw === null || raw.trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  }
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
}

/** A short, safe failure reason. Never include the URL, headers, or body. */
export function deliveryErrorReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string' && cause.code !== '') return cause.code;
    return error.name === 'Error' ? 'network error' : error.name;
  }
  return 'network error';
}

const HOUR_MS = 60 * 60_000;

function safeKeyPart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 60);
}

function hourBucket(occurredAt: number): number {
  return Math.floor(occurredAt / HOUR_MS);
}

/** Stable per-channel idempotency key for one event signature in a UTC hour. */
export function eventDedupeKey(
  event: TurnFailureNotification | MasterErrorNotification,
  kind: NotificationEventKind,
): string {
  return kind === 'turn.failed'
    ? `turn:${(event as TurnFailureNotification).requestId}:${(event as TurnFailureNotification).source}:${safeKeyPart((event as TurnFailureNotification).reason)}:${hourBucket(event.occurredAt)}`
    : `master:${(event as MasterErrorNotification).cellId}:${(event as MasterErrorNotification).source}:${safeKeyPart((event as MasterErrorNotification).segment ?? '')}:${hourBucket(event.occurredAt)}`;
}

function eventChannelEnabled(
  route: EventChannelSettings | undefined,
  channel: DeliveryChannel,
): boolean {
  return route?.[channel as 'webhook' | 'email'] === true;
}

function eventBody(format: DeliveryFormat, envelope: NotificationEventEnvelope): string {
  if (format === 'slack') return JSON.stringify({ text: envelope.text });
  if (format === 'discord') return JSON.stringify({ content: envelope.text });
  return JSON.stringify(envelope);
}

function formatBody(webhook: WebhookSettings, event: BudgetAlertEvent): string {
  if (webhook.format === 'slack') return JSON.stringify({ text: event.text });
  if (webhook.format === 'discord') return JSON.stringify({ content: event.text });
  return JSON.stringify(event);
}

function headersFor(
  body: string,
  webhook: WebhookSettings,
  idempotencyKey: string,
  timestamp: number,
  userAgent = 'aps-budget-alert/1',
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': userAgent,
    'idempotency-key': idempotencyKey,
    'x-aps-timestamp': String(timestamp),
  };
  if (webhook.secret !== null) {
    const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
    headers['x-aps-signature'] = `sha256=${signature}`;
  }
  return headers;
}

/**
 * Delivers durable budget alerts to the configured webhook, email, Slack, and
 * Discord destinations. Delivery is advisory: every failure is recorded,
 * retried within a bounded schedule, and reported to the error sink without
 * throwing into the caller.
 */
export class NotificationService {
  private readonly deliveries: BudgetAlertDeliveryRepository;
  private readonly events: NotificationEventDeliveryRepository;
  private readonly alerts: BudgetAlertRepository;
  private readonly cells: Pick<CellRepository, 'list'>;
  private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>;
  private readonly errors?: ErrorSink;
  private readonly send: FetchLike;
  private readonly sendEmail: EmailSendLike;
  private readonly brainUrl: string | null;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private readonly controllers = new Set<AbortController>();

  constructor(options: NotificationServiceDeps) {
    this.deliveries = options.deliveries;
    this.events = options.events;
    this.alerts = options.alerts;
    this.cells = options.cells;
    this.settings = options.settings;
    this.errors = options.errors;
    this.send = options.send ?? fetch;
    this.clock = options.now ?? (() => Date.now());
    this.intervalMs =
      options.intervalMs && options.intervalMs > 0
        ? options.intervalMs
        : DEFAULT_NOTIFY_INTERVAL_MS;
    this.timeoutMs =
      options.timeoutMs && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_NOTIFY_TIMEOUT_MS;
    this.maxAttempts =
      options.maxAttempts && options.maxAttempts > 0
        ? options.maxAttempts
        : DEFAULT_NOTIFY_MAX_ATTEMPTS;
    this.batchSize =
      options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
    this.sendEmail =
      options.sendEmail ?? createEmailSender({ timeoutMs: this.timeoutMs });
    this.brainUrl = options.brainUrl ?? null;
  }

  start(): void {
    if (this.timer) return;
    const now = this.clock();
    this.deliveries.resetStale(now);
    this.deliveries.pruneBefore(now - PRUNE_AGE_MS);
    this.events.resetStale(now);
    this.events.pruneBefore(now - PRUNE_AGE_MS);
    this.unsubscribe = this.settings.onChange(() => this.kick());
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref?.();
    this.kick();
  }

  stop(): void {
    this.generation += 1;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  /** Enqueue current unacknowledged alerts, then try to flush. Never throws. */
  observe(alerts: BudgetAlert[]): void {
    try {
      const notifications = this.settings.get().notifications;
      const now = this.clock();
      for (const channel of DELIVERY_CHANNELS) {
        if (channel === 'slack' || channel === 'discord') continue;
        const route = this.channelRoute(channel);
        if (!route.enabled || !route.configured) continue;
        for (const alert of alerts) {
          if (alert.acknowledgedAt !== null) continue;
          this.deliveries.enqueue({
            alertId: alert.id,
            channel,
            format: route.format,
            destinationHash: route.hash,
            now,
          });
        }
      }

      for (const provider of CHAT_PROVIDERS) {
        const chat = notifications[provider];
        if (!chat.enabled || !chatDeliveryConfigured(chat)) continue;
        for (const alert of alerts) {
          if (alert.acknowledgedAt !== null) continue;
          const target = resolveChatTarget(provider, chat, alert);
          if (!target) continue;
          this.deliveries.enqueue({
            alertId: alert.id,
            channel: provider,
            destinationId: target.destinationId,
            format: 'chat',
            destinationHash: target.destinationHash,
            now,
          });
        }
      }
      this.kick();
    } catch (error) {
      this.errors?.error('budget.notify', error, { phase: 'enqueue' });
    }
  }

  /** Enqueue one failed request turn for the event's routed channels. Never throws. */
  observeTurnFailure(event: TurnFailureNotification): void {
    this.observeEvent(
      'turn.failed',
      event,
      this.settings.get().notifications.events.failedTurns,
    );
  }

  /** Enqueue one master error for the event's routed channels. Never throws. */
  observeMasterError(event: MasterErrorNotification): void {
    this.observeEvent(
      'master.error',
      event,
      this.settings.get().notifications.events.masterErrors,
    );
  }

  private observeEvent(
    kind: NotificationEventKind,
    event: TurnFailureNotification | MasterErrorNotification,
    route: EventChannelSettings,
  ): void {
    try {
      const now = this.clock();
      const payloadJson = JSON.stringify(event);
      const dedupeKey = eventDedupeKey(event, kind);
      for (const channel of DELIVERY_CHANNELS) {
        if (!eventChannelEnabled(route, channel)) continue;
        const channelRoute = this.channelRoute(channel);
        if (!channelRoute.enabled || !channelRoute.configured) continue;
        this.events.enqueue({
          dedupeKey,
          kind,
          channel,
          format: channelRoute.format,
          destinationHash: channelRoute.hash,
          payloadJson,
          now,
        });
      }
      this.kick();
    } catch (error) {
      this.errors?.error('notifications.event', error, { kind, phase: 'enqueue' });
    }
  }

  private channelRoute(
    channel: DeliveryChannel,
    scope?: Pick<BudgetAlert, 'scope' | 'cellId'>,
    destinationId?: string,
  ): ChannelRoute {
    const { webhook, email, slack, discord } = this.settings.get().notifications;
    if (channel === 'webhook') {
      return {
        enabled: webhook.enabled,
        configured: webhook.url !== null,
        format: webhook.format,
        hash: destinationHash(webhook),
      };
    }
    if (channel === 'email') {
      return {
        enabled: email.enabled,
        configured: emailDeliveryConfigured(email),
        format: 'email',
        hash: emailDestinationHash(email),
      };
    }
    const chat = channel === 'slack' ? slack : discord;
    const target = scope ? resolveChatTarget(channel, chat, scope) : null;
    return {
      enabled: chat.enabled,
      configured:
        chatDeliveryConfigured(chat) &&
        target !== null &&
        (destinationId === undefined || target.destinationId === destinationId),
      format: 'chat',
      hash: target?.destinationHash ?? '',
    };
  }

  /** Drain due deliveries. Concurrent callers share the in-flight drain. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.drain();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    return run;
  }

  private async drain(): Promise<void> {
    const generation = this.generation;
    // Keep the existing budget/chat path first so a flush still reaches its
    // sender synchronously; each drain has its own catch.
    await this.drainBudgetAndChat(generation);
    await this.drainEvents(generation);
  }

  private async drainBudgetAndChat(generation: number): Promise<void> {
    try {
      const { webhook, email } = this.settings.get().notifications;
      const now = this.clock();
      const periodStart = budgetPeriod(now).start;
      this.deliveries.skipAcknowledged(now);
      this.deliveries.skipBeforePeriod(periodStart, now);
      this.deliveries.skipOrphaned(now);

      if (!webhook.enabled || webhook.url === null) {
        this.deliveries.skipPending('webhook', now);
      } else {
        await this.drainWebhook(webhook, periodStart, generation);
      }

      if (!email.enabled || !emailDeliveryConfigured(email)) {
        this.deliveries.skipPending('email', now);
      } else {
        await this.drainEmail(email, periodStart, generation);
      }

      for (const provider of CHAT_PROVIDERS) {
        await this.drainChat(provider, periodStart, generation);
      }
    } catch (error) {
      this.errors?.error('budget.notify', error, { phase: 'flush' });
    }
  }

  private async drainWebhook(
    webhook: WebhookSettings,
    periodStart: number,
    generation: number,
  ): Promise<void> {
    const now = this.clock();
    const hash = destinationHash(webhook);
    this.deliveries.skipStaleDestination('webhook', hash, now);
    const due = this.deliveries.listDue(
      'webhook',
      hash,
      periodStart,
      now,
      this.batchSize,
    );
    for (const delivery of due) {
      if (generation !== this.generation) return;
      await this.deliverWebhook(delivery, webhook, periodStart, generation);
    }
  }

  private async drainEmail(
    email: EmailSettings,
    periodStart: number,
    generation: number,
  ): Promise<void> {
    const now = this.clock();
    const hash = emailDestinationHash(email);
    this.deliveries.skipStaleDestination('email', hash, now);
    const due = this.deliveries.listDue('email', hash, periodStart, now, this.batchSize);
    for (const delivery of due) {
      if (generation !== this.generation) return;
      await this.deliverEmail(delivery, email, periodStart, generation);
    }
  }

  private async drainChat(
    provider: ChatProvider,
    periodStart: number,
    generation: number,
  ): Promise<void> {
    const settings = this.settings.get().notifications[provider];
    const now = this.clock();
    if (!settings.enabled || !chatDeliveryConfigured(settings)) {
      this.deliveries.skipPending(provider, now);
      return;
    }

    const destinations = settings.destinations.map((destination) => ({
      id: chatDestinationId(provider, destination.channelId),
      hash: chatDestinationHash(provider, settings, destination.channelId),
    }));
    this.deliveries.skipDestinationsNotIn(
      provider,
      destinations.map((destination) => destination.id),
      now,
    );
    for (const destination of destinations) {
      this.deliveries.skipStaleDestinationFor(
        provider,
        destination.id,
        destination.hash,
        now,
      );
    }

    const due = this.deliveries.listDueForChannel(
      provider,
      periodStart,
      now,
      this.batchSize,
    );
    for (const delivery of due) {
      if (generation !== this.generation) return;
      const record = this.alerts.get(delivery.alertId);
      if (
        !record ||
        record.acknowledgedAt !== null ||
        record.periodStart !== periodStart
      ) {
        this.deliveries.markSkipped(delivery.id, this.clock());
        continue;
      }
      const alert = this.toAlert(record);
      const target = resolveChatTarget(provider, settings, alert);
      if (
        !target ||
        target.destinationId !== delivery.destinationId ||
        target.destinationHash !== delivery.destinationHash
      ) {
        this.deliveries.markSkipped(delivery.id, this.clock());
        continue;
      }
      const marked = this.deliveries.markDelivering(delivery.id, this.clock());
      if (!marked) continue;
      await this.deliverChat(marked, provider, settings, target, alert, generation);
    }
  }

  private async deliverChat(
    delivery: DeliveryRecord,
    provider: ChatProvider,
    settings: ChatSettings,
    target: ChatTarget,
    alert: BudgetAlert,
    generation: number,
  ): Promise<void> {
    if (settings.botToken === null) {
      this.deliveries.markSkipped(delivery.id, this.clock());
      return;
    }
    const text = chatText(alert, provider, { brainUrl: this.brainUrl });
    const request = chatRequest(provider, settings.botToken, target.channelId, text);
    const decision = await this.sendChatOnce(
      provider,
      request.url,
      request.headers,
      request.body,
    );
    if (generation !== this.generation) return;
    if (decision.ok) {
      this.deliveries.markDelivered(delivery.id, this.clock());
      return;
    }
    this.handleFailure(
      delivery,
      decision.reason ?? `HTTP ${decision.status ?? 'unknown'}`,
      {
        retryable: decision.retryable === true,
        retryAfterMs: decision.retryAfterMs ?? null,
      },
    );
  }

  private async drainEvents(generation: number): Promise<void> {
    try {
      const { webhook, email, events } = this.settings.get().notifications;
      const now = this.clock();

      for (const kind of EVENT_NOTIFICATION_KINDS) {
        const route = kind === 'turn.failed' ? events.failedTurns : events.masterErrors;
        for (const channel of DELIVERY_CHANNELS) {
          if (!eventChannelEnabled(route, channel)) {
            this.events.skipKindChannel(kind, channel, now);
          }
        }
      }

      if (!webhook.enabled || webhook.url === null) {
        this.events.skipPending('webhook', now);
      } else {
        await this.drainEventChannel(
          'webhook',
          destinationHash(webhook),
          now,
          generation,
        );
      }

      if (!email.enabled || !emailDeliveryConfigured(email)) {
        this.events.skipPending('email', now);
      } else {
        await this.drainEventChannel(
          'email',
          emailDestinationHash(email),
          now,
          generation,
        );
      }
    } catch (error) {
      this.errors?.error('notifications.event', error, { phase: 'flush' });
    }
  }

  private async drainEventChannel(
    channel: DeliveryChannel,
    destinationHashValue: string,
    now: number,
    generation: number,
  ): Promise<void> {
    this.events.skipStaleDestination(channel, destinationHashValue, now);
    const due = this.events.listDue(channel, destinationHashValue, now, this.batchSize);
    for (const delivery of due) {
      if (generation !== this.generation) return;
      await this.deliverEvent(delivery, generation);
    }
  }

  private eventCellName(delivery: EventDeliveryRecord, payload: unknown): string | null {
    if (delivery.kind === 'master.error') {
      const event = payload as MasterErrorNotification;
      const cellId = typeof event.cellId === 'string' ? event.cellId : null;
      if (cellId === null) return null;
      return this.cells.list().find((cell) => cell.id === cellId)?.name ?? 'Deleted cell';
    }
    const event = payload as TurnFailureNotification;
    if (event.cellId === null) return null;
    return this.cells.list().find((cell) => cell.id === event.cellId)?.name ?? 'Deleted cell';
  }

  private eventEnvelope(
    delivery: EventDeliveryRecord,
    payload: unknown,
    cellName: string | null,
  ): NotificationEventEnvelope {
    return delivery.kind === 'turn.failed'
      ? turnFailedEnvelope(payload as TurnFailureNotification, cellName)
      : masterErrorEnvelope(payload as MasterErrorNotification, cellName);
  }

  private async deliverEvent(
    delivery: EventDeliveryRecord,
    generation: number,
  ): Promise<void> {
    const marked = this.events.markDelivering(delivery.id, this.clock());
    if (!marked) return;

    let payload: unknown;
    let cellName: string | null = null;
    let envelope: NotificationEventEnvelope;
    try {
      payload = JSON.parse(marked.payloadJson) as unknown;
      cellName = this.eventCellName(marked, payload);
      envelope = this.eventEnvelope(marked, payload, cellName);
    } catch {
      if (generation !== this.generation) return;
      this.events.markFailed(marked.id, this.clock(), 'invalid payload');
      this.reportEvent(marked, marked.attempts, 'invalid payload');
      return;
    }

    const { webhook, email } = this.settings.get().notifications;
    if (marked.channel === 'webhook') {
      if (!webhook.enabled || webhook.url === null) {
        this.events.markSkipped(marked.id, this.clock());
        return;
      }
      const body = eventBody(marked.format, envelope);
      let response: Response;
      try {
        response = await this.sendOnce(
          webhook,
          body,
          marked.dedupeKey,
          this.clock(),
          'aps-notify/1',
        );
      } catch (error) {
        if (generation !== this.generation) return;
        this.handleEventFailure(marked, deliveryErrorReason(error), {
          retryable: true,
          retryAfterMs: null,
        });
        return;
      }
      if (generation !== this.generation) return;
      if (isSuccess(response.status)) {
        this.events.markDelivered(marked.id, this.clock());
        return;
      }
      this.handleEventFailure(marked, `HTTP ${response.status}`, {
        retryable: isRetryable(response.status),
        retryAfterMs: retryAfterMs(response, this.clock()),
      });
      return;
    }

    if (marked.channel !== 'email') {
      this.events.markSkipped(marked.id, this.clock());
      return;
    }
    if (!email.enabled || !emailDeliveryConfigured(email)) {
      this.events.markSkipped(marked.id, this.clock());
      return;
    }
    const message: EmailMessage = {
      from: email.from ?? '',
      to: email.to,
      subject: notificationEventSubject(envelope, cellName),
      text: notificationEventEmailText(envelope, cellName),
      messageId: `<event-${marked.id}@aps.local>`,
      deliveryId: marked.id,
      eventKind: marked.kind,
      eventId: marked.dedupeKey,
    };
    try {
      await this.sendEmailOnce(email, message);
    } catch (error) {
      if (generation !== this.generation) return;
      const classified = emailErrorReason(error);
      this.handleEventFailure(marked, classified.reason, {
        retryable: !classified.permanent,
        retryAfterMs: null,
      });
      return;
    }
    if (generation !== this.generation) return;
    this.events.markDelivered(marked.id, this.clock());
  }

  private handleEventFailure(
    delivery: EventDeliveryRecord,
    reason: string,
    options: { retryable: boolean; retryAfterMs: number | null },
  ): void {
    const now = this.clock();
    const attempt = delivery.attempts;
    const delay = this.retryDelay(attempt, options);
    if (delay === null) {
      this.events.markFailed(delivery.id, now, reason);
      this.reportEvent(delivery, attempt, reason);
      return;
    }
    this.events.markRetry(delivery.id, now, now + delay, reason);
    this.reportEvent(delivery, attempt, reason);
  }

  private retryDelay(
    attempt: number,
    options: { retryable: boolean; retryAfterMs: number | null },
  ): number | null {
    if (!options.retryable || attempt >= this.maxAttempts) return null;
    return (
      options.retryAfterMs ??
      RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ??
      0
    );
  }

  private reportEvent(
    delivery: EventDeliveryRecord,
    attempt: number,
    reason: string,
  ): void {
    let ids: Record<string, unknown> = { dedupeKey: delivery.dedupeKey };
    try {
      const payload = JSON.parse(delivery.payloadJson) as Record<string, unknown>;
      if (delivery.kind === 'turn.failed') {
        ids = {
          dedupeKey: delivery.dedupeKey,
          turnId: payload['turnId'],
          requestId: payload['requestId'],
          cellId: payload['cellId'],
        };
      } else {
        ids = {
          dedupeKey: delivery.dedupeKey,
          cellId: payload['cellId'],
          requestId: payload['requestId'],
          source: payload['source'],
        };
      }
    } catch {
      // Keep the dedupe key; the row is already marked failed.
    }
    this.errors?.error('notifications.event', new Error(reason), {
      ...ids,
      kind: delivery.kind,
      deliveryId: delivery.id,
      channel: delivery.channel,
      attempt,
      reason,
    });
  }

  status(): NotificationStatusResponse {
    const { webhook, email } = this.settings.get().notifications;
    const webhookSummary = this.deliveries.status('webhook');
    const emailSummary = this.deliveries.status('email');
    const eventSummary = this.events.status();
    const failedTurns = this.events.status('turn.failed');
    const masterErrors = this.events.status('master.error');
    return {
      webhook: {
        enabled: webhook.enabled,
        configured: webhook.url !== null,
        format: webhook.format,
        pending: webhookSummary.pending,
        failed: webhookSummary.failed,
        lastDeliveryAt: webhookSummary.lastDeliveryAt,
        lastDeliveryStatus: webhookSummary.lastDeliveryStatus,
        lastError: webhookSummary.lastError,
      },
      email: {
        enabled: email.enabled,
        configured: emailDeliveryConfigured(email),
        pending: emailSummary.pending,
        failed: emailSummary.failed,
        lastDeliveryAt: emailSummary.lastDeliveryAt,
        lastDeliveryStatus: emailSummary.lastDeliveryStatus,
        lastError: emailSummary.lastError,
      },
      slack: this.chatStatus('slack'),
      discord: this.chatStatus('discord'),
      events: {
        pending: eventSummary.pending,
        failed: eventSummary.failed,
        lastDeliveryAt: eventSummary.lastDeliveryAt,
        lastDeliveryStatus: eventSummary.lastDeliveryStatus,
        lastError: eventSummary.lastError,
        byKind: {
          'turn.failed': {
            pending: failedTurns.pending,
            failed: failedTurns.failed,
          },
          'master.error': {
            pending: masterErrors.pending,
            failed: masterErrors.failed,
          },
        },
      },
    };
  }

  private chatStatus(provider: ChatProvider): ChatStatus {
    const settings = this.settings.get().notifications[provider];
    const summary = this.deliveries.status(provider);
    return {
      enabled: settings.enabled,
      configured: chatDeliveryConfigured(settings),
      pending: summary.pending,
      failed: summary.failed,
      lastDeliveryAt: summary.lastDeliveryAt,
      lastDeliveryStatus: summary.lastDeliveryStatus,
      lastError: summary.lastError,
      destinations: settings.destinations.map((destination) => {
        const destinationSummary = this.deliveries.status(
          provider,
          chatDestinationId(provider, destination.channelId),
        );
        return {
          channelId: destination.channelId,
          label: destination.label,
          pending: destinationSummary.pending,
          failed: destinationSummary.failed,
          lastDeliveryAt: destinationSummary.lastDeliveryAt,
          lastDeliveryStatus: destinationSummary.lastDeliveryStatus,
          lastError: destinationSummary.lastError,
        };
      }),
    };
  }

  /** Read-only audit across both channels. Never mutates or flushes. */
  history(query: DeliveryHistoryQuery): DeliveryHistoryResponse {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    const filter: DeliveryHistoryFilter = { limit, offset };
    if (query.channel !== undefined) filter.channel = query.channel;
    if (query.status !== undefined) filter.status = query.status;
    if (query.alertId !== undefined) filter.alertId = query.alertId;
    if (query.from !== undefined) filter.from = query.from;
    if (query.to !== undefined) filter.to = query.to;

    const currentPeriodStart = budgetPeriod(this.clock()).start;
    const names = new Map(this.cells.list().map((cell) => [cell.id, cell.name]));
    const deliveries = this.deliveries
      .listFiltered(filter)
      .map(({ delivery, alert }) => {
        const cellName =
          alert.scope === 'cell' ? names.get(alert.scopeId) ?? 'Deleted cell' : null;
        const alertExists = this.alerts.get(delivery.alertId) !== null;
        return this.toHistoryItem(
          delivery,
          alert,
          cellName,
          currentPeriodStart,
          alertExists,
        );
      });

    return {
      deliveries,
      total: this.deliveries.countFiltered(filter),
      limit,
      offset,
    };
  }

  /**
   * Re-queue a failed or skipped row under the channel's current destination.
   * Pending/delivering rows are a no-op; delivered rows are immutable.
   */
  resend(id: string): ResendDeliveryResult {
    let alertId: string | undefined;
    let channel: DeliveryChannel | undefined;
    try {
      const delivery = this.deliveries.get(id);
      if (!delivery) return { ok: false, reason: 'not_found' };
      alertId = delivery.alertId;
      channel = delivery.channel;

      const alert = this.alerts.get(delivery.alertId);
      if (!alert) {
        return {
          ok: false,
          reason: delivery.status === 'delivered' ? 'already_delivered' : 'alert_deleted',
        };
      }

      const now = this.clock();
      const currentPeriodStart = budgetPeriod(now).start;
      const cellName =
        alert.scope === 'cell'
          ? this.cells.list().find((cell) => cell.id === alert.scopeId)?.name ??
            'Deleted cell'
          : null;
      const route = this.channelRoute(
        delivery.channel,
        { scope: alert.scope, cellId: alert.scope === 'cell' ? alert.scopeId : null },
        delivery.destinationId,
      );
      const block = resendBlockReason({
        status: delivery.status,
        alertExists: true,
        acknowledgedAt: alert.acknowledgedAt,
        periodStart: alert.periodStart,
        currentPeriodStart,
        channelEnabled: route.enabled,
        channelConfigured: route.configured,
      });

      if (block === 'in_flight') {
        return {
          ok: true,
          delivery: this.toHistoryItem(delivery, alert, cellName, currentPeriodStart, true),
        };
      }
      if (block !== null) return { ok: false, reason: block };

      const updated = this.deliveries.resetForResend(id, {
        format: route.format,
        destinationHash: route.hash,
        now,
      });
      if (!updated) {
        // A flush may have changed the row between the read and the guarded update.
        const current = this.deliveries.get(id);
        if (!current) return { ok: false, reason: 'not_found' };
        if (current.status === 'pending' || current.status === 'delivering') {
          return {
            ok: true,
            delivery: this.toHistoryItem(current, alert, cellName, currentPeriodStart, true),
          };
        }
        if (current.status === 'delivered') {
          return { ok: false, reason: 'already_delivered' };
        }
        return { ok: false, reason: 'internal' };
      }

      this.kick();
      return {
        ok: true,
        delivery: this.toHistoryItem(updated, alert, cellName, currentPeriodStart, true),
      };
    } catch {
      this.errors?.error('budget.notify', new Error('delivery resend failed'), {
        phase: 'resend',
        deliveryId: id,
        ...(alertId !== undefined ? { alertId } : {}),
        ...(channel !== undefined ? { channel } : {}),
      });
      return { ok: false, reason: 'internal' };
    }
  }

  private toHistoryItem(
    delivery: DeliveryRecord,
    alert: DeliveryAlertRecord,
    cellName: string | null,
    currentPeriodStart: number,
    alertExists: boolean,
  ): DeliveryHistoryItem {
    const route = this.channelRoute(
      delivery.channel,
      { scope: alert.scope, cellId: alert.scope === 'cell' ? alert.scopeId : null },
      delivery.destinationId,
    );
    const block = resendBlockReason({
      status: delivery.status,
      alertExists,
      acknowledgedAt: alert.acknowledgedAt,
      periodStart: alert.periodStart,
      currentPeriodStart,
      channelEnabled: route.enabled,
      channelConfigured: route.configured,
    });
    return {
      id: delivery.id,
      alertId: delivery.alertId,
      channel: delivery.channel,
      format: delivery.format,
      status: delivery.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.nextAttemptAt,
      lastError: delivery.lastError,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      deliveredAt: delivery.deliveredAt,
      canResend: block === null,
      alert: {
        scope: alert.scope,
        cellId: alert.scope === 'cell' ? alert.scopeId : null,
        cellName,
        threshold: alert.threshold,
        alertAtPercent: alert.alertAtPercent,
        budgetUsd: alert.budgetUsd,
        spendUsd: alert.spendUsd,
        unknownCostTurns: alert.unknownCostTurns,
        periodStart: alert.periodStart,
        createdAt: alert.createdAt,
        acknowledgedAt: alert.acknowledgedAt,
      },
    };
  }

  /** Send a synthetic event without touching durable alert/delivery state. */
  async testWebhook(): Promise<WebhookTestResult> {
    const webhook = this.settings.get().notifications.webhook;
    const started = this.clock();
    if (webhook.url === null) {
      return { ok: false, durationMs: 0, error: 'no webhook URL configured' };
    }
    const now = this.clock();
    const alert = this.testAlert(now);
    const body = formatBody(webhook, budgetAlertEvent(alert, 'budget.test'));
    try {
      const response = await this.sendOnce(webhook, body, alert.id, now);
      const durationMs = Math.max(0, this.clock() - started);
      if (isSuccess(response.status)) return { ok: true, status: response.status, durationMs };
      return {
        ok: false,
        status: response.status,
        durationMs,
        error: `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        durationMs: Math.max(0, this.clock() - started),
        error: deliveryErrorReason(error),
      };
    }
  }

  /** Send a synthetic email without touching durable alert/delivery state. */
  async testEmail(): Promise<EmailTestResult> {
    const email = this.settings.get().notifications.email;
    const started = this.clock();
    if (!emailDeliveryConfigured(email)) {
      return { ok: false, durationMs: 0, error: 'email delivery is not configured' };
    }
    const now = this.clock();
    const alert = this.testAlert(now);
    const message: EmailMessage = {
      from: email.from ?? '',
      to: email.to,
      subject: budgetAlertSubject(alert, 'budget.test'),
      text: budgetEmailText(alert, 'budget.test'),
      messageId: `<budget-test-${alert.id}@aps.local>`,
      alertId: alert.id,
      deliveryId: alert.id,
    };
    try {
      await this.sendEmailOnce(email, message);
      return { ok: true, durationMs: Math.max(0, this.clock() - started) };
    } catch (error) {
      return {
        ok: false,
        durationMs: Math.max(0, this.clock() - started),
        error: emailErrorReason(error).reason,
      };
    }
  }

  /** Send a synthetic Slack message without touching durable state. */
  async testSlack(channelId?: string): Promise<WebhookTestResult> {
    return this.testChat('slack', channelId);
  }

  /** Send a synthetic Discord message without touching durable state. */
  async testDiscord(channelId?: string): Promise<WebhookTestResult> {
    return this.testChat('discord', channelId);
  }

  private async testChat(
    provider: ChatProvider,
    channelId?: string,
  ): Promise<WebhookTestResult> {
    const settings = this.settings.get().notifications[provider];
    const started = this.clock();
    if (settings.botToken === null) {
      return { ok: false, durationMs: 0, error: 'no bot token configured' };
    }
    const channel = channelId ?? settings.defaultChannelId;
    if (
      channel === null ||
      !settings.destinations.some((destination) => destination.channelId === channel)
    ) {
      return { ok: false, durationMs: 0, error: 'no chat destination configured' };
    }
    const alert = this.testAlert(this.clock());
    const text = chatText(alert, provider, {
      event: 'budget.test',
      brainUrl: this.brainUrl,
    });
    const request = chatRequest(provider, settings.botToken, channel, text);
    const decision = await this.sendChatOnce(
      provider,
      request.url,
      request.headers,
      request.body,
    );
    const durationMs = Math.max(0, this.clock() - started);
    if (decision.ok) {
      return {
        ok: true,
        ...(decision.status !== undefined ? { status: decision.status } : {}),
        durationMs,
      };
    }
    return {
      ok: false,
      ...(decision.status !== undefined ? { status: decision.status } : {}),
      durationMs,
      error: decision.reason ?? 'chat test failed',
    };
  }

  private testAlert(now: number): BudgetAlert {
    return {
      id: `test-${randomUUID()}`,
      scope: 'overall',
      cellId: null,
      cellName: null,
      threshold: 'warning',
      alertAtPercent: 80,
      budgetUsd: 100,
      spendUsd: 80,
      unknownCostTurns: 0,
      periodStart: budgetPeriod(now).start,
      createdAt: now,
      acknowledgedAt: null,
    };
  }

  private kick(): void {
    void this.flush();
  }

  private startDelivery(
    delivery: DeliveryRecord,
    periodStart: number,
  ): { delivery: DeliveryRecord; alert: BudgetAlert } | null {
    const marked = this.deliveries.markDelivering(delivery.id, this.clock());
    if (!marked) return null;

    const record = this.alerts.get(marked.alertId);
    if (
      !record ||
      record.acknowledgedAt !== null ||
      record.periodStart !== periodStart
    ) {
      this.deliveries.markSkipped(marked.id, this.clock());
      return null;
    }
    return { delivery: marked, alert: this.toAlert(record) };
  }

  private async deliverWebhook(
    delivery: DeliveryRecord,
    webhook: WebhookSettings,
    periodStart: number,
    generation: number,
  ): Promise<void> {
    const started = this.startDelivery(delivery, periodStart);
    if (!started) return;

    const body = formatBody(webhook, budgetAlertEvent(started.alert));
    let response: Response;
    try {
      response = await this.sendOnce(webhook, body, started.alert.id, this.clock());
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleFailure(started.delivery, deliveryErrorReason(error), {
        retryable: true,
        retryAfterMs: null,
      });
      return;
    }
    if (generation !== this.generation) return;

    if (isSuccess(response.status)) {
      this.deliveries.markDelivered(started.delivery.id, this.clock());
      return;
    }
    this.handleFailure(started.delivery, `HTTP ${response.status}`, {
      retryable: isRetryable(response.status),
      retryAfterMs: retryAfterMs(response, this.clock()),
    });
  }

  private async deliverEmail(
    delivery: DeliveryRecord,
    email: EmailSettings,
    periodStart: number,
    generation: number,
  ): Promise<void> {
    const started = this.startDelivery(delivery, periodStart);
    if (!started) return;

    const message: EmailMessage = {
      from: email.from ?? '',
      to: email.to,
      subject: budgetAlertSubject(started.alert),
      text: budgetEmailText(started.alert),
      messageId: messageIdFor(started.alert.id),
      alertId: started.alert.id,
      deliveryId: started.delivery.id,
    };
    try {
      await this.sendEmailOnce(email, message);
    } catch (error) {
      if (generation !== this.generation) return;
      const classified = emailErrorReason(error);
      this.handleFailure(started.delivery, classified.reason, {
        retryable: !classified.permanent,
        retryAfterMs: null,
      });
      return;
    }
    if (generation !== this.generation) return;
    this.deliveries.markDelivered(started.delivery.id, this.clock());
  }

  private handleFailure(
    delivery: DeliveryRecord,
    reason: string,
    options: { retryable: boolean; retryAfterMs: number | null },
  ): void {
    const now = this.clock();
    const attempt = delivery.attempts;
    if (!options.retryable || attempt >= this.maxAttempts) {
      this.deliveries.markFailed(delivery.id, now, reason);
      this.report(delivery, attempt, reason);
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 0;
    this.deliveries.markRetry(
      delivery.id,
      now,
      now + (options.retryAfterMs ?? delay),
      reason,
    );
    this.report(delivery, attempt, reason);
  }

  private report(delivery: DeliveryRecord, attempt: number, reason: string): void {
    // Log a synthesized error: sender errors and HTTP messages can carry the
    // URL, recipients, or response body, which must never reach the error log.
    this.errors?.error('budget.notify', new Error(reason), {
      alertId: delivery.alertId,
      deliveryId: delivery.id,
      channel: delivery.channel,
      attempt,
      ...(delivery.format !== 'json' ? { format: delivery.format } : {}),
      reason,
    });
  }

  private async sendChatOnce(
    provider: ChatProvider,
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<ChatDecision> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('chat request timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([
        (async () => {
          const response = await this.send(url, {
            method: 'POST',
            headers,
            body,
            redirect: 'manual',
            signal: controller.signal,
          });
          const text = await readChatBody(response);
          return classifyChatResponse(provider, response, text, this.clock());
        })(),
        timeout,
      ]);
    } catch (error) {
      return { ok: false, retryable: true, reason: deliveryErrorReason(error) };
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private async sendOnce(
    webhook: WebhookSettings,
    body: string,
    idempotencyKey: string,
    timestamp: number,
    userAgent = 'aps-budget-alert/1',
  ): Promise<Response> {
    const url = webhook.url;
    if (url === null) throw new Error('no webhook URL configured');

    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('webhook request timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([
        this.send(url, {
          method: 'POST',
          headers: headersFor(body, webhook, idempotencyKey, timestamp, userAgent),
          body,
          redirect: 'manual',
          signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private async sendEmailOnce(
    email: EmailSettings,
    message: EmailMessage,
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('email delivery timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();
    });

    try {
      await Promise.race([
        this.sendEmail(email, message, controller.signal),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private toAlert(record: BudgetAlertRecord): BudgetAlert {
    const cells = record.scope === 'cell' ? this.cells.list() : [];
    return {
      id: record.id,
      scope: record.scope,
      cellId: record.scope === 'cell' ? record.scopeId : null,
      cellName:
        record.scope === 'cell'
          ? cells.find((cell) => cell.id === record.scopeId)?.name ?? 'Deleted cell'
          : null,
      threshold: record.threshold,
      alertAtPercent: record.alertAtPercent,
      budgetUsd: record.budgetUsd,
      spendUsd: record.spendUsd,
      unknownCostTurns: record.unknownCostTurns,
      periodStart: record.periodStart,
      createdAt: record.createdAt,
      acknowledgedAt: record.acknowledgedAt,
    };
  }
}
