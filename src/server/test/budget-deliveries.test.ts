import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { budgetPeriod } from '../src/domain/budget.js';
import {
  BudgetAlertRepository,
  type BudgetAlertInput,
  type BudgetAlertRecord,
} from '../src/usage/budget-alerts.js';
import {
  BudgetAlertDeliveryRepository,
  type DeliveryHistoryFilter,
} from '../src/usage/budget-deliveries.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const PERIOD = budgetPeriod(NOW);

function setup(): {
  db: Db;
  alerts: BudgetAlertRepository;
  deliveries: BudgetAlertDeliveryRepository;
} {
  const db = openDb(':memory:');
  return {
    db,
    alerts: new BudgetAlertRepository(db),
    deliveries: new BudgetAlertDeliveryRepository(db),
  };
}

function addAlert(
  alerts: BudgetAlertRepository,
  overrides: Partial<BudgetAlertInput> = {},
  now = NOW,
): BudgetAlertRecord {
  return alerts.upsert(
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
    now,
  );
}

function enqueue(
  deliveries: BudgetAlertDeliveryRepository,
  alert: BudgetAlertRecord,
  options: {
    channel?: 'webhook' | 'email';
    format?: 'json' | 'slack' | 'discord' | 'email';
    hash?: string;
    now?: number;
  } = {},
) {
  const channel = options.channel ?? 'webhook';
  return deliveries.enqueue({
    alertId: alert.id,
    channel,
    format: options.format ?? (channel === 'email' ? 'email' : 'json'),
    destinationHash: options.hash ?? 'hash-a',
    now: options.now ?? NOW,
  });
}

function filter(overrides: Partial<DeliveryHistoryFilter> = {}): DeliveryHistoryFilter {
  return { limit: 10, offset: 0, ...overrides };
}

describe('BudgetAlertDeliveryRepository history', () => {
  it('lists newest first and joins the alert fields', () => {
    const { db, alerts, deliveries } = setup();
    const first = addAlert(alerts);
    const second = addAlert(alerts, {
      scope: 'cell',
      scopeId: 'cell-1',
      threshold: 'exceeded',
      spendUsd: 110,
    });
    enqueue(deliveries, first, { now: NOW - 2_000 });
    enqueue(deliveries, second, { now: NOW, format: 'slack' });

    const rows = deliveries.listFiltered(filter());

    expect(rows.map((row) => row.delivery.alertId)).toEqual([second.id, first.id]);
    expect(rows[0]?.alert).toEqual({
      scope: 'cell',
      scopeId: 'cell-1',
      threshold: 'exceeded',
      alertAtPercent: 80,
      budgetUsd: 100,
      spendUsd: 110,
      unknownCostTurns: 0,
      periodStart: PERIOD.start,
      createdAt: NOW,
      acknowledgedAt: null,
    });
    expect(rows[0]?.delivery.format).toBe('slack');
    expect(rows[1]?.delivery.format).toBe('json');
    expect(deliveries.countFiltered(filter())).toBe(2);
    db.close();
  });

  it('filters by channel, status, alert, and created date', () => {
    const { db, alerts, deliveries } = setup();
    const first = addAlert(alerts);
    const second = addAlert(alerts, { threshold: 'exceeded' });
    const webhook = enqueue(deliveries, first, { now: 1_000 });
    const email = enqueue(deliveries, first, {
      channel: 'email',
      format: 'email',
      now: 2_000,
    });
    const secondWebhook = enqueue(deliveries, second, { now: 3_000 });
    deliveries.markFailed(webhook.id, NOW, 'HTTP 503');

    expect(deliveries.listFiltered(filter({ channel: 'email' }))).toHaveLength(1);
    expect(
      deliveries
        .listFiltered(filter({ channel: 'webhook' }))
        .map((row) => row.delivery.id),
    ).toEqual([secondWebhook.id, webhook.id]);
    expect(deliveries.listFiltered(filter({ status: 'failed' })).map((row) => row.delivery.id))
      .toEqual([webhook.id]);
    expect(deliveries.listFiltered(filter({ alertId: first.id }))).toHaveLength(2);
    expect(deliveries.listFiltered(filter({ from: 2_000, to: 3_000 }))).toHaveLength(1);
    expect(deliveries.listFiltered(filter({ from: 2_000, to: 3_000 }))[0]?.delivery.id).toBe(
      email.id,
    );
    expect(deliveries.countFiltered(filter({ alertId: first.id }))).toBe(2);
    db.close();
  });

  it('paginates while total ignores limit and offset', () => {
    const { db, alerts, deliveries } = setup();
    for (let index = 0; index < 3; index += 1) {
      const alert = addAlert(alerts, { alertAtPercent: 60 + index });
      enqueue(deliveries, alert, { now: NOW + index });
    }

    const page = deliveries.listFiltered(filter({ limit: 1, offset: 1 }));

    expect(page).toHaveLength(1);
    expect(deliveries.countFiltered(filter({ limit: 1, offset: 1 }))).toBe(3);
    expect(page[0]?.delivery.createdAt).toBe(NOW + 1);
    db.close();
  });

  it('cascades history rows when the alert is deleted', () => {
    const { db, alerts, deliveries } = setup();
    const alert = addAlert(alerts);
    enqueue(deliveries, alert);

    db.prepare('DELETE FROM budget_alerts WHERE id = ?').run(alert.id);

    expect(deliveries.listFiltered(filter())).toEqual([]);
    expect(deliveries.countFiltered(filter())).toBe(0);
    db.close();
  });
});

describe('BudgetAlertDeliveryRepository resend reset', () => {
  it('resets a failed row under the current destination', () => {
    const { db, alerts, deliveries } = setup();
    const alert = addAlert(alerts);
    const row = enqueue(deliveries, alert);
    deliveries.markDelivering(row.id, NOW);
    deliveries.markFailed(row.id, NOW, 'HTTP 503');

    const reset = deliveries.resetForResend(row.id, {
      format: 'slack',
      destinationHash: 'hash-b',
      now: NOW + 100,
    });

    expect(reset).toMatchObject({
      id: row.id,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW + 100,
      updatedAt: NOW + 100,
      deliveredAt: null,
      format: 'slack',
      destinationHash: 'hash-b',
      lastError: 'HTTP 503',
    });
    db.close();
  });

  it('resets a skipped row but not a delivered or pending one', () => {
    const { db, alerts, deliveries } = setup();
    const alert = addAlert(alerts);
    const skipped = enqueue(deliveries, alert, { channel: 'webhook' });
    deliveries.markSkipped(skipped.id, NOW);

    expect(
      deliveries.resetForResend(skipped.id, {
        format: 'json',
        destinationHash: 'hash-a',
        now: NOW,
      }),
    ).toMatchObject({ status: 'pending', attempts: 0 });

    const delivered = enqueue(deliveries, alert, { channel: 'email' });
    deliveries.markDelivered(delivered.id, NOW);
    expect(
      deliveries.resetForResend(delivered.id, {
        format: 'email',
        destinationHash: 'hash-a',
        now: NOW,
      }),
    ).toBeNull();
    expect(deliveries.get(delivered.id)?.status).toBe('delivered');

    const pending = enqueue(deliveries, alert, { now: NOW + 1 });
    expect(
      deliveries.resetForResend(pending.id, {
        format: 'json',
        destinationHash: 'hash-a',
        now: NOW,
      }),
    ).toBeNull();
    expect(deliveries.get(pending.id)?.status).toBe('pending');
    expect(
      deliveries.resetForResend('missing', {
        format: 'json',
        destinationHash: 'hash-a',
        now: NOW,
      }),
    ).toBeNull();
    db.close();
  });
});
