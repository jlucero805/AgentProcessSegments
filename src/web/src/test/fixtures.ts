import type { MasterConfig, ModelPrice, Request, UsageResponse, UsageTotals } from '../types';
import { defaultProcess } from '../../../server/src/process/defaults';

const fixtureMaster: MasterConfig = {
  enabled: true,
  intervalMinutes: 5,
  idleMinutes: 10,
  autoReview: true,
  prompt: 'prod prompt',
};

export function makeRequest(overrides: Partial<Request> = {}): Request {
  const now = Date.now();
  return {
    id: 'req-1',
    title: 'A request',
    body: '',
    state: 'clarify',
    groomed: false,
    clarifyStarted: false,
    model: null,
    effort: null,
    targetRepo: null,
    acceptanceCriteria: null,
    context: null,
    skills: [],
    kbDigest: true,
    digest: null,
    agentStatus: 'none',
    unchecked: false,
    hcRunIds: [],
    branch: null,
    crUrl: null,
    cellId: null,
    harness: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeProcess() {
  return defaultProcess(fixtureMaster);
}

export function makeProcessResponse() {
  return { ...makeProcess(), path: '/tmp/agent-process-segments/process.json' };
}

export function makeUsageTotals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    turns: 2,
    inputTokens: 120,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 2,
    totalTokens: 177,
    costUsd: 0.012,
    estimatedCostUsd: 0.004,
    totalCostUsd: 0.016,
    reportedCostTurns: 1,
    estimatedCostTurns: 1,
    unpricedTurns: 0,
    unknownCostTurns: 1,
    ...overrides,
  };
}

export function makePrice(overrides: Partial<ModelPrice> = {}): ModelPrice {
  return {
    id: 'price-1',
    model: 'model-a',
    effectiveFrom: Date.UTC(2026, 0, 1),
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cacheReadUsdPerMtok: 0.3,
    cacheWriteUsdPerMtok: 3.75,
    reasoningUsdPerMtok: 15,
    source: 'https://example.com/pricing',
    note: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

export function makeUsageResponse(overrides: Partial<UsageResponse> = {}): UsageResponse {
  return {
    range: { from: null, to: null },
    totals: makeUsageTotals(),
    coverage: { rolledThrough: null },
    series: [
      {
        bucketStart: 1,
        ...makeUsageTotals({
          turns: 1,
          costUsd: 0.01,
          estimatedCostUsd: null,
          totalCostUsd: 0.01,
          reportedCostTurns: 1,
          estimatedCostTurns: 0,
          unpricedTurns: 0,
          unknownCostTurns: 0,
        }),
      },
      {
        bucketStart: 2,
        ...makeUsageTotals({
          turns: 1,
          costUsd: null,
          estimatedCostUsd: 0.004,
          totalCostUsd: 0.004,
          reportedCostTurns: 0,
          estimatedCostTurns: 1,
          unpricedTurns: 0,
          unknownCostTurns: 1,
        }),
      },
    ],
    byModel: [
      {
        key: 'model-a',
        label: 'Model A',
        ...makeUsageTotals({
          turns: 1,
          costUsd: 0.012,
          estimatedCostUsd: null,
          totalCostUsd: 0.012,
          reportedCostTurns: 1,
          estimatedCostTurns: 0,
          unpricedTurns: 0,
          unknownCostTurns: 0,
        }),
      },
      {
        key: 'model-b',
        label: 'Model B',
        ...makeUsageTotals({
          turns: 1,
          costUsd: null,
          estimatedCostUsd: 0.004,
          totalCostUsd: 0.004,
          reportedCostTurns: 0,
          estimatedCostTurns: 1,
          unpricedTurns: 0,
          unknownCostTurns: 1,
        }),
      },
    ],
    byCell: [
      { key: 'cell-1', label: 'Alpha', ...makeUsageTotals() },
    ],
    byRequest: [
      { key: 'req-1', label: 'A request', cellId: 'cell-1', cellLabel: 'Alpha', ...makeUsageTotals() },
    ],
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

export function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (key: string, value: string) => store.set(key, value),
    getData: (key: string) => store.get(key) ?? '',
    dropEffect: 'move',
    effectAllowed: 'move',
    setDragImage: () => {},
    types: [],
    files: [],
    items: [],
    clearData: () => store.clear(),
  } as unknown as DataTransfer;
}
