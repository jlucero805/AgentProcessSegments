import { describe, expect, it, vi } from 'vitest';
import type { SpendPause } from '../src/domain/budget.js';
import { SpendCapEnforcer } from '../src/usage/spend-cap-enforcer.js';

function pause(overrides: Partial<SpendPause> = {}): SpendPause {
  return {
    scope: 'overall',
    cellId: null,
    cellName: null,
    label: 'Overall',
    reason: 'cap_reached',
    periodStart: Date.UTC(2026, 10, 1),
    periodEnd: Date.UTC(2026, 11, 1),
    budgetUsd: 100,
    spendUsd: 100,
    spendIsLowerBound: false,
    unpricedTurns: 0,
    percentUsed: 100,
    ...overrides,
  };
}

interface Live {
  id: string;
  cellId: string | null;
  scope: 'request' | 'master' | 'summary' | 'kb' | 'setup';
}

function setup(live: Live[], admission: (cellId: string | null) => SpendPause | null) {
  const turns = new Map(live.map((turn) => [turn.id, turn]));
  const order: Array<string> = [];
  const cancelled: Array<{ id: string; pause: SpendPause }> = [];
  const engine = {
    liveTurns: vi.fn(() => [...turns.values()].map(({ id, cellId }) => ({ id, cellId }))),
    cancelForSpendCap: vi.fn((id: string, value: SpendPause) => {
      if (!turns.has(id)) return false;
      turns.delete(id);
      order.push(id);
      cancelled.push({ id, pause: value });
      return true;
    }),
  };
  const errors = { error: vi.fn() };
  const enforcer = new SpendCapEnforcer({
    engine,
    admission: vi.fn(admission),
    errors,
  });
  return { engine, enforcer, errors, cancelled, order, turns };
}

describe('SpendCapEnforcer', () => {
  it('stops every live turn when the overall cap is paused', () => {
    const fixture = setup(
      [
        { id: 'request', cellId: null, scope: 'request' },
        { id: 'cell-a', cellId: 'cell-a', scope: 'request' },
        { id: 'cell-b', cellId: 'cell-b', scope: 'master' },
        { id: 'summary', cellId: 'cell-a', scope: 'summary' },
        { id: 'kb', cellId: null, scope: 'kb' },
        { id: 'setup', cellId: null, scope: 'setup' },
      ],
      () => pause(),
    );

    fixture.enforcer.check();

    expect(fixture.order).toEqual(['request', 'cell-a', 'cell-b', 'summary', 'kb', 'setup']);
    expect(fixture.cancelled.every((entry) => entry.pause.scope === 'overall')).toBe(true);
  });

  it('stops only the paused cell and reads the ledger once per scope', () => {
    const cellPause = pause({
      scope: 'cell',
      cellId: 'cell-a',
      cellName: 'Alpha',
      label: 'Alpha',
    });
    const fixture = setup(
      [
        { id: 'a-request', cellId: 'cell-a', scope: 'request' },
        { id: 'a-master', cellId: 'cell-a', scope: 'master' },
        { id: 'a-summary', cellId: 'cell-a', scope: 'summary' },
        { id: 'b-request', cellId: 'cell-b', scope: 'request' },
        { id: 'kb', cellId: null, scope: 'kb' },
      ],
      (cellId) => (cellId === 'cell-a' ? cellPause : null),
    );

    fixture.enforcer.check();

    expect(fixture.order).toEqual(['a-request', 'a-master', 'a-summary']);
    expect(fixture.cancelled.every((entry) => entry.pause.cellId === 'cell-a')).toBe(true);
    expect(fixture.engine.liveTurns).toHaveBeenCalledTimes(1);
    expect(fixture.errors.error).not.toHaveBeenCalled();
  });

  it('forwards an unknown-cost pause unchanged', () => {
    const strict = pause({
      scope: 'cell',
      cellId: 'cell-a',
      cellName: 'Alpha',
      label: 'Alpha',
      reason: 'unknown_cost',
      budgetUsd: 100,
      spendUsd: 5,
      spendIsLowerBound: true,
      unpricedTurns: 2,
      percentUsed: 5,
    });
    const fixture = setup(
      [{ id: 'a-request', cellId: 'cell-a', scope: 'request' }],
      (cellId) => (cellId === 'cell-a' ? strict : null),
    );

    fixture.enforcer.check();

    expect(fixture.cancelled).toEqual([{ id: 'a-request', pause: strict }]);
    expect(fixture.errors.error).not.toHaveBeenCalled();
  });

  it('does nothing without live turns and does not cancel twice', () => {
    const fixture = setup([], () => pause());

    fixture.enforcer.check();
    expect(fixture.engine.liveTurns).toHaveBeenCalledTimes(1);
    expect(fixture.engine.cancelForSpendCap).not.toHaveBeenCalled();

    const live = setup([{ id: 'one', cellId: null, scope: 'request' }], () => pause());
    live.enforcer.check();
    live.enforcer.check();
    expect(live.engine.cancelForSpendCap).toHaveBeenCalledTimes(1);
  });

  it('fails open when admission throws', () => {
    const fixture = setup(
      [
        { id: 'a', cellId: 'cell-a', scope: 'request' },
        { id: 'b', cellId: 'cell-b', scope: 'request' },
      ],
      () => {
        throw new Error('ledger unavailable');
      },
    );

    expect(() => fixture.enforcer.check()).not.toThrow();
    expect(fixture.engine.cancelForSpendCap).not.toHaveBeenCalled();
  });

  it('reports one failure per turn and keeps stopping the rest', () => {
    const fixture = setup(
      [
        { id: 'broken', cellId: null, scope: 'request' },
        { id: 'healthy', cellId: null, scope: 'request' },
      ],
      () => pause(),
    );
    fixture.engine.cancelForSpendCap.mockImplementation((id: string) => {
      if (id === 'broken') throw new Error('kill failed');
      fixture.cancelled.push({ id, pause: pause() });
      return true;
    });

    fixture.enforcer.check();

    expect(fixture.errors.error).toHaveBeenCalledWith(
      'budget.enforce',
      expect.any(Error),
      { session: 'broken', scope: 'overall' },
    );
    expect(fixture.cancelled.map((entry) => entry.id)).toEqual(['healthy']);
  });

  it('terminates when a stopped turn records usage and re-enters the check', () => {
    let enforcer: SpendCapEnforcer | null = null;
    let live: Live[] = [
      { id: 'first', cellId: null, scope: 'request' },
      { id: 'second', cellId: null, scope: 'request' },
    ];
    const canceled: string[] = [];
    enforcer = new SpendCapEnforcer({
      engine: {
        liveTurns: () => live.map(({ id, cellId }) => ({ id, cellId })),
        cancelForSpendCap: (id: string) => {
          canceled.push(id);
          live = live.filter((turn) => turn.id !== id);
          enforcer?.check();
          return true;
        },
      },
      admission: () => pause(),
    });

    expect(() => enforcer?.check()).not.toThrow();
    expect(canceled).toEqual(['first', 'second']);
  });
});
