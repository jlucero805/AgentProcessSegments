import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb, type Db } from '../src/db.js';
import {
  budgetPeriod,
  type BudgetAlert,
  type WebhookSettings,
} from '../src/domain/budget.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { SettingsStore } from '../src/settings.js';
import {
  BudgetAlertRepository,
  type BudgetAlertInput,
  type BudgetAlertRecord,
} from '../src/usage/budget-alerts.js';
import { BudgetAlertDeliveryRepository } from '../src/usage/budget-deliveries.js';
import {
  BudgetNotifier,
  destinationHash,
  type FetchLike,
} from '../src/usage/budget-notifier.js';

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-notifier-'));
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
    },
  });
  const clock = options.clock ?? makeClock();
  const notifier = new BudgetNotifier({
    deliveries,
    alerts,
    cells,
    settings,
    send: options.send,
    now: clock.now,
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.errors ? { errors: options.errors } : {}),
  });
  return { db, cells, alerts, deliveries, settings, clock, notifier };
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

describe('BudgetNotifier', () => {
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

  it('recovers stale rows and prunes old deliveries on start', async () => {
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

    context.notifier.start();
    await context.notifier.flush();
    context.notifier.stop();

    expect(context.deliveries.getForAlert(record.id).status).toBe('delivered');
    expect(context.deliveries.get(oldDelivery.id)).toBeNull();
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
