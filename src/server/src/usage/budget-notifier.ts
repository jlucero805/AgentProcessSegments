import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { CellRepository } from '../cells/repository.js';
import type { ErrorSink } from '../logging/errors.js';
import type { SettingsStore } from '../settings.js';
import {
  budgetAlertEvent,
  budgetPeriod,
  type BudgetAlert,
  type BudgetAlertEvent,
  type DeliveryStatus,
  type WebhookFormat,
  type WebhookSettings,
} from '../domain/budget.js';
import type { BudgetAlertRecord } from './budget-alerts.js';
import type { BudgetAlertRepository } from './budget-alerts.js';
import type {
  BudgetAlertDeliveryRepository,
  DeliveryRecord,
} from './budget-deliveries.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_NOTIFY_INTERVAL_MS = 60_000;
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;
export const DEFAULT_NOTIFY_MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const PRUNE_AGE_MS = 400 * 24 * 60 * 60_000;
const DEFAULT_BATCH_SIZE = 20;

export interface BudgetNotifierDeps {
  deliveries: BudgetAlertDeliveryRepository;
  alerts: BudgetAlertRepository;
  cells: Pick<CellRepository, 'list'>;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  errors?: ErrorSink;
  send?: FetchLike;
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

export interface NotificationStatusResponse {
  webhook: WebhookStatus;
}

export interface WebhookTestResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
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
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'aps-budget-alert/1',
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
 * Delivers durable budget alerts to the configured webhook. Delivery is
 * advisory: every failure is recorded, retried within a bounded schedule, and
 * reported to the error sink without throwing into the caller.
 */
export class BudgetNotifier {
  private readonly deliveries: BudgetAlertDeliveryRepository;
  private readonly alerts: BudgetAlertRepository;
  private readonly cells: Pick<CellRepository, 'list'>;
  private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>;
  private readonly errors?: ErrorSink;
  private readonly send: FetchLike;
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

  constructor(options: BudgetNotifierDeps) {
    this.deliveries = options.deliveries;
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
  }

  start(): void {
    if (this.timer) return;
    const now = this.clock();
    this.deliveries.resetStale(now);
    this.deliveries.pruneBefore(now - PRUNE_AGE_MS);
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
      const webhook = this.settings.get().notifications.webhook;
      if (!webhook.enabled || webhook.url === null) return;
      const hash = destinationHash(webhook);
      const now = this.clock();
      for (const alert of alerts) {
        if (alert.acknowledgedAt !== null) continue;
        this.deliveries.enqueue({
          alertId: alert.id,
          format: webhook.format,
          destinationHash: hash,
          now,
        });
      }
      this.kick();
    } catch (error) {
      this.errors?.error('budget.notify', error, { phase: 'enqueue' });
    }
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
    try {
      const webhook = this.settings.get().notifications.webhook;
      const now = this.clock();
      if (!webhook.enabled || webhook.url === null) {
        this.deliveries.skipPending(now);
        return;
      }

      const hash = destinationHash(webhook);
      const periodStart = budgetPeriod(now).start;
      this.deliveries.skipAcknowledged(now);
      this.deliveries.skipStaleDestination(hash, now);
      this.deliveries.skipBeforePeriod(periodStart, now);

      const due = this.deliveries.listDue(hash, periodStart, now, this.batchSize);
      for (const delivery of due) {
        if (generation !== this.generation) return;
        await this.deliver(delivery, webhook, periodStart, generation);
      }
    } catch (error) {
      this.errors?.error('budget.notify', error, { phase: 'flush' });
    }
  }

  status(): NotificationStatusResponse {
    const webhook = this.settings.get().notifications.webhook;
    const summary = this.deliveries.status();
    return {
      webhook: {
        enabled: webhook.enabled,
        configured: webhook.url !== null,
        format: webhook.format,
        pending: summary.pending,
        failed: summary.failed,
        lastDeliveryAt: summary.lastDeliveryAt,
        lastDeliveryStatus: summary.lastDeliveryStatus,
        lastError: summary.lastError,
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
    const alert: BudgetAlert = {
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

  private kick(): void {
    void this.flush();
  }

  private async deliver(
    delivery: DeliveryRecord,
    webhook: WebhookSettings,
    periodStart: number,
    generation: number,
  ): Promise<void> {
    const marked = this.deliveries.markDelivering(delivery.id, this.clock());
    if (!marked) return;

    const record = this.alerts.get(marked.alertId);
    if (
      !record ||
      record.acknowledgedAt !== null ||
      record.periodStart !== periodStart
    ) {
      this.deliveries.markSkipped(marked.id, this.clock());
      return;
    }

    const alert = this.toAlert(record);
    const body = formatBody(webhook, budgetAlertEvent(alert));
    let response: Response;
    try {
      response = await this.sendOnce(webhook, body, alert.id, this.clock());
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleFailure(marked, deliveryErrorReason(error), null);
      return;
    }
    if (generation !== this.generation) return;

    if (isSuccess(response.status)) {
      this.deliveries.markDelivered(marked.id, this.clock());
      return;
    }
    this.handleFailure(marked, `HTTP ${response.status}`, response);
  }

  private handleFailure(
    delivery: DeliveryRecord,
    reason: string,
    response: Response | null,
  ): void {
    const now = this.clock();
    const attempt = delivery.attempts;
    if (response !== null && !isRetryable(response.status)) {
      this.deliveries.markFailed(delivery.id, now, reason);
      this.report(delivery, attempt, reason);
      return;
    }
    if (attempt >= this.maxAttempts) {
      this.deliveries.markFailed(delivery.id, now, reason);
      this.report(delivery, attempt, reason);
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 0;
    const retryAfter = response !== null ? retryAfterMs(response, now) : null;
    this.deliveries.markRetry(delivery.id, now, now + (retryAfter ?? delay), reason);
    this.report(delivery, attempt, reason);
  }

  private report(delivery: DeliveryRecord, attempt: number, reason: string): void {
    // Log a synthesized error: sender errors and HTTP messages can carry the
    // URL or response body, which must never reach the error log.
    this.errors?.error('budget.notify', new Error(reason), {
      alertId: delivery.alertId,
      deliveryId: delivery.id,
      attempt,
      ...(delivery.format !== 'json' ? { format: delivery.format } : {}),
      reason,
    });
  }

  private async sendOnce(
    webhook: WebhookSettings,
    body: string,
    idempotencyKey: string,
    timestamp: number,
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
          headers: headersFor(body, webhook, idempotencyKey, timestamp),
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
