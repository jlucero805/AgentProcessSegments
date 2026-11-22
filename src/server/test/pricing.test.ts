import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { PriceConflictError, PricingRepository } from '../src/pricing/repository.js';
import { estimateCostUsd, type ModelPriceInput } from '../src/pricing/types.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1);

let db: Db | null = null;

function setup(): PricingRepository {
  db = openDb(':memory:');
  return new PricingRepository(db);
}

function price(overrides: Partial<ModelPriceInput> = {}): ModelPriceInput {
  return {
    model: 'model-a',
    effectiveFrom: BASE,
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cacheReadUsdPerMtok: 0.3,
    cacheWriteUsdPerMtok: 3.75,
    reasoningUsdPerMtok: 15,
    source: 'https://example.com/pricing',
    note: null,
    ...overrides,
  };
}

afterEach(() => {
  db?.close();
  db = null;
});

describe('pricing repository', () => {
  it('creates, lists, and removes effective-dated rows', () => {
    const pricing = setup();
    const older = pricing.create(
      price({ model: ' model-a ', source: ' docs/pricing ', note: '  list price  ' }),
    );
    const newer = pricing.create(price({ model: 'model-a', effectiveFrom: BASE + DAY }));
    const other = pricing.create(price({ model: 'model-b', effectiveFrom: BASE + 2 * DAY }));

    expect(older.model).toBe('model-a');
    expect(older.source).toBe('docs/pricing');
    expect(older.note).toBe('list price');
    expect(other.model).toBe('model-b');
    expect(pricing.list().map((row) => row.id)).toEqual([newer.id, older.id, other.id]);

    expect(pricing.remove(newer.id)).toBe(true);
    expect(pricing.remove(newer.id)).toBe(false);
    expect(pricing.list().map((row) => row.id)).toEqual([older.id, other.id]);
  });

  it('rejects a duplicate model and effective date', () => {
    const pricing = setup();
    pricing.create(price());
    expect(() => pricing.create(price({ source: 'another source' }))).toThrow(PriceConflictError);
    expect(pricing.list()).toHaveLength(1);
  });

  it('selects the newest price at or before the timestamp', () => {
    const pricing = setup();
    pricing.create(price({ effectiveFrom: BASE, inputUsdPerMtok: 1 }));
    pricing.create(price({ effectiveFrom: BASE + DAY, inputUsdPerMtok: 2 }));
    pricing.create(price({ effectiveFrom: BASE + 2 * DAY, inputUsdPerMtok: 3 }));

    expect(pricing.getEffective('model-a', BASE - 1)).toBeNull();
    expect(pricing.getEffective('model-a', BASE)?.inputUsdPerMtok).toBe(1);
    expect(pricing.getEffective('model-a', BASE + DAY - 1)?.inputUsdPerMtok).toBe(1);
    expect(pricing.getEffective('model-a', BASE + DAY)?.inputUsdPerMtok).toBe(2);
    expect(pricing.getEffective('model-a', BASE + 3 * DAY)?.inputUsdPerMtok).toBe(3);
    expect(pricing.getEffective('missing', BASE + 3 * DAY)).toBeNull();
  });

  it('estimates every token category from per-million rates', () => {
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    };
    expect(
      estimateCostUsd(tokens, {
        inputUsdPerMtok: 1,
        outputUsdPerMtok: 2,
        cacheReadUsdPerMtok: 3,
        cacheWriteUsdPerMtok: 4,
        reasoningUsdPerMtok: 5,
      }),
    ).toBeCloseTo(15);

    expect(
      estimateCostUsd(
        { ...tokens, inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        {
          inputUsdPerMtok: 1,
          outputUsdPerMtok: 2,
          cacheReadUsdPerMtok: 3,
          cacheWriteUsdPerMtok: 4,
          reasoningUsdPerMtok: 5,
        },
      ),
    ).toBeCloseTo(0.5);

    expect(
      estimateCostUsd(tokens, {
        inputUsdPerMtok: 0,
        outputUsdPerMtok: 0,
        cacheReadUsdPerMtok: 0,
        cacheWriteUsdPerMtok: 0,
        reasoningUsdPerMtok: 0,
      }),
    ).toBe(0);
  });
});
