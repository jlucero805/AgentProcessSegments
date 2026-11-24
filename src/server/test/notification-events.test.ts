import { createHmac } from 'node:crypto';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb, type Db } from '../src/db.js';
import type { EmailSettings } from '../src/domain/budget.js';
import type {
  MasterErrorNotification,
  TurnFailureNotification,
} from '../src/domain/notifications.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { NotificationEventDeliveryRepository } from '../src/notifications/event-deliveries.js';
import { NotificationService, type FetchLike } from '../src/notifications/service.js';
import { SettingsStore } from '../src/settings.js';
import { BudgetAlertRepository } from '../src/usage/budget-alerts.js';
import { BudgetAlertDeliveryRepository } from '../src/usage/budget-deliveries.js';
import type { EmailMessage, EmailSendLike } from '../src/usage/budget-email.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const HOUR = 60 * 60_000;

const EMAIL: EmailSettings = {
  enabled: true,
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  username: null,
  password: null,
  from: 'alerts@example.test',
  to: ['ops@example.test'],
};

const TURN: TurnFailureNotification = {
  turnId: 'turn-1',
  requestId: 'req-1',
  requestTitle: 'Fix the parser',
  state: 'implement',
  cellId: 'cell-1',
  harness: 'opencode',
  model: 'model-1',
  source: 'engine.exit',
  reason: 'process exited with code 1',
  occurredAt: NOW,
};

const MASTER: MasterErrorNotification = {
  source: 'master.cycle',
  cellId: 'cell-1',
  requestId: null,
  segment: null,
  occurredAt: NOW,
};

interface Sent {
  url: string;
  init: RequestInit;
}

function sender(handler: (call: number, init: RequestInit) => Response | Promise<Response>): {
  calls: Sent[];
  send: FetchLike;
} {
  const calls: Sent[] = [];
  return {
    calls,
    send: async (url, init = {}) => {
      calls.push({ url, init });
      return handler(calls.length, init);
    },
  };
}

function makeClock(start = NOW): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

interface SetupOptions {
  send?: FetchLike;
  sendEmail?: EmailSendLike;
  webhook?: Record<string, unknown>;
  email?: Partial<EmailSettings>;
  failedTurns?: { webhook?: boolean; email?: boolean };
  masterErrors?: { webhook?: boolean; email?: boolean };
  timeoutMs?: number;
  maxAttempts?: number;
  errors?: ErrorSink;
  clock?: ReturnType<typeof makeClock>;
}

function setup(options: SetupOptions) {
  const db: Db = openDb(':memory:');
  const cells = new CellRepository(db);
  const cell = cells.create('Acme');
  const dir = tmpDir('events');
  const settings = new SettingsStore(path.join(dir, 'config.json'));
  settings.patch({
    notifications: {
      webhook: {
        enabled: true,
        url: 'https://hooks.example.test/events',
        format: 'json',
        secret: null,
        ...options.webhook,
      },
      ...(options.email ? { email: { ...EMAIL, ...options.email } } : {}),
      events: {
        failedTurns: { webhook: false, email: false, ...options.failedTurns },
        masterErrors: { webhook: false, email: false, ...options.masterErrors },
      },
    },
  });
  const clock = options.clock ?? makeClock();
  const events = new NotificationEventDeliveryRepository(db);
  const notifier = new NotificationService({
    deliveries: new BudgetAlertDeliveryRepository(db),
    events,
    alerts: new BudgetAlertRepository(db),
    cells,
    settings,
    send: options.send ?? (async () => new Response(null, { status: 204 })),
    ...(options.sendEmail ? { sendEmail: options.sendEmail } : {}),
    now: clock.now,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.errors ? { errors: options.errors } : {}),
  });
  return { db, cells, cellId: cell.id, settings, events, clock, notifier };
}

function bodyOf(sent: Sent): Record<string, unknown> {
  return JSON.parse(String(sent.init.body)) as Record<string, unknown>;
}

describe('notification event deliveries', () => {
  it('enqueues only routed channels and dedupes one signature per hour', async () => {
    const fake = sender(() => new Response(null, { status: 204 }));
    const context = setup({
      send: fake.send,
      failedTurns: { webhook: true },
    });

    context.notifier.observeTurnFailure(TURN);
    context.notifier.observeTurnFailure({ ...TURN, turnId: 'turn-2' });

    expect(context.events.status('turn.failed')).toMatchObject({ pending: 1, failed: 0 });
    expect(context.events.status('master.error').pending).toBe(0);

    await context.notifier.flush();
    expect(fake.calls).toHaveLength(1);

    context.clock.advance(HOUR);
    context.notifier.observeTurnFailure({ ...TURN, turnId: 'turn-3', occurredAt: NOW + HOUR });
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(2);
    expect(context.notifier.status().events).toMatchObject({
      pending: 0,
      failed: 0,
      byKind: {
        'turn.failed': { pending: 0, failed: 0 },
        'master.error': { pending: 0, failed: 0 },
      },
    });
  });

  it('sends a signed JSON envelope with a safe classification only', async () => {
    const fake = sender(() => new Response(null, { status: 204 }));
    const context = setup({
      send: fake.send,
      webhook: { secret: '0123456789abcdef' },
      failedTurns: { webhook: true },
    });

    context.notifier.observeTurnFailure({ ...TURN, cellId: context.cellId });
    await context.notifier.flush();

    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0]!;
    const headers = sent.init.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('aps-notify/1');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['idempotency-key']).toMatch(/^turn:req-1:engine\.exit:/);
    expect(headers['x-aps-signature']).toBe(
      `sha256=${createHmac('sha256', '0123456789abcdef')
        .update(String(sent.init.body))
        .digest('hex')}`,
    );
    expect(sent.init.redirect).toBe('manual');

    const body = bodyOf(sent);
    expect(body).toMatchObject({
      version: 1,
      event: 'turn.failed',
      severity: 'error',
      title: 'Turn failed: Fix the parser',
      text: 'Turn failed for "Fix the parser" in implement, Acme: process exited with code 1.',
    });
    expect(body.turn).toMatchObject({
      turnId: 'turn-1',
      requestId: 'req-1',
      source: 'engine.exit',
      reason: 'process exited with code 1',
    });
    expect(JSON.stringify(body)).not.toContain('stderr');
  });

  it('uses Slack and Discord text-only bodies', async () => {
    const slackFake = sender(() => new Response(null, { status: 204 }));
    const slack = setup({
      send: slackFake.send,
      webhook: { format: 'slack' },
      failedTurns: { webhook: true },
    });
    slack.notifier.observeTurnFailure({ ...TURN, cellId: slack.cellId });
    await slack.notifier.flush();
    expect(bodyOf(slackFake.calls[0]!)).toEqual({
      text: 'Turn failed for "Fix the parser" in implement, Acme: process exited with code 1.',
    });

    const discordFake = sender(() => new Response(null, { status: 204 }));
    const discord = setup({
      send: discordFake.send,
      webhook: { format: 'discord' },
      masterErrors: { webhook: true },
    });
    discord.notifier.observeMasterError({ ...MASTER, cellId: discord.cellId });
    await discord.notifier.flush();
    expect(bodyOf(discordFake.calls[0]!)).toEqual({
      content: 'Master cycle failed for cell "Acme".',
    });
  });

  it('sends email for a routed event kind', async () => {
    const messages: EmailMessage[] = [];
    const sendEmail: EmailSendLike = async (_email, message) => {
      messages.push(message);
    };
    const context = setup({
      sendEmail,
      email: {},
      masterErrors: { email: true },
    });

    context.notifier.observeMasterError({ ...MASTER, cellId: context.cellId });
    await context.notifier.flush();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      to: ['ops@example.test'],
      subject: '[APS] Master error: Acme',
      eventKind: 'master.error',
    });
    expect(messages[0]?.eventId).toMatch(
      new RegExp(`^master:${context.cellId}:master\\.cycle:`),
    );
    expect(messages[0]?.text).toContain('Master cycle failed for cell "Acme".');
    expect(messages[0]?.text).toContain(`Cell: ${context.cellId}`);
  });

  it('retries transient failures, honors Retry-After, and fails permanent rows', async () => {
    const retryFake = sender((call) =>
      call === 1
        ? new Response(null, { status: 500, headers: { 'retry-after': '90' } })
        : new Response(null, { status: 204 }),
    );
    const retry = setup({ send: retryFake.send, failedTurns: { webhook: true } });
    retry.notifier.observeTurnFailure(TURN);
    await retry.notifier.flush();
    expect(retry.events.status('turn.failed').pending).toBe(1);

    const row = retry.db
      .prepare('SELECT next_attempt_at FROM notification_event_deliveries')
      .get() as { next_attempt_at: number };
    expect(row.next_attempt_at).toBe(NOW + 90_000);
    retry.clock.advance(90_000);
    await retry.notifier.flush();
    expect(retryFake.calls).toHaveLength(2);
    expect(retry.events.status('turn.failed')).toMatchObject({ pending: 0, failed: 0 });

    const permanentFake = sender(() => new Response(null, { status: 404 }));
    const permanent = setup({ send: permanentFake.send, failedTurns: { webhook: true } });
    permanent.notifier.observeTurnFailure(TURN);
    await permanent.notifier.flush();
    expect(permanentFake.calls).toHaveLength(1);
    expect(permanent.events.status('turn.failed').failed).toBe(1);
  });

  it('exhausts attempts and aborts a hanging send', async () => {
    const alwaysFail = sender(() => new Response(null, { status: 503 }));
    const exhausted = setup({
      send: alwaysFail.send,
      failedTurns: { webhook: true },
      maxAttempts: 2,
    });
    exhausted.notifier.observeTurnFailure(TURN);
    await exhausted.notifier.flush();
    exhausted.clock.advance(60_000);
    await exhausted.notifier.flush();
    expect(alwaysFail.calls).toHaveLength(2);
    expect(exhausted.events.status('turn.failed').failed).toBe(1);

    const hanging = setup({
      send: () => new Promise<Response>(() => {}),
      failedTurns: { webhook: true },
      timeoutMs: 10,
    });
    hanging.notifier.observeTurnFailure(TURN);
    await hanging.notifier.flush();
    expect(hanging.events.status('turn.failed').pending).toBe(1);
    const row = hanging.db
      .prepare('SELECT last_error FROM notification_event_deliveries')
      .get() as { last_error: string };
    expect(row.last_error).toBe('timeout');
  });

  it('skips disabled routes and stale destinations', async () => {
    const fake = sender(() => new Response(null, { status: 204 }));
    const context = setup({ send: fake.send, failedTurns: { webhook: true } });
    context.notifier.observeTurnFailure(TURN);
    context.settings.patch({ notifications: { events: { failedTurns: { webhook: false } } } });
    await context.notifier.flush();
    expect(fake.calls).toHaveLength(0);
    expect(context.events.status('turn.failed').pending).toBe(0);

    const rotated = setup({ send: fake.send, failedTurns: { webhook: true } });
    rotated.notifier.observeTurnFailure(TURN);
    rotated.settings.patch({
      notifications: { webhook: { url: 'https://hooks.example.test/rotated' } },
    });
    await rotated.notifier.flush();
    expect(fake.calls).toHaveLength(0);
    const row = rotated.db
      .prepare('SELECT status FROM notification_event_deliveries')
      .get() as { status: string };
    expect(row.status).toBe('skipped');
  });

  it('resets stale rows on start and prunes old rows', async () => {
    const fake = sender(() => new Response(null, { status: 204 }));
    const context = setup({ send: fake.send, failedTurns: { webhook: true } });
    context.notifier.observeTurnFailure(TURN);
    const row = context.db
      .prepare('SELECT id FROM notification_event_deliveries')
      .get() as { id: string };
    context.events.markDelivering(row.id, NOW);
    context.notifier.start();
    context.notifier.stop();
    expect(context.events.get(row.id)?.status).toBe('pending');

    const old = context.db
      .prepare('UPDATE notification_event_deliveries SET created_at = ?')
      .run(NOW - 401 * 24 * HOUR);
    expect(old.changes).toBe(1);
    context.notifier.start();
    context.notifier.stop();
    expect(context.events.get(row.id)).toBeNull();
  });

  it('reports only ids and a short reason when a send fails', async () => {
    const errors = vi.fn();
    const context = setup({
      send: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED secret-token'), {
          cause: { code: 'ECONNREFUSED' },
        });
      },
      failedTurns: { webhook: true },
      errors: { error: errors },
    });

    context.notifier.observeTurnFailure(TURN);
    await context.notifier.flush();

    expect(errors).toHaveBeenCalledTimes(1);
    const [source, error, details] = errors.mock.calls[0]! as [
      string,
      Error,
      Record<string, unknown>,
    ];
    expect(source).toBe('notifications.event');
    expect(error.message).toBe('ECONNREFUSED');
    expect(details).toMatchObject({
      kind: 'turn.failed',
      turnId: 'turn-1',
      requestId: 'req-1',
      channel: 'webhook',
    });
    expect(JSON.stringify(details)).not.toContain('secret-token');
    expect(JSON.stringify(details)).not.toContain('hooks.example.test');
  });
});
