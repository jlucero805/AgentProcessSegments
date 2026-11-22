import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb } from '../src/db.js';
import {
  budgetPeriod,
  type BudgetUsageReader,
  type BudgetUsageTotals,
} from '../src/domain/budget.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { SettingsStore } from '../src/settings.js';
import { BudgetAlertRepository } from '../src/usage/budget-alerts.js';
import { createBudgetUsageReader } from '../src/usage/budget-usage.js';
import { BudgetService } from '../src/usage/budgets.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const PERIOD = budgetPeriod(NOW);

function emptyTotals(): BudgetUsageTotals {
  return { turns: 0, costUsd: null, unknownCostTurns: 0 };
}

class FakeReader implements BudgetUsageReader {
  availableValue = true;
  overall: BudgetUsageTotals = emptyTotals();
  cells = new Map<string, BudgetUsageTotals>();
  throwOnTotals = false;

  available(): boolean {
    return this.availableValue;
  }

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
  reader: FakeReader,
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
    usage: reader,
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

  it('reports overall and cell statuses with known and unknown spend', () => {
    const reader = new FakeReader();
    const { service, cells, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    const cell = cells.create('Alpha');
    cells.setMonthlyBudget(cell.id, 50);
    reader.overall = { turns: 4, costUsd: 85, unknownCostTurns: 1 };
    reader.cells.set(cell.id, { turns: 2, costUsd: 10, unknownCostTurns: 0 });

    const response = service.statuses(NOW);

    expect(response.usageAvailable).toBe(true);
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
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    reader.overall = { turns: 2, costUsd: null, unknownCostTurns: 2 };

    const status = service.statuses(NOW).statuses[0];
    expect(status?.state).toBe('unknown');
    expect(status?.spendUsd).toBe(0);
    expect(status?.spendIsLowerBound).toBe(true);

    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);
  });

  it('creates an idempotent warning and keeps lower-bound metadata', () => {
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    reader.overall = { turns: 3, costUsd: 85, unknownCostTurns: 1 };

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
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    reader.overall = { turns: 1, costUsd: 80, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts[0]?.threshold).toBe('warning');

    reader.overall = { turns: 1, costUsd: 100, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const alerts = service.statuses(NOW).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ threshold: 'exceeded', spendUsd: 100 });
  });

  it('never warns when alertAtPercent is 100', () => {
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 100 } });
    reader.overall = { turns: 1, costUsd: 99, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);

    reader.overall = { turns: 1, costUsd: 100, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts[0]?.threshold).toBe('exceeded');
  });

  it('acknowledges an alert, keeps history, and silences the same generation', () => {
    const reader = new FakeReader();
    const { service, alerts, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    reader.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
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
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    reader.overall = { turns: 1, costUsd: 120, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const exceeded = service.statuses(NOW).alerts[0]!;
    service.acknowledge(exceeded.id);

    reader.overall = { turns: 1, costUsd: 85, unknownCostTurns: 0 };
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);
  });

  it('starts a new alert generation when the budget or threshold changes', () => {
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    reader.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const first = service.statuses(NOW).alerts[0]!;
    service.acknowledge(first.id);

    settings.patch({ budget: { monthlyUsd: 200, alertAtPercent: 80 } });
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts).toEqual([]);

    reader.overall = { turns: 1, costUsd: 210, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const second = service.statuses(NOW).alerts[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.budgetUsd).toBe(200);

    settings.patch({ budget: { alertAtPercent: 90 } });
    service.evaluate(NOW);
    expect(service.statuses(NOW).alerts[0]?.alertAtPercent).toBe(90);
  });

  it('removes unacknowledged alerts when a budget is cleared or a cell is deleted', () => {
    const reader = new FakeReader();
    const { service, cells, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    const cell = cells.create('Alpha');
    cells.setMonthlyBudget(cell.id, 50);
    reader.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    reader.cells.set(cell.id, { turns: 1, costUsd: 60, unknownCostTurns: 0 });
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
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });
    reader.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
    service.evaluate(NOW);
    const first = service.statuses(NOW).alerts[0]!;

    const nextMonth = Date.UTC(2026, 11, 2, 12);
    service.evaluate(nextMonth);
    const next = service.statuses(nextMonth).alerts[0]!;
    expect(next.periodStart).toBe(Date.UTC(2026, 11, 1));
    expect(next.id).not.toBe(first.id);
  });

  it('reports evaluation failures without throwing', () => {
    const reader = new FakeReader();
    reader.throwOnTotals = true;
    const errors: ErrorSink = { error: vi.fn() };
    const { service, settings } = makeService(reader, makeStore(), errors);
    settings.patch({ budget: { monthlyUsd: 100, alertAtPercent: 80 } });

    expect(() => service.evaluate(NOW)).not.toThrow();
    expect(errors.error).toHaveBeenCalledWith(
      'usage.budgets',
      expect.any(Error),
      expect.objectContaining({ periodStart: PERIOD.start }),
    );
  });

  it('starts, reacts to settings changes, and stops idempotently', () => {
    const reader = new FakeReader();
    const { service, settings } = makeService(reader);
    reader.overall = { turns: 1, costUsd: 90, unknownCostTurns: 0 };
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

describe('budget usage reader', () => {
  it('returns no data when the usage ledger is absent', () => {
    const db = openDb(':memory:');
    const reader = createBudgetUsageReader(db);
    expect(reader.available()).toBe(false);
    expect(reader.totals({ from: 0, to: 1 })).toEqual({
      turns: 0,
      costUsd: null,
      unknownCostTurns: 0,
    });
    db.close();
  });

  it('aggregates known and unknown cost from usage_events', () => {
    const db = openDb(':memory:');
    db.exec(`CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      cell_id TEXT,
      cost_usd REAL,
      created_at INTEGER NOT NULL
    )`);
    const insert = db.prepare(
      'INSERT INTO usage_events (id, cell_id, cost_usd, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('1', 'c1', 1.5, 10);
    insert.run('2', 'c1', null, 11);
    insert.run('3', 'c2', 2, 12);
    insert.run('4', 'c1', 3, 20);

    const reader = createBudgetUsageReader(db);
    expect(reader.available()).toBe(true);
    expect(reader.totals({ from: 10, to: 20 })).toEqual({
      turns: 3,
      costUsd: 3.5,
      unknownCostTurns: 1,
    });
    expect(reader.totals({ from: 10, to: 13, cellId: 'c1' })).toEqual({
      turns: 2,
      costUsd: 1.5,
      unknownCostTurns: 1,
    });
    db.close();
  });
});
