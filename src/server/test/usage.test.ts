import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CellRepository } from '../src/cells/repository.js';
import { openDb, type Db } from '../src/db.js';
import { PricingRepository } from '../src/pricing/repository.js';
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
  pricing: PricingRepository;
  cells: CellRepository;
  requests: RequestRepository;
} {
  db = openDb(':memory:');
  return {
    db,
    usage: new UsageRepository(db),
    pricing: new PricingRepository(db),
    cells: new CellRepository(db),
    requests: new RequestRepository(db),
  };
}

function price(model: string, effectiveFrom: number, inputUsdPerMtok = 1) {
  return {
    model,
    effectiveFrom,
    inputUsdPerMtok,
    outputUsdPerMtok: 2,
    cacheReadUsdPerMtok: 0.5,
    cacheWriteUsdPerMtok: 3,
    reasoningUsdPerMtok: 4,
    source: 'test',
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

  it('estimates only unreported turns and leaves unmatched models unpriced', () => {
    const h = setup();
    h.pricing.create(price('model-a', BASE));
    h.usage.record(
      event({
        model: 'model-a',
        costUsd: 0.25,
        createdAt: BASE,
      }),
    );
    h.usage.record(
      event({
        turnId: randomUUID(),
        model: 'model-a',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        createdAt: BASE + 1,
      }),
    );
    h.usage.record(
      event({
        turnId: randomUUID(),
        model: 'model-b',
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        createdAt: BASE + 2,
      }),
    );

    const result = h.usage.query({});
    expect(result.totals).toMatchObject({
      turns: 3,
      reportedCostTurns: 1,
      estimatedCostTurns: 1,
      unpricedTurns: 1,
      unknownCostTurns: 2,
    });
    expect(result.totals.costUsd).toBeCloseTo(0.25);
    expect(result.totals.estimatedCostUsd).toBeCloseTo(1);
    expect(result.totals.totalCostUsd).toBeCloseTo(1.25);

    const modelA = result.byModel.find((row) => row.key === 'model-a');
    expect(modelA).toMatchObject({ turns: 2, estimatedCostTurns: 1, unpricedTurns: 0 });
    expect(modelA?.costUsd).toBeCloseTo(0.25);
    expect(modelA?.estimatedCostUsd).toBeCloseTo(1);
    expect(modelA?.totalCostUsd).toBeCloseTo(1.25);

    const modelB = result.byModel.find((row) => row.key === 'model-b');
    expect(modelB).toMatchObject({ turns: 1, estimatedCostTurns: 0, unpricedTurns: 1 });
    expect(modelB?.estimatedCostUsd).toBeNull();
    expect(modelB?.totalCostUsd).toBeNull();
  });

  it('applies the price effective at each turn completion time', () => {
    const h = setup();
    h.pricing.create(price('model-a', BASE, 1));
    h.pricing.create(price('model-a', BASE + 2 * HOUR, 3));
    h.pricing.create(price('model-a', BASE + 4 * HOUR, 99));

    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
    };
    h.usage.record(event({ ...tokens, createdAt: BASE + HOUR }));
    h.usage.record(event({ ...tokens, turnId: randomUUID(), createdAt: BASE + 3 * HOUR }));

    const result = h.usage.query({});
    expect(result.totals.estimatedCostUsd).toBeCloseTo(4);
    expect(result.totals.totalCostUsd).toBeCloseTo(4);
    expect(result.byModel[0]?.estimatedCostTurns).toBe(2);

    const beforeFirst = h.usage.query({ from: BASE - HOUR, to: BASE + HOUR / 2 });
    expect(beforeFirst.totals.turns).toBe(0);
    expect(beforeFirst.totals.estimatedCostUsd).toBeNull();
  });

  it('keeps a turn unpriced when only a future price exists', () => {
    const h = setup();
    h.pricing.create(price('model-a', BASE + DAY));
    h.usage.record(event({ costUsd: null, createdAt: BASE }));

    const result = h.usage.query({});
    expect(result.totals).toMatchObject({
      turns: 1,
      reportedCostTurns: 0,
      estimatedCostTurns: 0,
      unpricedTurns: 1,
      costUsd: null,
      estimatedCostUsd: null,
      totalCostUsd: null,
    });
  });

  it('recomputes historical estimates when a backdated price is added', () => {
    const h = setup();
    h.usage.record(
      event({
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        createdAt: BASE,
      }),
    );

    expect(h.usage.query({}).totals.estimatedCostUsd).toBeNull();

    h.pricing.create(price('model-a', BASE, 5));
    expect(h.usage.query({}).totals.estimatedCostUsd).toBeCloseTo(5);
    expect(h.db.prepare('SELECT cost_usd FROM usage_events').get()).toEqual({ cost_usd: null });
  });

  it('treats a zero-rate estimate as a known zero cost', () => {
    const h = setup();
    h.pricing.create({
      ...price('model-a', BASE, 0),
      outputUsdPerMtok: 0,
      cacheReadUsdPerMtok: 0,
      cacheWriteUsdPerMtok: 0,
      reasoningUsdPerMtok: 0,
    });
    h.usage.record(event({ costUsd: null, createdAt: BASE }));

    const result = h.usage.query({});
    expect(result.totals).toMatchObject({
      turns: 1,
      reportedCostTurns: 0,
      estimatedCostTurns: 1,
      unpricedTurns: 0,
      costUsd: null,
    });
    expect(result.totals.estimatedCostUsd).toBe(0);
    expect(result.totals.totalCostUsd).toBe(0);
  });

  it('includes estimates in bucket and request groups', () => {
    const h = setup();
    const request = h.requests.create({ title: 'Estimated ticket' });
    h.pricing.create(price('model-a', BASE));
    h.usage.record(
      event({
        requestId: request.id,
        sessionId: request.id,
        inputTokens: 2_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        createdAt: BASE,
      }),
    );

    const dayStart = Math.floor(BASE / DAY) * DAY;
    const result = h.usage.query({ from: dayStart, to: dayStart + DAY, bucket: 'day' });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.estimatedCostUsd).toBeCloseTo(2);
    expect(result.series[0]?.totalCostUsd).toBeCloseTo(2);
    expect(result.byRequest[0]).toMatchObject({
      key: request.id,
      label: 'Estimated ticket',
      estimatedCostTurns: 1,
      unpricedTurns: 0,
    });
    expect(result.byRequest[0]?.totalCostUsd).toBeCloseTo(2);
  });

  it('rejects a duplicate turn id', () => {
    const h = setup();
    const input = event();
    h.usage.record(input);
    expect(() => h.usage.record(input)).toThrow();
  });
});
