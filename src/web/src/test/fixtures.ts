import type { MasterConfig, Request, UsageResponse, UsageTotals } from '../types';
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
    unknownCostTurns: 1,
    ...overrides,
  };
}

export function makeUsageResponse(overrides: Partial<UsageResponse> = {}): UsageResponse {
  return {
    range: { from: null, to: null },
    totals: makeUsageTotals(),
    series: [
      { bucketStart: 1, ...makeUsageTotals({ turns: 1, costUsd: 0.01, unknownCostTurns: 0 }) },
      { bucketStart: 2, ...makeUsageTotals({ turns: 1, costUsd: null, unknownCostTurns: 1 }) },
    ],
    byModel: [
      { key: 'model-a', label: 'Model A', ...makeUsageTotals({ turns: 1, costUsd: 0.012, unknownCostTurns: 0 }) },
      { key: 'model-b', label: 'Model B', ...makeUsageTotals({ turns: 1, costUsd: null, unknownCostTurns: 1 }) },
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
