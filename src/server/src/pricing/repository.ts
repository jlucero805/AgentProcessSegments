import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { ModelPrice, ModelPriceInput } from './types.js';

interface PriceRow {
  id: string;
  model: string;
  effective_from: number;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_read_usd_per_mtok: number;
  cache_write_usd_per_mtok: number;
  reasoning_usd_per_mtok: number;
  source: string;
  note: string | null;
  created_at: number;
}

const SELECT = `
  SELECT id, model, effective_from, input_usd_per_mtok, output_usd_per_mtok,
         cache_read_usd_per_mtok, cache_write_usd_per_mtok, reasoning_usd_per_mtok,
         source, note, created_at
    FROM model_pricing
`;

function price(row: PriceRow): ModelPrice {
  return {
    id: row.id,
    model: row.model,
    effectiveFrom: Number(row.effective_from),
    inputUsdPerMtok: Number(row.input_usd_per_mtok),
    outputUsdPerMtok: Number(row.output_usd_per_mtok),
    cacheReadUsdPerMtok: Number(row.cache_read_usd_per_mtok),
    cacheWriteUsdPerMtok: Number(row.cache_write_usd_per_mtok),
    reasoningUsdPerMtok: Number(row.reasoning_usd_per_mtok),
    source: row.source,
    note: row.note,
    createdAt: Number(row.created_at),
  };
}

/** A duplicate model/effective-date pair would make historical estimates ambiguous. */
export class PriceConflictError extends Error {
  constructor(model: string, effectiveFrom: number) {
    super(`a price already exists for ${model} at ${new Date(effectiveFrom).toISOString()}`);
    this.name = 'PriceConflictError';
  }
}

/**
 * Owns every pricing query. The HTTP boundary validates the input; this class
 * trusts its arguments. Effective dates are append-only: a correction is a new
 * row with a new effective date, and remove() is only for an entry entered by
 * mistake.
 */
export class PricingRepository {
  constructor(private readonly db: Db) {}

  list(): ModelPrice[] {
    const rows = this.db
      .prepare(`${SELECT} ORDER BY model ASC, effective_from DESC, created_at DESC`)
      .all() as PriceRow[];
    return rows.map(price);
  }

  create(input: ModelPriceInput): ModelPrice {
    const model = input.model.trim();
    const source = input.source.trim();
    const note = input.note?.trim() ?? null;
    const existing = this.db
      .prepare('SELECT id FROM model_pricing WHERE model = ? AND effective_from = ?')
      .get(model, input.effectiveFrom) as { id: string } | undefined;
    if (existing) throw new PriceConflictError(model, input.effectiveFrom);

    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO model_pricing (
           id, model, effective_from, input_usd_per_mtok, output_usd_per_mtok,
           cache_read_usd_per_mtok, cache_write_usd_per_mtok, reasoning_usd_per_mtok,
           source, note, created_at
         ) VALUES (
           @id, @model, @effectiveFrom, @inputUsdPerMtok, @outputUsdPerMtok,
           @cacheReadUsdPerMtok, @cacheWriteUsdPerMtok, @reasoningUsdPerMtok,
           @source, @note, @createdAt
         )`,
      )
      .run({
        id,
        model,
        effectiveFrom: input.effectiveFrom,
        inputUsdPerMtok: input.inputUsdPerMtok,
        outputUsdPerMtok: input.outputUsdPerMtok,
        cacheReadUsdPerMtok: input.cacheReadUsdPerMtok,
        cacheWriteUsdPerMtok: input.cacheWriteUsdPerMtok,
        reasoningUsdPerMtok: input.reasoningUsdPerMtok,
        source,
        note,
        createdAt,
      });

    return {
      id,
      model,
      effectiveFrom: input.effectiveFrom,
      inputUsdPerMtok: input.inputUsdPerMtok,
      outputUsdPerMtok: input.outputUsdPerMtok,
      cacheReadUsdPerMtok: input.cacheReadUsdPerMtok,
      cacheWriteUsdPerMtok: input.cacheWriteUsdPerMtok,
      reasoningUsdPerMtok: input.reasoningUsdPerMtok,
      source,
      note,
      createdAt,
    };
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM model_pricing WHERE id = ?').run(id).changes > 0;
  }

  /** The newest row at or before `at`, mirroring the estimator's SQL join. */
  getEffective(model: string, at: number): ModelPrice | null {
    const row = this.db
      .prepare(
        `${SELECT}
          WHERE model = ? AND effective_from <= ?
          ORDER BY effective_from DESC
          LIMIT 1`,
      )
      .get(model, at) as PriceRow | undefined;
    return row ? price(row) : null;
  }
}
