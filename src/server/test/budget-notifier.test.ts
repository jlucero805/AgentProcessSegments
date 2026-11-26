import { createHmac } from 'node:crypto';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb, type Db } from '../src/db.js';
import {
  budgetPeriod,
  type BudgetAlert,
  type ChatSettings,
  type EmailSettings,
  type WebhookSettings,
} from '../src/domain/budget.js';
import type { ErrorSink } from '../src/logging/errors.js';
import type { TurnFailureNotification } from '../src/domain/notifications.js';
import { SettingsStore } from '../src/settings.js';
import {
  BudgetAlertRepository,
  type BudgetAlertInput,
  type BudgetAlertRecord,
} from '../src/usage/budget-alerts.js';
import { BudgetAlertDeliveryRepository } from '../src/usage/budget-deliveries.js';
import { NotificationEventDeliveryRepository } from '../src/notifications/event-deliveries.js';
import {
  NotificationService,
  destinationHash,
  type FetchLike,
} from '../src/notifications/service.js';
import { chatDestinationHash } from '../src/usage/budget-chat.js';
import {
  EmailSendError,
  emailDestinationHash,
  type EmailMessage,
  type EmailSendLike,
} from '../src/usage/budget-email.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const PERIOD = budgetPeriod(NOW);

interface Sent {
  url: string;
  init: RequestInit;
}

function sender(
  handler: (sent: Sent, call: number) => Response | Promise<Response>,
): { calls: Sent[]; send: FetchLike } {
  const calls: Sent[] = [];
  const send: FetchLike = async (url, init) => {
    const sent = { url, init: init ?? {} };
    calls.push(sent);
    return handler(sent, calls.length);
  };
  return { calls, send };
}

function ok(): Response {
  return new Response(null, { status: 204 });
}

interface SentEmail {
  email: EmailSettings;
  message: EmailMessage;
  signal: AbortSignal;
}

function emailSender(
  handler: (sent: SentEmail, call: number) => void | Promise<void> = () => undefined,
): { calls: SentEmail[]; send: EmailSendLike } {
  const calls: SentEmail[] = [];
  const send: EmailSendLike = async (email, message, signal) => {
    const sent = { email, message, signal };
    calls.push(sent);
    await handler(sent, calls.length);
  };
  return { calls, send };
}

const EMAIL: Partial<EmailSettings> = {
  enabled: true,
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  username: null,
  password: null,
  from: 'APS <alerts@example.test>',
  to: ['ops@example.test'],
};

const SLACK: ChatSettings = {
  enabled: true,
  botToken: 'xoxb-0123456789abcdef',
  destinations: [
    { channelId: 'C0123456789', label: 'Ops' },
    { channelId: 'C9876543210', label: 'Cell' },
  ],
  defaultChannelId: 'C0123456789',
  routes: [],
};

const DISCORD: ChatSettings = {
  enabled: true,
  botToken: 'discord-0123456789abcdef',
  destinations: [{ channelId: '123456789012345678', label: 'Ops' }],
  defaultChannelId: '123456789012345678',
  routes: [],
};

function makeClock(start = NOW): { now: () => number; advance: (ms: number) => void; set: (value: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
    set: (next) => {
      value = next;
    },
  };
}

interface SetupOptions {
  send: FetchLike;
  webhook?: Partial<WebhookSettings>;
  email?: Partial<EmailSettings>;
  slack?: Partial<ChatSettings>;
  discord?: Partial<ChatSettings>;
  brainUrl?: string;
  sendEmail?: EmailSendLike;
  maxAttempts?: number;
  timeoutMs?: number;
  errors?: ErrorSink;
  clock?: ReturnType<typeof makeClock>;
}

function setup(options: SetupOptions) {
  const db: Db = openDb(':memory:');
  const cells = new CellRepository(db);
  const alerts = new BudgetAlertRepository(db);
  const deliveries = new BudgetAlertDeliveryRepository(db);
  const events = new NotificationEventDeliveryRepository(db);
  const dir = tmpDir('notifier');
  const settings = new SettingsStore(path.join(dir, 'config.json'));
  settings.patch({
    notifications: {
      webhook: {
        enabled: true,
        url: 'https://hooks.example.test/budget',
        format: 'json',
        secret: null,
        ...options.webhook,
      },
      ...(options.email ? { email: { ...EMAIL, ...options.email } } : {}),
      ...(options.slack ? { slack: { ...SLACK, ...options.slack } } : {}),
      ...(options.discord ? { discord: { ...DISCORD, ...options.discord } } : {}),
    },
  });
  const clock = options.clock ?? makeClock();
  const notifier = new NotificationService({
    deliveries,
    events,
    alerts,
    cells,
    settings,
    send: options.send,
    ...(options.sendEmail ? { sendEmail: options.sendEmail } : {}),
    ...(options.brainUrl ? { brainUrl: options.brainUrl } : {}),
    now: clock.now,
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.errors ? { errors: options.errors } : {}),
  });
  return { db, cells, alerts, deliveries, events, settings, clock, notifier };
}

function addAlert(
  repo: BudgetAlertRepository,
  overrides: Partial<BudgetAlertInput> = {},
): BudgetAlertRecord {
  return repo.upsert(
    {
      scope: 'overall',
      scopeId: '',
      periodStart: PERIOD.start,
      threshold: 'warning',
      alertAtPercent: 80,
      budgetUsd: 100,
      spendUsd: 85,
      unknownCostTurns: 0,
      ...overrides,
    },
    NOW,
  );
}

function asAlert(record: BudgetAlertRecord, cellName: string | null = null): BudgetAlert {
  return {
    id: record.id,
    scope: record.scope,
    cellId: record.scope === 'cell' ? record.scopeId : null,
    cellName,
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

function parseBody(sent: Sent): Record<string, unknown> {
  return JSON.parse(String(sent.init.body)) as Record<string, unknown>;
}

describe('NotificationService', () => {
  it('delivers an alert once and dedupes re-evaluation', async () => {
    const fake = sender(() => ok());
    const { alerts, deliveries, notifier } = setup({ send: fake.send });
    const record = addAlert(alerts);

    notifier.observe([asAlert(record)]);
    notifier.observe([asAlert(record)]);
    await notifier.flush();

    expect(fake.calls).toHaveLength(1);
    expect(deliveries.getForAlert(record.id).status).toBe('delivered');
    await notifier.flush();
    expect(fake.calls).toHaveLength(1);
  });

  it('posts the documented JSON payload with a lower bound and period end', async () => {
    const fake = sender(() => ok());
    const { alerts, notifier } = setup({ send: fake.send });
    const record = addAlert(alerts, { unknownCostTurns: 2, spendUsd: 81.25 });

    notifier.observe([asAlert(record)]);
    await notifier.flush();

    const body = parseBody(fake.calls[0]!);
    expect(body).toMatchObject({
      version: 1,
      event: 'budget.alert',
      alert: {
        id: record.id,
        scope: 'overall',
        cellId: null,
        cellName: null,
        threshold: 'warning',
        alertAtPercent: 80,
        budgetUsd: 100,
        spendUsd: 81.25,
        spendIsLowerBound: true,
        unknownCostTurns: 2,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        createdAt: NOW,
      },
      text: 'Overall spend reached 80% of its $100.00 monthly budget (at least $81.25).',
    });
    expect(fake.calls[0]!.init.redirect).toBe('manual');
    expect(new Headers(fake.calls[0]!.init.headers).get('idempotency-key')).toBe(record.id);
    expect(new Headers(fake.calls[0]!.init.headers).get('user-agent')).toBe(
      'aps-budget-alert/1',
    );
  });

  it('uses Slack and Discord text bodies', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send, webhook: { format: 'slack' } });
    const record = addAlert(context.alerts);
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(parseBody(fake.calls[0]!)).toEqual({
      text: 'Overall spend reached 80% of its $100.00 monthly budget ($85.00).',
    });

    context.settings.patch({ notifications: { webhook: { format: 'discord' } } });
    const second = context.alerts.upsert(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD.start,
        threshold: 'exceeded',
        alertAtPercent: 80,
        budgetUsd: 100,
        spendUsd: 110,
        unknownCostTurns: 0,
      },
      NOW,
    );
    context.notifier.observe([asAlert(second)]);
    await context.notifier.flush();
    expect(parseBody(fake.calls[1]!)).toEqual({
      content: 'Overall spend is over its $100.00 monthly budget ($110.00).',
    });
  });

  it('signs JSON bodies with HMAC-SHA256 when a secret is set', async () => {
    const secret = '0123456789abcdef';
    const fake = sender(() => ok());
    const context = setup({ send: fake.send, webhook: { secret } });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    const sent = fake.calls[0]!;
    const body = String(sent.init.body);
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    const headers = new Headers(sent.init.headers);
    expect(headers.get('x-aps-signature')).toBe(`sha256=${expected}`);
    expect(headers.get('x-aps-timestamp')).toBe(String(NOW));
  });

  it('retries 5xx on the backoff schedule', async () => {
    const fake = sender((_sent, call) =>
      call === 1 ? new Response(null, { status: 500 }) : ok(),
    );
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    const delivery = context.deliveries.getForAlert(record.id);
    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(1);
    expect(delivery.nextAttemptAt).toBe(NOW + 60_000);
    expect(delivery.lastError).toBe('HTTP 500');

    context.clock.advance(59_999);
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(1);

    context.clock.advance(1);
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(2);
    expect(context.deliveries.getForAlert(record.id).status).toBe('delivered');
  });

  it('honors Retry-After and treats 4xx as permanent failures', async () => {
    const withRetryAfter = sender(
      () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
    );
    const retry = setup({ send: withRetryAfter.send });
    const first = addAlert(retry.alerts);
    retry.notifier.observe([asAlert(first)]);
    await retry.notifier.flush();
    expect(retry.deliveries.getForAlert(first.id)).toMatchObject({
      status: 'pending',
      nextAttemptAt: NOW + 120_000,
      lastError: 'HTTP 429',
    });

    const badRequest = sender(() => new Response(null, { status: 404 }));
    const permanent = setup({ send: badRequest.send });
    const second = addAlert(permanent.alerts);
    permanent.notifier.observe([asAlert(second)]);
    await permanent.notifier.flush();
    expect(permanent.deliveries.getForAlert(second.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'HTTP 404',
    });
    permanent.clock.advance(24 * 60 * 60_000);
    await permanent.notifier.flush();
    expect(badRequest.calls).toHaveLength(1);
  });

  it('honors an HTTP-date Retry-After and skips prior periods', async () => {
    const retryAt = new Date(NOW + 90_000).toUTCString();
    const fake = sender(
      () => new Response(null, { status: 503, headers: { 'retry-after': retryAt } }),
    );
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(context.deliveries.getForAlert(record.id).nextAttemptAt).toBe(NOW + 90_000);

    const prior = addAlert(context.alerts, {
      periodStart: budgetPeriod(NOW - 40 * 24 * 60 * 60_000).start,
      threshold: 'exceeded',
      spendUsd: 110,
    });
    context.deliveries.enqueue({
      alertId: prior.id,
      format: 'json',
      destinationHash: destinationHash(context.settings.get().notifications.webhook),
      now: NOW,
    });
    const callsBefore = fake.calls.length;
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(callsBefore);
    expect(context.deliveries.getForAlert(prior.id).status).toBe('skipped');
  });

  it('marks failed after the attempt budget', async () => {
    const fake = sender(() => new Response(null, { status: 502 }));
    const context = setup({ send: fake.send, maxAttempts: 2 });
    const record = addAlert(context.alerts);
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(context.deliveries.getForAlert(record.id).attempts).toBe(1);

    context.clock.advance(60_000);
    await context.notifier.flush();
    expect(context.deliveries.getForAlert(record.id)).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'HTTP 502',
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('treats timeouts and network errors as retryable', async () => {
    const timeout = sender(() => new Promise<Response>(() => {}));
    const context = setup({ send: timeout.send, timeoutMs: 5 });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(context.deliveries.getForAlert(record.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'timeout',
    });

    const network = sender(() => {
      const error = new TypeError('fetch failed');
      (error as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw error;
    });
    const second = setup({ send: network.send });
    const record2 = addAlert(second.alerts);
    second.notifier.observe([asAlert(record2)]);
    await second.notifier.flush();
    expect(second.deliveries.getForAlert(record2.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'ECONNREFUSED',
    });
  });

  it('shares one in-flight drain between concurrent flushes', async () => {
    let release: (() => void) | null = null;
    const fake = sender(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(ok());
        }),
    );
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);
    context.notifier.observe([asAlert(record)]);

    const first = context.notifier.flush();
    const second = context.notifier.flush();
    expect(second).toBe(first);
    expect(fake.calls).toHaveLength(1);

    (release as (() => void) | null)?.();
    await first;
    expect(context.deliveries.getForAlert(record.id).status).toBe('delivered');
  });

  it('does not enqueue while disabled and skips pending rows', async () => {
    const fake = sender(() => ok());
    const context = setup({
      send: fake.send,
      webhook: { enabled: false },
    });
    const record = addAlert(context.alerts);
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(0);

    context.deliveries.enqueue({
      alertId: record.id,
      format: 'json',
      destinationHash: destinationHash(context.settings.get().notifications.webhook),
      now: NOW,
    });
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(0);
    expect(context.deliveries.getForAlert(record.id).status).toBe('skipped');
  });

  it('sends the active alert when the webhook is enabled', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send, webhook: { enabled: false } });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(0);

    context.settings.patch({ notifications: { webhook: { enabled: true } } });
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(1);
    expect(context.deliveries.getForAlert(record.id).status).toBe('delivered');
  });

  it('skips pending deliveries after the destination changes', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);
    context.deliveries.enqueue({
      alertId: record.id,
      format: 'json',
      destinationHash: destinationHash(context.settings.get().notifications.webhook),
      now: NOW,
    });

    context.settings.patch({
      notifications: { webhook: { url: 'https://hooks.example.test/rotated' } },
    });
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(0);
    expect(context.deliveries.getForAlert(record.id).status).toBe('skipped');
  });

  it('skips deliveries when the alert is acknowledged', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);
    context.deliveries.enqueue({
      alertId: record.id,
      format: 'json',
      destinationHash: destinationHash(context.settings.get().notifications.webhook),
      now: NOW,
    });
    context.alerts.acknowledge(record.id, NOW);

    await context.notifier.flush();
    expect(fake.calls).toHaveLength(0);
    expect(context.deliveries.getForAlert(record.id).status).toBe('skipped');
  });

  it('recovers stale rows but leaves delivery retention to DataRetention', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);
    context.deliveries.enqueue({
      alertId: record.id,
      format: 'json',
      destinationHash: destinationHash(context.settings.get().notifications.webhook),
      now: NOW,
    });
    context.db
      .prepare("UPDATE budget_alert_deliveries SET status = 'delivering' WHERE alert_id = ?")
      .run(record.id);

    const old = addAlert(context.alerts, { threshold: 'exceeded', spendUsd: 105 });
    const oldDelivery = context.deliveries.enqueue({
      alertId: old.id,
      format: 'json',
      destinationHash: destinationHash(context.settings.get().notifications.webhook),
      now: NOW - 401 * 24 * 60 * 60_000,
    });
    context.db
      .prepare("UPDATE budget_alert_deliveries SET status = 'delivered' WHERE id = ?")
      .run(oldDelivery.id);

    context.notifier.start();
    await context.notifier.flush();
    context.notifier.stop();

    expect(context.deliveries.getForAlert(record.id).status).toBe('delivered');
    // Budget-alert retention lives in DataRetention; the notifier no longer
    // deletes old rows on start.
    expect(context.deliveries.get(oldDelivery.id)).toMatchObject({ status: 'delivered' });
  });

  it('reports failures to the error sink without leaking the URL or secret', async () => {
    const reports: Array<{ source: string; context: unknown }> = [];
    const errors: ErrorSink = {
      error: (source, _error, context) => reports.push({ source, context }),
    };
    const secret = 'super-secret-value-1234';
    const fake = sender(() => new Response(null, { status: 500 }));
    const context = setup({
      send: fake.send,
      webhook: { secret },
      errors,
    });
    const record = addAlert(context.alerts);
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    expect(reports).toHaveLength(1);
    expect(reports[0]!.source).toBe('budget.notify');
    const serialized = JSON.stringify(reports[0]);
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain(secret);
    expect(reports[0]!.context).toMatchObject({
      alertId: record.id,
      attempt: 1,
      reason: 'HTTP 500',
    });
  });

  it('sends a test event without writing alert or delivery rows', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send, webhook: { enabled: false } });

    const result = await context.notifier.testWebhook();

    expect(result).toEqual({ ok: true, status: 204, durationMs: 0 });
    expect(fake.calls).toHaveLength(1);
    expect(parseBody(fake.calls[0]!)).toMatchObject({
      event: 'budget.test',
      alert: { scope: 'overall' },
    });
    expect(
      (
        context.db.prepare('SELECT COUNT(*) AS count FROM budget_alerts').get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(context.deliveries.status().lastDeliveryAt).toBeNull();
  });

  it('summarizes pending, failed, and the latest delivery', async () => {
    const fake = sender((_sent, call) =>
      call === 1 ? new Response(null, { status: 404 }) : ok(),
    );
    const context = setup({ send: fake.send });
    const first = addAlert(context.alerts);
    const second = addAlert(context.alerts, { threshold: 'exceeded', spendUsd: 110 });

    context.notifier.observe([asAlert(first)]);
    await context.notifier.flush();
    context.clock.advance(1_000);
    context.notifier.observe([asAlert(second)]);
    await context.notifier.flush();

    expect(context.notifier.status().webhook).toMatchObject({
      enabled: true,
      configured: true,
      format: 'json',
      pending: 0,
      failed: 1,
      lastDeliveryStatus: 'delivered',
      lastError: null,
    });
    expect(context.notifier.status().webhook.lastDeliveryAt).not.toBeNull();
  });
});

describe('NotificationService email channel', () => {
  it('enqueues and delivers one row per enabled channel without duplicates', async () => {
    const fake = sender(() => ok());
    const mail = emailSender();
    const context = setup({ send: fake.send, sendEmail: mail.send, email: {} });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(1);
    expect(mail.calls).toHaveLength(1);
    expect(context.deliveries.getForAlert(record.id, 'webhook').status).toBe('delivered');
    expect(context.deliveries.getForAlert(record.id, 'email').status).toBe('delivered');
  });

  it('builds the documented email subject, body, and headers', async () => {
    const fake = sender(() => ok());
    const mail = emailSender();
    const context = setup({ send: fake.send, sendEmail: mail.send, email: {} });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    const sent = mail.calls[0]!;
    expect(sent.message).toMatchObject({
      from: 'APS <alerts@example.test>',
      to: ['ops@example.test'],
      subject: '[APS] Overall budget warning (80%)',
      alertId: record.id,
      messageId: `<budget-${record.id}@aps.local>`,
    });
    expect(sent.message.text).toContain('Alert: ' + record.id);
    expect(sent.message.text).toContain('(UTC)');
    expect(sent.message.text).not.toContain('<html');
    expect(sent.email.host).toBe('smtp.example.test');
  });

  it('skips only the disabled channel', async () => {
    const fake = sender(() => ok());
    const mail = emailSender();
    const context = setup({
      send: fake.send,
      sendEmail: mail.send,
      email: { enabled: false },
    });
    const record = addAlert(context.alerts);
    context.deliveries.enqueue({
      alertId: record.id,
      channel: 'email',
      format: 'email',
      destinationHash: 'stale',
      now: NOW,
    });

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(1);
    expect(mail.calls).toHaveLength(0);
    expect(context.deliveries.getForAlert(record.id, 'webhook').status).toBe('delivered');
    expect(context.deliveries.getForAlert(record.id, 'email').status).toBe('skipped');
  });

  it('skips stale email destinations without touching webhook rows', async () => {
    const fake = sender(() => ok());
    const mail = emailSender();
    const context = setup({ send: fake.send, sendEmail: mail.send, email: {} });
    const record = addAlert(context.alerts);
    const current = context.settings.get().notifications;

    context.deliveries.enqueue({
      alertId: record.id,
      channel: 'webhook',
      format: 'json',
      destinationHash: destinationHash(current.webhook),
      now: NOW,
    });
    context.deliveries.enqueue({
      alertId: record.id,
      channel: 'email',
      format: 'email',
      destinationHash: emailDestinationHash(current.email),
      now: NOW,
    });
    context.settings.patch({
      notifications: { email: { host: 'smtp.rotated.test' } },
    });
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(1);
    expect(mail.calls).toHaveLength(0);
    expect(context.deliveries.getForAlert(record.id, 'webhook').status).toBe('delivered');
    expect(context.deliveries.getForAlert(record.id, 'email').status).toBe('skipped');
  });

  it('retries transient email failures and fails permanent ones immediately', async () => {
    const fake = sender(() => ok());
    let permanent = false;
    const mail = emailSender(() => {
      if (permanent) throw new EmailSendError('recipient rejected', true);
      throw new EmailSendError('econnection', false);
    });
    const context = setup({
      send: fake.send,
      sendEmail: mail.send,
      email: {},
    });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    const retry = context.deliveries.getForAlert(record.id, 'email');
    expect(retry).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: NOW + 60_000,
      lastError: 'econnection',
    });

    permanent = true;
    context.clock.advance(60_000);
    await context.notifier.flush();
    expect(context.deliveries.getForAlert(record.id, 'email')).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'recipient rejected',
    });
  });

  it('times out a send and schedules a retry', async () => {
    const fake = sender(() => ok());
    const mail = emailSender(() => new Promise<void>(() => undefined));
    const context = setup({
      send: fake.send,
      sendEmail: mail.send,
      email: {},
      timeoutMs: 20,
    });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    expect(mail.calls[0]!.signal.aborted).toBe(true);
    expect(context.deliveries.getForAlert(record.id, 'email')).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'timeout',
    });
  });

  it('sends a test email without writing alert or delivery rows', async () => {
    const fake = sender(() => ok());
    const mail = emailSender();
    const context = setup({ send: fake.send, sendEmail: mail.send, email: {} });

    const result = await context.notifier.testEmail();

    expect(result.ok).toBe(true);
    expect(mail.calls).toHaveLength(1);
    expect(mail.calls[0]!.message.subject).toBe('[APS] Test budget alert');
    expect(
      (context.db.prepare('SELECT COUNT(*) AS count FROM budget_alerts').get() as {
        count: number;
      }).count,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS count FROM budget_alert_deliveries').get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it('reports per-channel status and safe failure reasons', async () => {
    const fake = sender(() => ok());
    const errors = { error: vi.fn() };
    const mail = emailSender(() => {
      throw new EmailSendError('eauth', true);
    });
    const context = setup({
      send: fake.send,
      sendEmail: mail.send,
      email: {},
      errors: errors as unknown as ErrorSink,
    });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    const status = context.notifier.status();
    expect(status.webhook).toMatchObject({ configured: true, pending: 0, failed: 0 });
    expect(status.email).toEqual({
      enabled: true,
      configured: true,
      pending: 0,
      failed: 1,
      lastDeliveryAt: NOW,
      lastDeliveryStatus: 'failed',
      lastError: 'eauth',
    });
    expect(errors.error).toHaveBeenCalledWith(
      'budget.notify',
      expect.any(Error),
      expect.objectContaining({ channel: 'email', alertId: record.id, reason: 'eauth' }),
    );
    const logged = JSON.stringify(errors.error.mock.calls);
    expect(logged).not.toContain('smtp.example.test');
    expect(logged).not.toContain('ops@example.test');
  });
});

describe('NotificationService delivery history', () => {
  function enqueueWebhook(
    context: ReturnType<typeof setup>,
    alert: BudgetAlertRecord,
  ): ReturnType<BudgetAlertDeliveryRepository['enqueue']> {
    const webhook = context.settings.get().notifications.webhook;
    return context.deliveries.enqueue({
      alertId: alert.id,
      channel: 'webhook',
      format: webhook.format,
      destinationHash: destinationHash(webhook),
      now: NOW,
    });
  }

  it('lists history without exposing the destination or payload', () => {
    const context = setup({ send: sender(() => ok()).send });
    const record = addAlert(context.alerts);
    const row = enqueueWebhook(context, record);
    context.deliveries.markFailed(row.id, NOW, 'HTTP 503');

    const history = context.notifier.history({ limit: 10, offset: 0 });

    expect(history).toMatchObject({ total: 1, limit: 10, offset: 0 });
    expect(history.deliveries[0]).toMatchObject({
      id: row.id,
      alertId: record.id,
      channel: 'webhook',
      status: 'failed',
      attempts: 0,
      lastError: 'HTTP 503',
      canResend: true,
      alert: {
        scope: 'overall',
        cellId: null,
        cellName: null,
        threshold: 'warning',
        alertAtPercent: 80,
        budgetUsd: 100,
        spendUsd: 85,
        periodStart: PERIOD.start,
      },
    });
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain(
      destinationHash(context.settings.get().notifications.webhook),
    );
    expect(serialized).not.toContain('hooks.example.test');
  });

  it('resolves cell names and falls back for a deleted cell', () => {
    const context = setup({ send: sender(() => ok()).send });
    const cell = context.cells.create('Alpha');
    const record = addAlert(context.alerts, { scope: 'cell', scopeId: cell.id });
    enqueueWebhook(context, record);

    expect(context.notifier.history({}).deliveries[0]?.alert).toMatchObject({
      cellId: cell.id,
      cellName: 'Alpha',
    });

    context.db.prepare('DELETE FROM cells WHERE id = ?').run(cell.id);
    expect(context.notifier.history({}).deliveries[0]?.alert.cellName).toBe('Deleted cell');
  });

  it('keeps history and refuses resend after the alert is deleted', () => {
    const context = setup({ send: sender(() => ok()).send });
    const record = addAlert(context.alerts);
    const row = enqueueWebhook(context, record);
    context.deliveries.markFailed(row.id, NOW, 'HTTP 503');

    context.db.prepare('DELETE FROM budget_alerts WHERE id = ?').run(record.id);

    const history = context.notifier.history({});
    expect(history.deliveries[0]).toMatchObject({
      id: row.id,
      alertId: record.id,
      status: 'failed',
      canResend: false,
      alert: {
        scope: 'overall',
        cellId: null,
        cellName: null,
        threshold: 'warning',
        alertAtPercent: 80,
        budgetUsd: 100,
        spendUsd: 85,
        periodStart: PERIOD.start,
      },
    });
    expect(context.notifier.resend(row.id)).toEqual({
      ok: false,
      reason: 'alert_deleted',
    });
    expect(context.deliveries.get(row.id)?.status).toBe('failed');
  });

  it('skips an orphaned pending delivery without sending it', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);
    const row = enqueueWebhook(context, record);

    context.db.prepare('DELETE FROM budget_alerts WHERE id = ?').run(record.id);
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(0);
    expect(context.deliveries.get(row.id)).toMatchObject({
      status: 'skipped',
      attempts: 0,
    });
    expect(context.notifier.history({}).deliveries[0]?.alert.spendUsd).toBe(85);
  });

  it('resends a failed row under the current destination exactly once', async () => {
    const fake = sender(() => ok());
    const context = setup({ send: fake.send });
    const record = addAlert(context.alerts);
    const row = enqueueWebhook(context, record);
    context.deliveries.markFailed(row.id, NOW, 'HTTP 503');
    context.settings.patch({ notifications: { webhook: { format: 'slack' } } });

    const result = context.notifier.resend(row.id);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.delivery).toMatchObject({
        status: 'pending',
        format: 'slack',
        attempts: 0,
        canResend: false,
      });
    }
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(String(fake.calls[0]?.init.body))).toHaveProperty('text');
    expect(context.deliveries.get(row.id)).toMatchObject({
      status: 'delivered',
      format: 'slack',
      attempts: 1,
      destinationHash: destinationHash(context.settings.get().notifications.webhook),
    });
    expect(
      (
        context.db
          .prepare('SELECT COUNT(*) AS count FROM budget_alert_deliveries')
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  it('no-ops pending rows and refuses delivered or guarded rows without mutating them', () => {
    const context = setup({ send: sender(() => ok()).send });
    const record = addAlert(context.alerts);
    const pending = enqueueWebhook(context, record);

    expect(context.notifier.resend(pending.id)).toMatchObject({ ok: true });
    expect(context.deliveries.get(pending.id)).toMatchObject({ status: 'pending', attempts: 0 });

    const delivered = enqueueWebhook(
      context,
      addAlert(context.alerts, { threshold: 'exceeded' }),
    );
    context.deliveries.markDelivered(delivered.id, NOW);
    expect(context.notifier.resend(delivered.id)).toEqual({
      ok: false,
      reason: 'already_delivered',
    });

    const acknowledgedRecord = addAlert(context.alerts, { alertAtPercent: 70 });
    const acknowledged = enqueueWebhook(context, acknowledgedRecord);
    context.deliveries.markFailed(acknowledged.id, NOW, 'HTTP 503');
    context.alerts.acknowledge(acknowledgedRecord.id, NOW);
    expect(context.notifier.resend(acknowledged.id)).toEqual({
      ok: false,
      reason: 'alert_acknowledged',
    });
    expect(context.deliveries.get(acknowledged.id)).toMatchObject({
      status: 'failed',
      attempts: 0,
    });

    const priorRecord = addAlert(context.alerts, {
      alertAtPercent: 60,
      periodStart: PERIOD.start - 1,
    });
    const prior = enqueueWebhook(context, priorRecord);
    context.deliveries.markFailed(prior.id, NOW, 'HTTP 503');
    expect(context.notifier.resend(prior.id)).toEqual({
      ok: false,
      reason: 'not_current_period',
    });

    context.settings.patch({ notifications: { webhook: { enabled: false } } });
    const disabled = enqueueWebhook(
      context,
      addAlert(context.alerts, { alertAtPercent: 50 }),
    );
    context.deliveries.markFailed(disabled.id, NOW, 'HTTP 503');
    expect(context.notifier.resend(disabled.id)).toEqual({
      ok: false,
      reason: 'channel_disabled',
    });

    expect(context.notifier.resend('missing')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('resends email through the current SMTP settings', async () => {
    const fake = sender(() => ok());
    const mail = emailSender();
    const context = setup({ send: fake.send, sendEmail: mail.send, email: {} });
    const record = addAlert(context.alerts);
    const email = context.settings.get().notifications.email;
    const row = context.deliveries.enqueue({
      alertId: record.id,
      channel: 'email',
      format: 'email',
      destinationHash: emailDestinationHash(email),
      now: NOW,
    });
    context.deliveries.markFailed(row.id, NOW, 'eauth');
    context.settings.patch({
      notifications: { email: { username: 'aps', password: 'new-secret' } },
    });

    expect(context.notifier.resend(row.id)).toMatchObject({ ok: true });
    await context.notifier.flush();

    expect(mail.calls).toHaveLength(1);
    expect(context.deliveries.get(row.id)).toMatchObject({
      status: 'delivered',
      destinationHash: emailDestinationHash(context.settings.get().notifications.email),
    });
  });

  it('reports a sanitized resend failure and returns internal', () => {
    const errors = { error: vi.fn() };
    const context = setup({
      send: sender(() => ok()).send,
      errors: errors as unknown as ErrorSink,
    });
    const record = addAlert(context.alerts);
    const row = enqueueWebhook(context, record);
    context.deliveries.markFailed(row.id, NOW, 'HTTP 503');
    vi.spyOn(context.deliveries, 'resetForResend').mockImplementation(() => {
      throw new Error('database exploded at hooks.example.test');
    });

    expect(context.notifier.resend(row.id)).toEqual({ ok: false, reason: 'internal' });
    expect(errors.error).toHaveBeenCalledWith(
      'budget.notify',
      expect.any(Error),
      expect.objectContaining({
        phase: 'resend',
        deliveryId: row.id,
        alertId: record.id,
        channel: 'webhook',
      }),
    );
    const logged = JSON.stringify(errors.error.mock.calls);
    expect(logged).not.toContain('database exploded');
    expect(logged).not.toContain('hooks.example.test');
  });
});
  it('delivers Slack and Discord alerts once per destination', async () => {
    const fake = sender((sent) =>
      sent.url.includes('slack.com')
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(null, { status: 204 }),
    );
    const context = setup({ send: fake.send, webhook: { enabled: false }, slack: {}, discord: {} });
    const record = addAlert(context.alerts);

    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(2);
    const slack = fake.calls.find((call) => call.url.includes('slack.com'))!;
    const slackBody = parseBody(slack);
    expect(slackBody).toMatchObject({
      channel: 'C0123456789',
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      link_names: false,
    });
    expect(String(slackBody.text)).toContain('Overall spend reached 80%');
    expect(new Headers(slack.init.headers).get('authorization')).toBe(
      'Bearer xoxb-0123456789abcdef',
    );

    const discord = fake.calls.find((call) => call.url.includes('discord.com'))!;
    const discordBody = parseBody(discord);
    expect(discordBody).toMatchObject({
      content: expect.stringContaining('Overall spend reached 80%'),
      allowed_mentions: { parse: [] },
    });
    expect(new Headers(discord.init.headers).get('authorization')).toBe(
      'Bot discord-0123456789abcdef',
    );
    expect(context.deliveries.getForAlert(record.id, 'slack:C0123456789')).toMatchObject({
      status: 'delivered',
      destinationId: 'slack:C0123456789',
    });
    expect(
      context.deliveries.getForAlert(record.id, 'discord:123456789012345678').status,
    ).toBe('delivered');

    await context.notifier.flush();
    expect(fake.calls).toHaveLength(2);

    const status = context.notifier.status();
    expect(status.slack).toMatchObject({ enabled: true, configured: true, pending: 0 });
    expect(status.slack.destinations[0]).toMatchObject({
      channelId: 'C0123456789',
      label: 'Ops',
      pending: 0,
      failed: 0,
    });
    expect(status.discord.destinations[0]?.lastDeliveryStatus).toBe('delivered');
  });

  it('routes cell alerts and falls back to the default destination', async () => {
    const fake = sender(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const context = setup({
      send: fake.send,
      webhook: { enabled: false },
      slack: { routes: [{ cellId: 'cell-a', channelId: 'C9876543210' }] },
    });
    const routed = addAlert(context.alerts, { scope: 'cell', scopeId: 'cell-a' });
    context.notifier.observe([asAlert(routed, 'Cell A')]);
    await context.notifier.flush();
    expect(parseBody(fake.calls[0]!).channel).toBe('C9876543210');

    const fallback = addAlert(context.alerts, { scope: 'cell', scopeId: 'cell-b' });
    context.notifier.observe([asAlert(fallback, 'Cell B')]);
    await context.notifier.flush();
    expect(parseBody(fake.calls[1]!).channel).toBe('C0123456789');
  });

  it('classifies Slack errors and Discord rate limits', async () => {
    const permanent = sender(
      () =>
        new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), {
          status: 200,
        }),
    );
    const slack = setup({ send: permanent.send, webhook: { enabled: false }, slack: {} });
    const failed = addAlert(slack.alerts);
    slack.notifier.observe([asAlert(failed)]);
    await slack.notifier.flush();
    expect(slack.deliveries.getForAlert(failed.id, 'slack:C0123456789')).toMatchObject({
      status: 'failed',
      lastError: 'slack_not_in_channel',
    });

    const transient = sender(
      () =>
        new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 200,
        }),
    );
    const retry = setup({ send: transient.send, webhook: { enabled: false }, slack: {} });
    const throttled = addAlert(retry.alerts);
    retry.notifier.observe([asAlert(throttled)]);
    await retry.notifier.flush();
    expect(retry.deliveries.getForAlert(throttled.id, 'slack:C0123456789')).toMatchObject({
      status: 'pending',
      lastError: 'slack_ratelimited',
      nextAttemptAt: NOW + 60_000,
    });

    const discord = sender(
      () => new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
    );
    const limited = setup({ send: discord.send, webhook: { enabled: false }, discord: {} });
    const record = addAlert(limited.alerts);
    limited.notifier.observe([asAlert(record)]);
    await limited.notifier.flush();
    expect(
      limited.deliveries.getForAlert(record.id, 'discord:123456789012345678'),
    ).toMatchObject({
      status: 'pending',
      lastError: 'HTTP 429',
      nextAttemptAt: NOW + 1_500,
    });
  });

  it('skips chat rows when the provider is disabled or the destination changes', async () => {
    const fake = sender(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const context = setup({ send: fake.send, webhook: { enabled: false }, slack: {} });
    const record = addAlert(context.alerts);
    context.deliveries.enqueue({
      alertId: record.id,
      channel: 'slack',
      destinationId: 'slack:C0123456789',
      format: 'chat',
      destinationHash: chatDestinationHash(
        'slack',
        context.settings.get().notifications.slack,
        'C0123456789',
      ),
      now: NOW,
    });

    context.settings.patch({
      notifications: { slack: { defaultChannelId: 'C9876543210' } },
    });
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(0);
    expect(context.deliveries.getForAlert(record.id, 'slack:C0123456789').status).toBe(
      'skipped',
    );

    const disabled = setup({ send: fake.send, webhook: { enabled: false }, slack: {} });
    const second = addAlert(disabled.alerts);
    disabled.deliveries.enqueue({
      alertId: second.id,
      channel: 'slack',
      destinationId: 'slack:C0123456789',
      format: 'chat',
      destinationHash: chatDestinationHash(
        'slack',
        disabled.settings.get().notifications.slack,
        'C0123456789',
      ),
      now: NOW,
    });
    disabled.settings.patch({ notifications: { slack: { enabled: false } } });
    await disabled.notifier.flush();
    expect(fake.calls).toHaveLength(0);
    expect(
      disabled.deliveries.getForAlert(second.id, 'slack:C0123456789').status,
    ).toBe('skipped');
  });

  it('sends chat test messages without writing durable rows', async () => {
    const fake = sender((sent) =>
      sent.url.includes('slack.com')
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(null, { status: 204 }),
    );
    const context = setup({ send: fake.send, webhook: { enabled: false }, slack: {}, discord: {} });

    const slack = await context.notifier.testSlack();
    const discord = await context.notifier.testDiscord();
    expect(slack).toMatchObject({ ok: true, status: 200, durationMs: 0 });
    expect(discord).toMatchObject({ ok: true, status: 204, durationMs: 0 });
    expect(String(parseBody(fake.calls[0]!).text)).toMatch(/^Test budget alert/);
    expect(String(parseBody(fake.calls[1]!).content)).toMatch(/^Test budget alert/);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS count FROM budget_alerts').get() as {
        count: number;
      }).count,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS count FROM budget_alert_deliveries').get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it('omits the usage link for a loopback brain URL', async () => {
    const fake = sender(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const context = setup({
      send: fake.send,
      webhook: { enabled: false },
      slack: {},
      brainUrl: 'http://127.0.0.1:7391',
    });
    const record = addAlert(context.alerts);
    context.notifier.observe([asAlert(record)]);
    await context.notifier.flush();
    expect(String(parseBody(fake.calls[0]!).text)).not.toContain('Usage:');
  });

it('merges operational events into history with filters and pagination', () => {
  const context = setup({ send: sender(() => ok()).send });
  const budget = context.settings.get().notifications.webhook;
  const firstAlert = addAlert(context.alerts);
  const firstBudget = context.deliveries.enqueue({
    alertId: firstAlert.id,
    channel: 'webhook',
    format: 'json',
    destinationHash: destinationHash(budget),
    now: NOW - 4_000,
  });
  const secondAlert = addAlert(context.alerts, { alertAtPercent: 70 });
  const secondBudget = context.deliveries.enqueue({
    alertId: secondAlert.id,
    channel: 'webhook',
    format: 'json',
    destinationHash: destinationHash(budget),
    now: NOW - 2_000,
  });
  const turn: TurnFailureNotification = {
    turnId: 'turn-1',
    requestId: 'req-1',
    requestTitle: 'Fix the parser',
    state: 'implement',
    cellId: null,
    harness: 'opencode',
    model: null,
    source: 'engine.exit',
    reason: 'process exited with code 1',
    occurredAt: NOW - 3_000,
  };
  const firstEvent = context.events.enqueue({
    dedupeKey: 'turn:req-1:engine.exit:process_exited_with_code_1:1',
    kind: 'turn.failed',
    channel: 'webhook',
    format: 'json',
    destinationHash: destinationHash(budget),
    payloadJson: JSON.stringify(turn),
    now: NOW - 3_000,
  });
  const secondEvent = context.events.enqueue({
    dedupeKey: 'turn:req-2:engine.exit:process_exited_with_code_1:1',
    kind: 'turn.failed',
    channel: 'webhook',
    format: 'json',
    destinationHash: destinationHash(budget),
    payloadJson: JSON.stringify({ ...turn, requestId: 'req-2' }),
    now: NOW - 1_000,
  });

  const all = context.notifier.history({ limit: 10, offset: 0 });
  expect(all.total).toBe(4);
  expect(all.deliveries.map((row) => row.id)).toEqual([
    secondEvent.id,
    secondBudget.id,
    firstEvent.id,
    firstBudget.id,
  ]);
  expect(all.deliveries[0]).toMatchObject({ source: 'event' });
  expect(all.deliveries[1]).toMatchObject({ source: 'budget' });

  expect(context.notifier.history({ source: 'budget' })).toMatchObject({ total: 2 });
  expect(context.notifier.history({ source: 'event' })).toMatchObject({ total: 2 });
  expect(context.notifier.history({ kind: 'turn.failed' }).deliveries).toHaveLength(2);
  expect(context.notifier.history({ alertId: firstAlert.id }).deliveries).toHaveLength(1);
  expect(
    context.notifier.history({ offset: 1, limit: 2 }).deliveries.map((row) => row.id),
  ).toEqual([secondBudget.id, firstEvent.id]);
});
