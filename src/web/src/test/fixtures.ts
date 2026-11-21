import type { MasterConfig, Request } from '../types';
import { defaultProcess } from '../../../server/src/process/defaults';

const fixtureMaster: MasterConfig = {
  enabled: true,
  intervalMinutes: 5,
  idleMinutes: 10,
  autoReview: true,
  includeUnassigned: true,
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
  return { ...makeProcess(), path: '/tmp/sandbox-harness/process.json' };
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
