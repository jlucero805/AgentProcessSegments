import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { PricingRepository } from '../src/pricing/repository.js';
import { UsageRollups } from '../src/usage/rollups.js';

const DAY = 86_400_000;
const DAY0 = Date.UTC(2026, 0, 5);
const HOUR = 3_600_000;

let db: Db | null = null;

function setup(): { db: Db; rollups: UsageRollups; pricing: PricingRepository } {
  db = openDb(':memory:');
  return { db, rollups: new UsageRollups(db), pricing: new PricingRepository(db) };
}

interface Seed {
  createdAt: number;
  scope?: string;
  cellId?: string | null;
  requestId?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number | null;
}

function seed(db: Db, row: Seed): void {
  db.prepare(
    `INSERT INTO usage_events (
       id, turn_id, session_id, scope, cell_id, request_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       reasoning_tokens, cost_usd, created_at
     ) VALUES (
       @id, @id, 'session', @scope, @cellId, @requestId, @model,
       @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
       @reasoningTokens, @costUsd, @createdAt
     )`,
  ).run({
    id: randomUUID(),
    scope: row.scope ?? 'request',
    cellId: row.cellId ?? null,
    requestId: row.requestId ?? null,
    model: row.model === undefined ? 'model-a' : row.model,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
    reasoningTokens: row.reasoningTokens ?? 0,
    costUsd: row.costUsd === undefined ? 0.25 : row.costUsd,
    createdAt: row.createdAt,
  });
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

function dailyRows(db: Db): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT day_start, scope, cell_id, request_id, model, turns, input_tokens,
              reported_cost_usd, reported_cost_turns, estimated_cost_usd,
              estimated_cost_turns
         FROM usage_daily ORDER BY day_start, model, request_id, cell_id, scope`,
    )
    .all() as Array<Record<string, unknown>>;
}

afterEach(() => {
  db?.close();
  db = null;
});

describe('UsageRollups', () => {
  it('starts at zero and aggregates by UTC day and dimensions', () => {
    const h = setup();
    h.pricing.create(price('model-a', DAY0));
    seed(h.db, {
      createdAt: DAY0 + 10 * HOUR,
      cellId: 'cell-1',
      requestId: 'req-1',
      inputTokens: 1_000_000,
    });
    seed(h.db, {
      createdAt: DAY0 + 11 * HOUR,
      cellId: 'cell-1',
      requestId: 'req-1',
      inputTokens: 2_000_000,
      costUsd: null,
    });
    seed(h.db, {
      createdAt: DAY0 + 12 * HOUR,
      cellId: null,
      requestId: null,
      model: null,
      inputTokens: 7,
      costUsd: null,
    });
    seed(h.db, { createdAt: DAY0 + DAY + HOUR, model: 'model-b', costUsd: 0.5 });

    expect(h.rollups.watermark()).toBe(0);
    const result = h.rollups.rollupThrough(DAY0 + 2 * DAY);

    expect(result).toEqual({
      from: DAY0,
      to: DAY0 + 2 * DAY,
      rows: 3,
      done: true,
    });
    expect(h.rollups.watermark()).toBe(DAY0 + 2 * DAY);
    expect(dailyRows(h.db)).toEqual([
      {
        day_start: DAY0,
        scope: 'request',
        cell_id: '',
        request_id: '',
        model: '',
        turns: 1,
        input_tokens: 7,
        reported_cost_usd: null,
        reported_cost_turns: 0,
        estimated_cost_usd: null,
        estimated_cost_turns: 0,
      },
      {
        day_start: DAY0,
        scope: 'request',
        cell_id: 'cell-1',
        request_id: 'req-1',
        model: 'model-a',
        turns: 2,
        input_tokens: 3_000_000,
        reported_cost_usd: 0.25,
        reported_cost_turns: 1,
        estimated_cost_usd: 2,
        estimated_cost_turns: 1,
      },
      {
        day_start: DAY0 + DAY,
        scope: 'request',
        cell_id: '',
        request_id: '',
        model: 'model-b',
        turns: 1,
        input_tokens: 0,
        reported_cost_usd: 0.5,
        reported_cost_turns: 1,
        estimated_cost_usd: null,
        estimated_cost_turns: 0,
      },
    ]);
    // Raw rows stay until retention explicitly deletes them.
    expect(
      (h.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number })
        .count,
    ).toBe(4);
  });

  it('is idempotent and extends only new days', () => {
    const h = setup();
    seed(h.db, { createdAt: DAY0 + HOUR });
    const first = h.rollups.rollupThrough(DAY0 + DAY);
    expect(first.rows).toBe(1);

    const again = h.rollups.rollupThrough(DAY0 + DAY);
    expect(again).toEqual({ from: DAY0 + DAY, to: DAY0 + DAY, rows: 0, done: true });
    expect(h.rollups.watermark()).toBe(DAY0 + DAY);
    expect(dailyRows(h.db)).toHaveLength(1);

    seed(h.db, { createdAt: DAY0 + DAY + HOUR, model: 'model-b' });
    const extended = h.rollups.rollupThrough(DAY0 + 2 * DAY);
    expect(extended).toEqual({
      from: DAY0 + DAY,
      to: DAY0 + 2 * DAY,
      rows: 1,
      done: true,
    });
    expect(h.rollups.watermark()).toBe(DAY0 + 2 * DAY);
    expect(dailyRows(h.db)).toHaveLength(2);
  });

  it('never starts at epoch 0 when the first raw row is recent', () => {
    const h = setup();
    seed(h.db, { createdAt: DAY0 + 10 * HOUR });
    const result = h.rollups.rollupThrough(DAY0 + 100 * DAY, { maxDays: 5 });

    expect(result.from).toBe(DAY0);
    expect(result.to).toBe(DAY0 + 5 * DAY);
    expect(result.done).toBe(false);
    expect(dailyRows(h.db)).toHaveLength(1);
  });

  it('drains in bounded chunks with gaps and returns done', () => {
    const h = setup();
    seed(h.db, { createdAt: DAY0 + HOUR });
    seed(h.db, { createdAt: DAY0 + 20 * DAY + HOUR, model: 'model-b' });

    const first = h.rollups.rollupThrough(DAY0 + 30 * DAY, { maxDays: 7 });
    expect(first).toMatchObject({ from: DAY0, to: DAY0 + 7 * DAY, done: false });
    expect(h.rollups.watermark()).toBe(DAY0 + 7 * DAY);

    let chunk = first;
    while (!chunk.done) {
      chunk = h.rollups.rollupThrough(DAY0 + 30 * DAY, { maxDays: 7 });
    }
    expect(chunk.to).toBe(DAY0 + 30 * DAY);
    expect(h.rollups.watermark()).toBe(DAY0 + 30 * DAY);
    expect(dailyRows(h.db).map((row) => row['day_start'])).toEqual([
      DAY0,
      DAY0 + 20 * DAY,
    ]);
  });

  it('does not move the watermark when no raw row is old enough', () => {
    const h = setup();
    seed(h.db, { createdAt: DAY0 + 10 * DAY + HOUR });
    const result = h.rollups.rollupThrough(DAY0 + 5 * DAY);

    expect(result).toEqual({ from: 0, to: 0, rows: 0, done: true });
    expect(h.rollups.watermark()).toBe(0);
    expect(dailyRows(h.db)).toEqual([]);
  });

  it('is a no-op when the usage ledger does not exist', () => {
    const h = setup();
    h.db.exec('DROP TABLE usage_events');
    const result = h.rollups.rollupThrough(DAY0 + DAY);

    expect(result).toEqual({ from: 0, to: 0, rows: 0, done: true });
    expect(h.rollups.watermark()).toBe(0);
  });

  it('rejects a boundary that is not UTC-day aligned', () => {
    const h = setup();
    expect(() => h.rollups.rollupThrough(DAY0 + HOUR)).toThrow(/day aligned/);
  });
});
