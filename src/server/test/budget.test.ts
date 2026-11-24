import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb } from '../src/db.js';
import {
  budgetAlertSubject,
  budgetAlertText,
  budgetEmailText,
  budgetPeriod,
  emailAddressError,
  emailDeliveryConfigured,
  emailRecipientsError,
  isLoopbackSmtpHost,
  resendBlockReason,
  smtpHostError,
  type BudgetAlert,
  type BudgetUsageTotals,
  type EmailSettings,
} from '../src/domain/budget.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { SettingsStore } from '../src/settings.js';
import { BudgetAlertRepository } from '../src/usage/budget-alerts.js';
import { BudgetService } from '../src/usage/budgets.js';
import { UsageRepository } from '../src/usage/repository.js';
import { UsageRollups } from '../src/usage/rollups.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const PERIOD = budgetPeriod(NOW);

function emptyTotals(): BudgetUsageTotals {
  return {
    turns: 0,
    costUsd: null,
    estimatedCostUsd: null,
    unpricedTurns: 0,
    unknownCostTurns: 0,
  };
}

class FakeUsageSource {
  overall: BudgetUsageTotals = emptyTotals();
  cells = new Map<string, BudgetUsageTotals>();
  throwOnTotals = false;

  totals(filter: { cellId?: string }): BudgetUsageTotals {
    if (this.throwOnTotals) throw new Error('ledger unavailable');
    return filter.cellId ? this.cells.get(filter.cellId) ?? emptyTotals() : this.overall;
  }
}

function makeStore(): SettingsStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-budget-'));
  return new SettingsStore(path.join(dir, 'config.json'));
}

function makeService(
  usage: FakeUsageSource,
  settings = makeStore(),
  errors?: ErrorSink,
): {
  service: BudgetService;
  alerts: BudgetAlertRepository;
  cells: CellRepository;
  db: ReturnType<typeof openDb>;
  settings: SettingsStore;
} {
  const db = openDb(':memory:');
  const cells = new CellRepository(db);
  const alerts = new BudgetAlertRepository(db);
  const service = new BudgetService({
    usage,
    cells,
    settings,
    alerts,
    ...(errors ? { errors } : {}),
    now: () => NOW,
  });
  return { service, alerts, cells, db, settings };
}

describe('budgets', () => {
  it('uses UTC calendar month boundaries', () => {
    expect(budgetPeriod(Date.UTC(2026, 0, 31, 23, 59, 59, 999))).toEqual({
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 1, 1),
    });
    expect(budgetPeriod(Date.UTC(2026, 1, 1, 0, 0, 0, 0))).toEqual({
      start: Date.UTC(2026, 1, 1),
      end: Date.UTC(2026, 2, 1),
    });
  });

  it('formats alert text for the banner and outbound payloads', () => {
    const base: BudgetAlert = {
      id: 'a1',
      scope: 'overall',
      cellId: null,
      cellName: null,
      threshold: 'warning',
      alertAtPercent: 80,
      budgetUsd: 100,
      spendUsd: 85,
      unknownCostTurns: 0,
      periodStart: PERIOD.start,
      createdAt: NOW,
      acknowledgedAt: null,
    };
    expect(budgetAlertText(base)).toBe(
      'Overall spend reached 80% of its $100.00 monthly budget ($85.00).',
    );
    expect(budgetAlertText({ ...base, unknownCostTurns: 2, spendUsd: 81.25 })).toBe(
      'Overall spend reached 80% of its $100.00 monthly budget (at least $81.25).',
    );
    expect(
      budgetAlertText({
        ...base,
        scope: 'cell',
        cellId: 'c1',
        cellName: 'Alpha',
        threshold: 'exceeded',
        spendUsd: 110,
      }),
    ).toBe('Alpha is over its $100.00 monthly budget ($110.00).');
  });

  it('reports overall and cell statuses with known and unknown spend', () => {
    const usage = new FakeUsageSource();
    const { service, cells, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    const cell = cells.create('Alpha');
    cells.setMonthlyBudget(cell.id, 50);
    usage.overall = { turns: 4, costUsd: 85, unknownCostTurns: 1 };
    usage.cells.set(cell.id, { turns: 2, costUsd: 10, unknownCostTurns: 0 });

    const response = service.statuses(NOW);

    expect(response.periodStart).toBe(PERIOD.start);
    expect(response.statuses.map((status) => status.scope)).toEqual(['overall', 'cell']);
    expect(response.statuses[0]).toMatchObject({
      label: 'Overall',
      budgetUsd: 100,
      spendUsd: 85,
      percentUsed: 85,
      state: 'warning',
      pricedTurns: 3,
      unknownCostTurns: 1,
      spendIsLowerBound: true,
    });
    expect(response.statuses[1]).toMatchObject({
      cellId: cell.id,
      label: 'Alpha',
      spendUsd: 10,
      state: 'ok',
      spendIsLowerBound: false,
    });
  });

  it('holds at unknown when every turn is unpriced', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    usage.overall = { turns: 2, costUsd: null, unknownCostTurns: 2 };

    const status = service.statuses(NOW).statuses[0];
    expect(status?.state).toBe('unknown');
    expect(status?.spendUsd).toBe(0);
    expect(status?.spendIsLowerBound).toBe(true);

    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);
  });

  it('creates an idempotent warning and keeps lower-bound metadata', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    usage.overall = { turns: 3, costUsd: 85, unknownCostTurns: 1 };

    service.evaluate(NOW);
    const first = service.statuses(NOW).alerts;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      threshold: 'warning',
      alertAtPercent: 80,
      budgetUsd: 100,
      spendUsd: 85,
      unknownCostTurns: 1,
    });

    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts.map((alert) => alert.id)).toEqual([first[0]?.id]);
  });

  it('crosses on equality and supersedes warning when exceeded', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    usage.overall = { turns: 1, costUsd: 80, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts[0]?.threshold).toBe('warning');

    usage.overall = { turns: 1, costUsd: 100, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const alerts = service.statuses(NOW).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ threshold: 'exceeded', spendUsd: 100 });
  });

  it('never warns when alertAtPercent is 100', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 100 } });
    usage.overall = { turns: 1, costUsd: 99, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);

    usage.overall = { turns: 1, costUsd: 100, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts[0]?.threshold).toBe('exceeded');
  });

  it('acknowledges an alert, keeps history, and silences the same generation', () => {
    const usage = new FakeUsageSource();
    const { service, alerts, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    usage.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const alert = service.statuses(NOW).alerts[0];
    expect(alert).toBeDefined();

    const acknowledged = service.acknowledge(alert!.id);
    expect(acknowledged?.acknowledgedAt).toBe(NOW);
    expect(service.acknowledge(alert!.id)?.acknowledgedAt).toBe(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);

    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);
    expect(alerts.get(alert!.id)?.acknowledgedAt).toBe(NOW);
  });

  it('does not show a warning after an exceeded alert was acknowledged', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    usage.overall = { turns: 1, costUsd: 120, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const exceeded = service.statuses(NOW).alerts[0]!;
    service.acknowledge(exceeded.id);

    usage.overall = { turns: 1, costUsd: 85, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);
  });

  it('starts a new alert generation when the budget or threshold changes', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    usage.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const first = service.statuses(NOW).alerts[0]!;
    service.acknowledge(first.id);

    settings.patch({ budget: { monthlyUsd: 200, alertAtPercent: 80 } });
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);

    usage.overall = { turns: 1, costUsd: 210, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const second = service.statuses(NOW).alerts[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.budgetUsd).toBe(200);

    settings.patch({ budget: { alertAtPercent: 90 } });
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts[0]?.alertAtPercent).toBe(90);
  });

  it('removes unacknowledged alerts when a budget is cleared or a cell is deleted', () => {
    const usage = new FakeUsageSource();
    const { service, cells, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    const cell = cells.create('Alpha');
    cells.setMonthlyBudget(cell.id, 50);
    usage.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    usage.cells.set(cell.id, { turns: 1, costUsd: 60, unknownCostTurns: 0 });
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toHaveLength(2);

    settings.patch({ budget: { monthlyUsd: null } });
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toHaveLength(1);
    expect(service.statuses(NOW).alerts[0]?.cellId).toBe(cell.id);

    cells.remove(cell.id);
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);
  });

  it('creates a new alert in the next month', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    usage.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const first = service.statuses(NOW).alerts[0]!;

    const nextMonth = Date.UTC(2026, 11, 2, 12);
    service.evaluate(nextMonth);
    const next = service.statuses(nextMonth).alerts[0]!;
    expect(next.periodStart).toBe(Date.UTC(2026, 11, 1));
    expect(next.id).not.toBe(first.id);
  });

  it('pauses on effective cap spend only when the scope opts in', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({
      budget: { monthlyUsd: 100, alertAtPercent: 80, pauseOnExceeded: true },
    });
    usage.overall = {
      turns: 2,
      costUsd: 80,
      estimatedCostUsd: 20,
      unpricedTurns: 0,
      unknownCostTurns: 1,
    };

    const status = service.statuses(NOW).statuses[0]!;
    expect(status.state).toBe('warning');
    expect(status.spendUsd).toBe(80);
    expect(status.capSpendUsd).toBe(100);
    expect(status.paused).toBe(true);
    expect(status.capSpendIsLowerBound).toBe(false);
    expect(service.statuses(NOW).pauses).toHaveLength(1);
    expect(service.admission(null, NOW)).toMatchObject({
      scope: 'overall',
      budgetUsd: 100,
      spendUsd: 100,
    });

    settings.patch({ budget: { pauseOnExceeded: false } });
    expect(service.statuses(NOW).pauses).toEqual([]);
    expect(service.admission(null, NOW)).toBeNull();
  });

  it('does not pause at the warning threshold', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({
      budget: { monthlyUsd: 100, alertAtPercent: 80, pauseOnExceeded: true },
    });
    usage.overall = {
      turns: 1,
      costUsd: 85,
      estimatedCostUsd: 0,
      unpricedTurns: 0,
      unknownCostTurns: 0,
    };

    const status = service.statuses(NOW).statuses[0]!;
    expect(status.state).toBe('warning');
    expect(status.paused).toBe(false);
    expect(service.admission(null, NOW)).toBeNull();
  });

  it('does not pause on an unknown or unpriced budget', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({
      budget: { monthlyUsd: 100, alertAtPercent: 80, pauseOnExceeded: true },
    });
    usage.overall = {
      turns: 2,
      costUsd: null,
      estimatedCostUsd: null,
      unpricedTurns: 2,
      unknownCostTurns: 2,
    };

    const status = service.statuses(NOW).statuses[0]!;
    expect(status.state).toBe('unknown');
    expect(status.paused).toBe(false);
    expect(status.capSpendIsLowerBound).toBe(true);
    expect(service.admission(null, NOW)).toBeNull();
  });

  it('scopes a cell pause and lets overall win', () => {
    const usage = new FakeUsageSource();
    const { service, cells, settings } = makeService(usage);
    const alpha = cells.create('Alpha');
    const beta = cells.create('Beta');
    cells.setMonthlyBudget(alpha.id, 50);
    cells.setMonthlyBudget(beta.id, 50);
    cells.setPauseOnExceeded(alpha.id, true);
    usage.cells.set(alpha.id, {
      turns: 1,
      costUsd: 50,
      estimatedCostUsd: 0,
      unpricedTurns: 0,
      unknownCostTurns: 0,
    });
    usage.cells.set(beta.id, {
      turns: 1,
      costUsd: 10,
      estimatedCostUsd: 0,
      unpricedTurns: 0,
      unknownCostTurns: 0,
    });

    expect(service.admission(alpha.id, NOW)).toMatchObject({ scope: 'cell', cellId: alpha.id });
    expect(service.admission(beta.id, NOW)).toBeNull();
    expect(service.statuses(NOW).pauses).toHaveLength(1);

    settings.patch({
      budget: { monthlyUsd: 100, alertAtPercent: 80, pauseOnExceeded: true },
    });
    usage.overall = {
      turns: 1,
      costUsd: 100,
      estimatedCostUsd: 0,
      unpricedTurns: 0,
      unknownCostTurns: 0,
    };
    expect(service.admission(alpha.id, NOW)).toMatchObject({ scope: 'overall' });
    expect(service.admission(beta.id, NOW)).toMatchObject({ scope: 'overall' });
  });

  it('does not let acknowledgement clear a pause and resumes in a new month', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    settings.patch({
      budget: { monthlyUsd: 100, alertAtPercent: 80, pauseOnExceeded: true },
    });
    usage.overall = {
      turns: 1,
      costUsd: 100,
      estimatedCostUsd: 0,
      unpricedTurns: 0,
      unknownCostTurns: 0,
    };
    service.evaluate(NOW);
    const alert = service.statuses(NOW).alerts[0]!;
    service.acknowledge(alert.id);
    expect(service.statuses(NOW).alerts).toEqual([]);
    expect(service.admission(null, NOW)).not.toBeNull();

    usage.overall = emptyTotals();
    const nextMonth = Date.UTC(2026, 11, 2, 12);
    expect(service.admission(null, nextMonth)).toBeNull();
  });

  it('fails open when admission cannot read the ledger', () => {
    const usage = new FakeUsageSource();
    usage.throwOnTotals = true;
    const errors: ErrorSink = { error: vi.fn() };
    const { service, settings } = makeService(usage, makeStore(), errors);
    settings.patch({
      budget: { monthlyUsd: 100, alertAtPercent: 80, pauseOnExceeded: true },
    });

    expect(service.admission(null, NOW)).toBeNull();
    expect(errors.error).toHaveBeenCalledWith(
      'usage.budgets',
      expect.any(Error),
      expect.objectContaining({ phase: 'admission' }),
    );
  });

  it('reports evaluation failures without throwing', () => {
    const usage = new FakeUsageSource();
    usage.throwOnTotals = true;
    const errors: ErrorSink = { error: vi.fn() };
    const { service, settings } = makeService(usage, makeStore(), errors);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });

    expect(() => service.evaluate(NOW)).not.toThrow();
    expect(errors.error).toHaveBeenCalledWith(
      'usage.budgets',
      expect.any(Error),
      expect.objectContaining({ periodStart: PERIOD.start }),
    );
  });

  it('starts, reacts to settings changes, and stops idempotently', () => {
    const usage = new FakeUsageSource();
    const { service, settings } = makeService(usage);
    usage.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });

    service.start();
    expect(service.statuses(NOW).alerts).toHaveLength(1);
    service.stop();
    service.stop();

    service.start();
    settings.patch({ budget: { monthlyUsd: 50 } });
    expect(service.statuses(NOW).alerts[0]?.budgetUsd).toBe(50);
    service.stop();
  });
});

describe('budget totals from the usage repository', () => {
  it('keeps monthly reported cost after old days are rolled up and pruned', () => {
    const db = openDb(':memory:');
    const usage = new UsageRepository(db);
    const day = Date.UTC(2026, 10, 1);
    const base = {
      sessionId: 'session',
      scope: 'request' as const,
      model: null,
      effort: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    usage.record({
      ...base,
      turnId: 'old',
      cellId: 'c1',
      requestId: null,
      costUsd: 2,
      createdAt: day + 60_000,
    });
    usage.record({
      ...base,
      turnId: 'new',
      cellId: 'c1',
      requestId: null,
      costUsd: 3,
      createdAt: day + 86_400_000 + 60_000,
    });

    new UsageRollups(db).rollupThrough(day + 86_400_000);
    db.prepare('DELETE FROM usage_events WHERE created_at < ?').run(day + 86_400_000);

    expect(usage.totals({ from: day, to: day + 2 * 86_400_000 })).toMatchObject({
      turns: 2,
      costUsd: 5,
      unknownCostTurns: 0,
    });
    expect(usage.totals({ from: day, to: day + 2 * 86_400_000, cellId: 'c1' })).toMatchObject({
      turns: 2,
      costUsd: 5,
    });
    db.close();
  });
});

describe('budget email helpers', () => {
  function alert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
    return {
      id: 'alert-1',
      scope: 'overall',
      cellId: null,
      cellName: null,
      threshold: 'warning',
      alertAtPercent: 80,
      budgetUsd: 100,
      spendUsd: 85,
      unknownCostTurns: 0,
      periodStart: PERIOD.start,
      createdAt: NOW,
      acknowledgedAt: null,
      ...overrides,
    };
  }

  it('builds a subject for overall, cell, exceeded, and test alerts', () => {
    expect(budgetAlertSubject(alert())).toBe('[APS] Overall budget warning (80%)');
    expect(
      budgetAlertSubject(alert({ scope: 'cell', cellId: 'c1', cellName: 'Research' })),
    ).toBe('[APS] Research budget warning (80%)');
    expect(
      budgetAlertSubject(alert({ threshold: 'exceeded', spendUsd: 120 })),
    ).toBe('[APS] Overall over budget ($100.00)');
    expect(budgetAlertSubject(alert(), 'budget.test')).toBe('[APS] Test budget alert');
  });

  it('writes the alert sentence, UTC period, and id into the body', () => {
    const body = budgetEmailText(alert());
    expect(body).toContain(budgetAlertText(alert()));
    expect(body).toContain('2026-11-01T00:00:00.000Z to 2026-12-01T00:00:00.000Z (UTC)');
    expect(body).toContain('Alert: alert-1');
    expect(budgetEmailText(alert(), 'budget.test')).toMatch(/^This is a test budget alert/);
  });

  it('keeps lower-bound copy in the email body', () => {
    const lower = alert({ unknownCostTurns: 2 });
    expect(budgetEmailText(lower)).toContain(budgetAlertText(lower));
    expect(budgetEmailText(lower)).toContain('at least $85.00');
  });

  it('validates from addresses with and without a display name', () => {
    expect(emailAddressError('ops@example.com')).toBeNull();
    expect(emailAddressError('APS Alerts <alerts@example.com>')).toBeNull();
    expect(emailAddressError('user@localhost')).toBeNull();
    expect(emailAddressError('')).toBe('is required');
    expect(emailAddressError('not-an-address')).toBe('must be a valid email address');
    expect(emailAddressError('<alerts@example.com>')).toBe(
      'must include a display name before the address',
    );
    expect(emailAddressError(`name <${'a'.repeat(400)}@example.com>`)).toBe(
      'must be at most 320 characters',
    );
  });

  it('validates unique plain recipients capped at ten', () => {
    expect(emailRecipientsError(['ops@example.com'])).toBeNull();
    expect(emailRecipientsError([])).toBe('at least one recipient is required');
    expect(emailRecipientsError(['Ops@example.com', 'ops@example.com'])).toBe(
      'recipients must be unique',
    );
    expect(emailRecipientsError(['APS <ops@example.com>'])).toBe(
      'recipients must be plain email addresses',
    );
    const many = Array.from({ length: 11 }, (_value, index) => `u${index}@example.com`);
    expect(emailRecipientsError(many)).toBe('must have at most 10 recipients');
  });

  it('validates SMTP hosts and recognizes loopback relays', () => {
    expect(smtpHostError('smtp.example.com')).toBeNull();
    expect(smtpHostError('127.0.0.1')).toBeNull();
    expect(smtpHostError('')).toBe('is required');
    expect(smtpHostError('smtp example.com')).toBe('must be a hostname or IP address');
    expect(smtpHostError('user@example.com')).toBe('must be a hostname or IP address');
    expect(isLoopbackSmtpHost('localhost')).toBe(true);
    expect(isLoopbackSmtpHost('[::1]')).toBe(true);
    expect(isLoopbackSmtpHost('localhost.example.com')).toBe(false);
  });

  it('treats email as configured only with host, from, and a recipient', () => {
    const base: EmailSettings = {
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: null,
      password: null,
      from: 'alerts@example.com',
      to: ['ops@example.com'],
    };
    expect(emailDeliveryConfigured(base)).toBe(true);
    expect(emailDeliveryConfigured({ ...base, host: null })).toBe(false);
    expect(emailDeliveryConfigured({ ...base, from: null })).toBe(false);
    expect(emailDeliveryConfigured({ ...base, to: [] })).toBe(false);
  });

  it('allows resend only for active failed or skipped deliveries', () => {
    const base = {
      status: 'failed' as const,
      acknowledgedAt: null,
      periodStart: PERIOD.start,
      currentPeriodStart: PERIOD.start,
      channelEnabled: true,
      channelConfigured: true,
    };

    expect(resendBlockReason(base)).toBeNull();
    expect(resendBlockReason({ ...base, status: 'skipped' })).toBeNull();
    expect(resendBlockReason({ ...base, status: 'delivered' })).toBe('already_delivered');
    expect(resendBlockReason({ ...base, status: 'pending' })).toBe('in_flight');
    expect(resendBlockReason({ ...base, status: 'delivering' })).toBe('in_flight');
    expect(resendBlockReason({ ...base, acknowledgedAt: NOW })).toBe('alert_acknowledged');
    expect(resendBlockReason({ ...base, periodStart: PERIOD.start - 1 })).toBe(
      'not_current_period',
    );
    expect(resendBlockReason({ ...base, channelEnabled: false })).toBe('channel_disabled');
    expect(resendBlockReason({ ...base, channelConfigured: false })).toBe(
      'channel_unconfigured',
    );
  });
});
