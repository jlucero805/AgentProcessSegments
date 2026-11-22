import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb, type Db } from '../src/db.js';
import { RequestRepository } from '../src/requests/repository.js';
import { UsageRepository } from '../src/usage/repository.js';
import type { UsageEventInput } from '../src/usage/types.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 0, 1, 10, 0, 0);

let db: Db | null = null;

function setup(): {
  db: Db;
  usage: UsageRepository;
  cells: CellRepository;
  requests: RequestRepository;
} {
  db = openDb(':memory:');
  return {
    db,
    usage: new UsageRepository(db),
    cells: new CellRepository(db),
    requests: new RequestRepository(db),
  };
}

function event(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    turnId: randomUUID(),
    sessionId: 'req-1',
    scope: 'request',
    cellId: null,
    requestId: null,
    model: 'model-a',
    effort: 'medium',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 2,
    costUsd: 0.25,
    createdAt: BASE,
    ...overrides,
  };
}

afterEach(() => {
  db?.close();
  db = null;
});

describe('usage repository', () => {
  it('aggregates totals and groups with partial known cost', () => {
    const h = setup();
    const cell = h.cells.create('Alpha');
    const other = h.cells.create('Beta');
    const request = h.requests.create({ title: 'First ticket', cellId: cell.id });
    const second = h.requests.create({ title: 'Second ticket', cellId: other.id });

    h.usage.record(
      event({
        sessionId: request.id,
        requestId: request.id,
        cellId: cell.id,
        model: 'model-a',
        createdAt: BASE,
      }),
    );
    h.usage.record(
      event({
        turnId: randomUUID(),
        sessionId: request.id,
        requestId: request.id,
        cellId: cell.id,
        model: 'model-b',
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        createdAt: BASE + HOUR,
      }),
    );
    h.usage.record(
      event({
        turnId: randomUUID(),
        sessionId: second.id,
        requestId: second.id,
        cellId: other.id,
        model: 'model-a',
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.5,
        createdAt: BASE + DAY,
      }),
    );
    h.usage.record(
      event({
        turnId: randomUUID(),
        sessionId: `__master__:${cell.id}`,
        scope: 'master',
        requestId: null,
        cellId: cell.id,
        model: 'model-a',
        inputTokens: 5,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.1,
        createdAt: BASE + 2 * DAY,
      }),
    );

    const result = h.usage.query({});
    expect(result.range).toEqual({ from: null, to: null });
    expect(result.totals.turns).toBe(4);
    expect(result.totals.totalTokens).toBe(100 + 50 + 10 + 5 + 2 + 20 + 10 + 200 + 100 + 5 + 5);
    expect(result.totals.costUsd).toBeCloseTo(0.85);
    expect(result.totals.unknownCostTurns).toBe(1);

    expect(result.byModel.map((row) => row.key).sort()).toEqual(['model-a', 'model-b']);
    const modelB = result.byModel.find((row) => row.key === 'model-b');
    expect(modelB?.costUsd).toBeNull();
    expect(modelB?.unknownCostTurns).toBe(1);

    const alpha = result.byCell.find((row) => row.key === cell.id);
    expect(alpha?.label).toBe('Alpha');
    expect(alpha?.turns).toBe(3);
    expect(alpha?.unknownCostTurns).toBe(1);

    expect(result.byRequest.map((row) => row.label).sort()).toEqual([
      'First ticket',
      'Second ticket',
    ]);
    expect(result.byRequest.find((row) => row.key === request.id)).toMatchObject({
      turns: 2,
      cellId: cell.id,
      cellLabel: 'Alpha',
    });
  });

  it('filters by cell, request, and time window', () => {
    const h = setup();
    const cell = h.cells.create('Alpha');
    const request = h.requests.create({ title: 'Windowed', cellId: cell.id });

    h.usage.record(event({ requestId: request.id, cellId: cell.id, createdAt: BASE }));
    h.usage.record(
      event({
        turnId: randomUUID(),
        requestId: request.id,
        cellId: cell.id,
        createdAt: BASE + 2 * HOUR,
        inputTokens: 7,
        outputTokens: 3,
      }),
    );
    h.usage.record(
      event({
        turnId: randomUUID(),
        requestId: null,
        cellId: null,
        scope: 'kb',
        sessionId: '__kb__',
        createdAt: BASE + 3 * HOUR,
      }),
    );

    const byCell = h.usage.query({ cellId: cell.id });
    expect(byCell.totals.turns).toBe(2);
    const byRequest = h.usage.query({ requestId: request.id });
    expect(byRequest.totals.turns).toBe(2);
    const windowed = h.usage.query({ from: BASE + HOUR, to: BASE + 4 * HOUR });
    expect(windowed.totals.turns).toBe(2);
    expect(windowed.totals.inputTokens).toBe(7 + 100);
    const unknownCell = h.usage.query({ cellId: 'missing' });
    expect(unknownCell.totals.turns).toBe(0);
    expect(unknownCell.series).toEqual([]);
  });

  it('zero-fills UTC buckets when both bounds are supplied', () => {
    const h = setup();
    h.usage.record(event({ createdAt: BASE }));
    h.usage.record(event({ turnId: randomUUID(), createdAt: BASE + 2 * HOUR }));

    const hourly = h.usage.query({ from: BASE, to: BASE + 3 * HOUR, bucket: 'hour' });
    expect(hourly.series.map((row) => row.bucketStart)).toEqual([
      BASE,
      BASE + HOUR,
      BASE + 2 * HOUR,
    ]);
    expect(hourly.series.map((row) => row.turns)).toEqual([1, 0, 1]);

    const daily = h.usage.query({ from: BASE, to: BASE + DAY, bucket: 'day' });
    const dayStart = Math.floor(BASE / DAY) * DAY;
    expect(daily.series.map((row) => row.bucketStart)).toEqual([dayStart, dayStart + DAY]);
    expect(daily.series.map((row) => row.turns)).toEqual([2, 0]);
  });

  it('applies the breakdown limit without touching totals or series', () => {
    const h = setup();
    for (let index = 0; index < 5; index += 1) {
      h.usage.record(
        event({
          turnId: randomUUID(),
          model: `model-${index}`,
          inputTokens: (index + 1) * 10,
          createdAt: BASE + index,
        }),
      );
    }

    const result = h.usage.query({ limit: 2, from: BASE, to: BASE + DAY });
    expect(result.totals.turns).toBe(5);
    expect(result.series).toHaveLength(2);
    expect(result.byModel).toHaveLength(2);
    expect(result.byModel.map((row) => row.key)).toEqual(['model-4', 'model-3']);
  });

  it('rejects a duplicate turn id', () => {
    const h = setup();
    const input = event();
    h.usage.record(input);
    expect(() => h.usage.record(input)).toThrow();
  });
});
