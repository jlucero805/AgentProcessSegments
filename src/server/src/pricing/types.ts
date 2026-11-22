/**
 * Pure pricing contract shared by the brain and the SPA. Keep this module free
 * of Node imports so Vite can bundle it through `src/web/src/types.ts`.
 */

/** Prices are quoted in USD per this many tokens. */
export const PRICE_TOKEN_BASIS = 1_000_000;

export interface PriceableTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface ModelPriceInput {
  model: string;
  /** Epoch ms. The price applies to turns completed at or after this instant. */
  effectiveFrom: number;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
  cacheWriteUsdPerMtok: number;
  reasoningUsdPerMtok: number;
  source: string;
  note?: string | null;
}

export interface ModelPrice extends Omit<ModelPriceInput, 'note'> {
  id: string;
  note: string | null;
  createdAt: number;
}

export interface ModelPricesResponse {
  prices: ModelPrice[];
}

function rate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Estimated USD for one usage sample. Callers must decide whether the harness
 * reported a cost; this helper never decides precedence and never rounds.
 */
export function estimateCostUsd(
  tokens: PriceableTokens,
  price: Pick<
    ModelPriceInput,
    | 'inputUsdPerMtok'
    | 'outputUsdPerMtok'
    | 'cacheReadUsdPerMtok'
    | 'cacheWriteUsdPerMtok'
    | 'reasoningUsdPerMtok'
  >,
): number {
  return (
    (tokens.inputTokens * rate(price.inputUsdPerMtok) +
      tokens.outputTokens * rate(price.outputUsdPerMtok) +
      tokens.cacheReadTokens * rate(price.cacheReadUsdPerMtok) +
      tokens.cacheWriteTokens * rate(price.cacheWriteUsdPerMtok) +
      tokens.reasoningTokens * rate(price.reasoningUsdPerMtok)) /
    PRICE_TOKEN_BASIS
  );
}
